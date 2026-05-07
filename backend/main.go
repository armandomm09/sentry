package main

import (
	"log"
	"net/http"
	"os"

	"github.com/dim/sentry/backend/handlers"
	"github.com/dim/sentry/backend/storage"
	"github.com/dim/sentry/backend/stream"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

func main() {
	dataDir := envOr("SENTRY_DATA_DIR", "./data")
	port := envOr("PORT", "8080")

	store, err := storage.NewJSONStore(dataDir)
	if err != nil {
		log.Fatalf("storage init: %v", err)
	}

	manager := stream.NewManager()

	// Auto-start streams for cameras with auto_reconnect=true
	manager.StartAll(store.List())

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

	h := handlers.NewCameraHandler(store, manager)

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
		}

		api.GET("/streams", h.AllStreamStatuses)
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
