package handlers

import (
	"fmt"
	"net/http"

	"github.com/dim/sentry/backend/auth"
	"github.com/dim/sentry/backend/db"
	"github.com/dim/sentry/backend/push"
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
		ExpoPushToken     string   `json:"expo_push_token" binding:"required"`
		CameraIDs         []string `json:"camera_ids"`
		NotifyKnown       *bool    `json:"notify_known"`
		NotifyUnknown     *bool    `json:"notify_unknown"`
		NotifyKnownMode   string   `json:"notify_known_mode"`
		NotifyUnknownMode string   `json:"notify_unknown_mode"`
		KnownQuietHours   float64  `json:"known_quiet_hours"`
		UnknownQuietHours float64  `json:"unknown_quiet_hours"`
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
	knownMode, err := normalizeMode(req.NotifyKnownMode)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "notify_known_mode: " + err.Error()})
		return
	}
	unknownMode, err := normalizeMode(req.NotifyUnknownMode)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "notify_unknown_mode: " + err.Error()})
		return
	}
	knownQuiet, err := normalizeQuietHours(req.KnownQuietHours)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "known_quiet_hours: " + err.Error()})
		return
	}
	unknownQuiet, err := normalizeQuietHours(req.UnknownQuietHours)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown_quiet_hours: " + err.Error()})
		return
	}
	sub := &db.PushSubscription{
		UserID:            claims.UserID,
		ExpoPushToken:     req.ExpoPushToken,
		CameraIDs:         cameraIDs,
		NotifyKnown:       notifyKnown,
		NotifyUnknown:     notifyUnknown,
		NotifyKnownMode:   knownMode,
		NotifyUnknownMode: unknownMode,
		KnownQuietHours:   knownQuiet,
		UnknownQuietHours: unknownQuiet,
	}
	if err := h.db.UpsertPushSubscription(sub); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	c.JSON(http.StatusOK, sub)
}

// normalizeMode maps "" to the default and rejects unrecognized modes.
func normalizeMode(m string) (string, error) {
	if m == "" {
		return push.ModeEvery, nil
	}
	if !push.ValidMode(m) {
		return "", fmt.Errorf("must be one of every, quiet_period, first_of_day")
	}
	return m, nil
}

// normalizeQuietHours maps 0 (omitted) to the 4h default and rejects negatives.
func normalizeQuietHours(h float64) (float64, error) {
	if h < 0 {
		return 0, fmt.Errorf("must be >= 0")
	}
	if h == 0 {
		return 4, nil
	}
	return h, nil
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
