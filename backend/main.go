package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/dim/sentry/backend/face"
	"github.com/dim/sentry/backend/handlers"
	"github.com/dim/sentry/backend/storage"
	"github.com/dim/sentry/backend/stream"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

func main() {
	dataDir := envOr("SENTRY_DATA_DIR", "./data")
	port := envOr("PORT", "8080")
	faceURL := envOr("FACE_SERVICE_URL", "http://127.0.0.1:8090")

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

	// Auto-start streams for cameras with auto_reconnect=true
	manager.StartAll(store.List())

	// Best-effort sync of face-rec workers. Runs in a goroutine so a slow
	// face-service can't delay the HTTP server coming up. We also run a
	// periodic reconciler so the pipeline self-heals if face-service is
	// restarted while the Go backend is up — its worker pool is in-memory only.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		face.SyncFromStore(ctx, faceClient, store.List())
	}()
	go face.RunSyncLoop(context.Background(), faceClient, store, 30*time.Second)

	r := gin.Default()

	// CORS — allow all origins in dev; tighten for production
	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		AllowCredentials: false,
	}))

	// Serve HLS segments from /hls/:camera_id/*
	hlsRoot := stream.HLSDir()
	r.Static("/hls", hlsRoot)

	// Health
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	h := handlers.NewCameraHandler(store, manager, faceClient)

	api := r.Group("/api")
	{
		cameras := api.Group("/cameras")
		{
			cameras.GET("", h.List)
			cameras.POST("", h.Create)
			cameras.GET("/:id", h.Get)
			cameras.PUT("/:id", h.Update)
			cameras.DELETE("/:id", h.Delete)

			cameras.POST("/:id/stream/start", h.StreamStart)
			cameras.POST("/:id/stream/stop", h.StreamStop)
			cameras.GET("/:id/stream/status", h.StreamStatus)
			// WebSocket endpoint: streams JPEG frames to subscribers (e.g. face-service).
			cameras.GET("/:id/frames", h.FramesWS)
		}

		api.GET("/streams", h.AllStreamStatuses)

		// Face-recognition surface: reverse-proxied to the Python service.
		// The proxy strips /api so /api/persons/* -> face-service /persons/*.
		api.Any("/persons", faceProxy.Handler())
		api.Any("/persons/*proxyPath", faceProxy.Handler())
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
