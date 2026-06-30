package handlers

import (
	"context"
	"log"
	"net/http"
	"time"

	"github.com/dim/sentry/backend/face"
	"github.com/dim/sentry/backend/models"
	"github.com/dim/sentry/backend/storage"
	"github.com/dim/sentry/backend/stream"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type CameraHandler struct {
	store   *storage.JSONStore
	manager *stream.Manager
	face    *face.Client
}

func NewCameraHandler(store *storage.JSONStore, manager *stream.Manager, faceClient *face.Client) *CameraHandler {
	return &CameraHandler{store: store, manager: manager, face: faceClient}
}

// syncFaceRecognition reconciles face-service's view of a camera with the stored
// flag. Errors are logged but never block the camera operation — face-rec is a
// best-effort side channel; HLS streaming and CRUD must keep working even if
// the Python service is down.
func (h *CameraHandler) syncFaceRecognition(ctx context.Context, cam *models.Camera) {
	if h.face == nil {
		return
	}
	var err error
	if cam.FaceRecognitionEnabled {
		err = h.face.EnableCamera(ctx, cam.ID)
	} else {
		err = h.face.DisableCamera(ctx, cam.ID)
	}
	if err != nil {
		log.Printf("[face] sync camera %s (enabled=%v): %v", cam.ID, cam.FaceRecognitionEnabled, err)
	}
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
		ID:                     uuid.New().String(),
		Name:                   req.Name,
		Location:               req.Location,
		RTSPURL:                req.RTSPURL,
		SnapshotURL:            req.SnapshotURL,
		AutoReconnect:          req.AutoReconnect,
		FaceRecognitionEnabled: req.FaceRecognitionEnabled,
		CreatedAt:              time.Now(),
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
	h.syncFaceRecognition(c.Request.Context(), cam)

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

	rtspChanged := false
	faceToggled := false
	if req.Name != nil {
		cam.Name = *req.Name
	}
	if req.Location != nil {
		cam.Location = *req.Location
	}
	if req.SnapshotURL != nil {
		cam.SnapshotURL = *req.SnapshotURL
	}
	if req.RTSPURL != nil && *req.RTSPURL != cam.RTSPURL {
		cam.RTSPURL = *req.RTSPURL
		rtspChanged = true
	}
	if req.AutoReconnect != nil {
		cam.AutoReconnect = *req.AutoReconnect
	}
	if req.FaceRecognitionEnabled != nil && *req.FaceRecognitionEnabled != cam.FaceRecognitionEnabled {
		cam.FaceRecognitionEnabled = *req.FaceRecognitionEnabled
		faceToggled = true
	}

	if err := h.store.Update(cam); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update camera"})
		return
	}

	// Re-sync face-service only when the face-rec toggle changes. URL changes
	// are handled entirely by the Go relay (manager.Start detects the diff and
	// recycles the relay) — the face worker always connects to the relay, not RTSP.
	if faceToggled {
		h.syncFaceRecognition(c.Request.Context(), cam)
	}
	if rtspChanged {
		// Restart the relay with the new source URL.
		_ = h.manager.Start(cam)
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
	if h.face != nil {
		if err := h.face.DisableCamera(c.Request.Context(), id); err != nil {
			log.Printf("[face] disable on delete %s: %v", id, err)
		}
	}

	if err := h.store.Delete(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete camera"})
		return
	}

	c.Status(http.StatusNoContent)
}
