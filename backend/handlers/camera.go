package handlers

import (
	"net/http"
	"time"

	"github.com/dim/sentry/backend/models"
	"github.com/dim/sentry/backend/storage"
	"github.com/dim/sentry/backend/stream"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type CameraHandler struct {
	store   *storage.JSONStore
	manager *stream.Manager
}

func NewCameraHandler(store *storage.JSONStore, manager *stream.Manager) *CameraHandler {
	return &CameraHandler{store: store, manager: manager}
}

func (h *CameraHandler) List(c *gin.Context) {
	cameras := h.store.List()
	if cameras == nil {
		cameras = []*models.Camera{}
	}

	type cameraWithStatus struct {
		*models.Camera
		Stream models.StreamStatus `json:"stream"`
	}

	result := make([]cameraWithStatus, len(cameras))
	for i, cam := range cameras {
		result[i] = cameraWithStatus{
			Camera: cam,
			Stream: h.manager.Status(cam.ID),
		}
	}
	c.JSON(http.StatusOK, result)
}

func (h *CameraHandler) Get(c *gin.Context) {
	cam, ok := h.store.Get(c.Param("id"))
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "camera not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"camera": cam,
		"stream": h.manager.Status(cam.ID),
	})
}

func (h *CameraHandler) Create(c *gin.Context) {
	var req models.CreateCameraRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	cam := &models.Camera{
		ID:            uuid.New().String(),
		Name:          req.Name,
		Location:      req.Location,
		RTSPURL:       req.RTSPURL,
		AutoReconnect: req.AutoReconnect,
		CreatedAt:     time.Now(),
	}

	if err := h.store.Create(cam); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save camera"})
		return
	}

	if req.AutoReconnect {
		if err := h.manager.Start(cam); err != nil {
			// non-fatal — camera is saved, stream will be started manually
		}
	}

	c.JSON(http.StatusCreated, gin.H{
		"camera": cam,
		"stream": h.manager.Status(cam.ID),
	})
}

func (h *CameraHandler) Update(c *gin.Context) {
	cam, ok := h.store.Get(c.Param("id"))
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "camera not found"})
		return
	}

	var req models.UpdateCameraRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if req.Name != nil {
		cam.Name = *req.Name
	}
	if req.Location != nil {
		cam.Location = *req.Location
	}
	if req.RTSPURL != nil {
		cam.RTSPURL = *req.RTSPURL
	}
	if req.AutoReconnect != nil {
		cam.AutoReconnect = *req.AutoReconnect
	}

	if err := h.store.Update(cam); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update camera"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"camera": cam,
		"stream": h.manager.Status(cam.ID),
	})
}

func (h *CameraHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	if _, ok := h.store.Get(id); !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "camera not found"})
		return
	}

	h.manager.Stop(id)

	if err := h.store.Delete(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete camera"})
		return
	}

	c.Status(http.StatusNoContent)
}
