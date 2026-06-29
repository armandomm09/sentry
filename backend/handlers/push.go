package handlers

import (
	"net/http"

	"github.com/dim/sentry/backend/auth"
	"github.com/dim/sentry/backend/db"
	"github.com/gin-gonic/gin"
)

type PushHandler struct {
	db *db.DB
}

func NewPushHandler(database *db.DB) *PushHandler {
	return &PushHandler{db: database}
}

func (h *PushHandler) Register(c *gin.Context) {
	claims := c.MustGet(auth.CtxClaims).(*auth.Claims)
	var req struct {
		ExpoPushToken string   `json:"expo_push_token" binding:"required"`
		CameraIDs     []string `json:"camera_ids"`
		NotifyKnown   *bool    `json:"notify_known"`
		NotifyUnknown *bool    `json:"notify_unknown"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cameraIDs := req.CameraIDs
	if cameraIDs == nil {
		cameraIDs = []string{}
	}
	notifyKnown := true
	if req.NotifyKnown != nil {
		notifyKnown = *req.NotifyKnown
	}
	notifyUnknown := true
	if req.NotifyUnknown != nil {
		notifyUnknown = *req.NotifyUnknown
	}
	sub := &db.PushSubscription{
		UserID:        claims.UserID,
		ExpoPushToken: req.ExpoPushToken,
		CameraIDs:     cameraIDs,
		NotifyKnown:   notifyKnown,
		NotifyUnknown: notifyUnknown,
	}
	if err := h.db.UpsertPushSubscription(sub); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	c.JSON(http.StatusOK, sub)
}

func (h *PushHandler) Get(c *gin.Context) {
	claims := c.MustGet(auth.CtxClaims).(*auth.Claims)
	sub, found, err := h.db.GetPushSubscription(claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "no subscription"})
		return
	}
	c.JSON(http.StatusOK, sub)
}

func (h *PushHandler) Delete(c *gin.Context) {
	claims := c.MustGet(auth.CtxClaims).(*auth.Claims)
	if err := h.db.DeletePushSubscription(claims.UserID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	c.Status(http.StatusNoContent)
}
