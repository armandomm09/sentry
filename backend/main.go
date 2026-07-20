package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/dim/sentry/backend/auth"
	"github.com/dim/sentry/backend/db"
	"github.com/dim/sentry/backend/events"
	"github.com/dim/sentry/backend/face"
	"github.com/dim/sentry/backend/handlers"
	"github.com/dim/sentry/backend/push"
	"github.com/dim/sentry/backend/storage"
	"github.com/dim/sentry/backend/stream"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

func main() {
	dataDir := envOr("SENTRY_DATA_DIR", "./data")
	dbPath := envOr("SENTRY_DB_PATH", "./data/sentry.db")
	port := envOr("PORT", "8080")
	faceURL := envOr("FACE_SERVICE_URL", "http://127.0.0.1:8090")

	// SQLite database
	database, err := db.Open(dbPath)
	if err != nil {
		log.Fatalf("db init: %v", err)
	}
	defer database.Close()

	// Seed default admin if users table is empty
	if empty, err := database.IsEmpty(); err != nil {
		log.Fatalf("db check: %v", err)
	} else if empty {
		hash, _ := bcrypt.GenerateFromPassword([]byte("sentry123"), bcrypt.DefaultCost)
		if _, err := database.CreateUser("admin", string(hash), true); err != nil {
			log.Fatalf("seed admin: %v", err)
		}
		log.Println("[startup] Created default admin user: username=admin password=sentry123")
	}

	// JWT manager
	jwtMgr := auth.NewManager(auth.SecretFromEnv())

	// Camera storage (cameras.json)
	store, err := storage.NewJSONStore(dataDir)
	if err != nil {
		log.Fatalf("storage init: %v", err)
	}

	manager := stream.NewManager()
	faceClient := face.NewClient(faceURL)
	faceProxy, err := face.NewProxy(faceClient)
	if err != nil {
		log.Fatalf("face proxy init: %v", err)
	}

	// Push notification engine
	notifier := push.NewNotifier(database, store)
	notifier.Start()
	listener := push.NewListener(faceURL, notifier, store)

	// Sighting events: lifecycle messages -> SQLite events + thumbs + clips
	clipsDir := filepath.Join(dataDir, "clips")
	thumbsDir := filepath.Join(dataDir, "thumbs")
	for _, dir := range []string{clipsDir, thumbsDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	clipRetention := time.Duration(envIntOr("SENTRY_CLIP_RETENTION_HOURS", 72)) * time.Hour
	eventRetention := time.Duration(envIntOr("SENTRY_EVENT_RETENTION_DAYS", 90)) * 24 * time.Hour
	cutter := events.NewClipCutter(stream.HLSDir(), clipsDir)
	recorder := events.NewRecorder(database, thumbsDir, cutter, clipRetention)
	listener.SetLifecycleSink(recorder.OnLifecycle)
	retention := events.NewRetention(database, eventRetention)
	go retention.Start(context.Background())

	for _, cam := range store.List() {
		if cam.FaceRecognitionEnabled {
			listener.WatchCamera(cam.ID)
		}
	}

	// Auto-start streams
	manager.StartAll(store.List())

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		face.SyncFromStore(ctx, faceClient, store.List())
	}()
	go face.RunSyncLoop(context.Background(), faceClient, store, 30*time.Second)

	r := gin.Default()

	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		AllowCredentials: false,
	}))

	hlsRoot := stream.HLSDir()
	r.Static("/hls", hlsRoot)

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// Handlers
	cameraH := handlers.NewCameraHandler(store, manager, faceClient)
	cameraH.SetWatcher(listener)
	authH := handlers.NewAuthHandler(database, jwtMgr)
	userH := handlers.NewUserHandler(database)
	pushH := handlers.NewPushHandler(database)

	api := r.Group("/api")
	{
		// Public routes (no auth)
		api.POST("/auth/login", authH.Login)
		api.GET("/cameras/:id/frames", cameraH.FramesWS) // face-service needs this without auth

		// All other /api routes require auth
		authed := api.Group("")
		authed.Use(jwtMgr.RequireAuth())
		{
			authed.POST("/auth/logout", authH.Logout)

			// User management (admin only)
			adminUsers := authed.Group("/users")
			adminUsers.Use(jwtMgr.RequireAdmin())
			{
				adminUsers.GET("", userH.List)
				adminUsers.POST("", userH.Create)
				adminUsers.DELETE("/:id", userH.Delete)
			}
			// Password change — auth only (handler enforces own-user or admin)
			authed.PATCH("/users/:id/password", userH.ChangePassword)

			// Push subscriptions
			pushGroup := authed.Group("/push")
			{
				pushGroup.POST("/register", pushH.Register)
				pushGroup.GET("/subscription", pushH.Get)
				pushGroup.DELETE("/subscription", pushH.Delete)
			}

			// Cameras
			cameras := authed.Group("/cameras")
			{
				cameras.GET("", cameraH.List)
				cameras.POST("", cameraH.Create)
				cameras.GET("/:id", cameraH.Get)
				cameras.PUT("/:id", cameraH.Update)
				cameras.DELETE("/:id", cameraH.Delete)
				cameras.POST("/:id/stream/start", cameraH.StreamStart)
				cameras.POST("/:id/stream/stop", cameraH.StreamStop)
				cameras.GET("/:id/stream/status", cameraH.StreamStatus)
			}

			// Sighting events (log, thumbs, clips, unknown labeling)
			eventsH := handlers.NewEventsHandler(database, faceClient)
			eventsGroup := authed.Group("/events")
			{
				eventsGroup.GET("", eventsH.List)
				eventsGroup.GET("/:id", eventsH.Get)
				eventsGroup.GET("/:id/thumb", eventsH.Thumb)
				eventsGroup.GET("/:id/clip", eventsH.Clip)
				eventsGroup.POST("/:id/label", eventsH.Label)
			}

			authed.GET("/streams", cameraH.AllStreamStatuses)

			// Face-service detection WebSocket — proxied and auth-protected
			authed.GET("/face/cameras/:id/ws", faceProxy.CameraWS(store))

			// Face-recognition surface — proxied to Python service
			authed.Any("/persons", faceProxy.Handler())
			authed.Any("/persons/*proxyPath", faceProxy.Handler())
			authed.Any("/augmentation", faceProxy.Handler())
			authed.Any("/augmentation/*proxyPath", faceProxy.Handler())
		}
	}

	log.Printf("Sentry backend listening on :%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envIntOr(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
