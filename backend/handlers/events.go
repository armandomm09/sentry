package handlers

import (
	"context"
	"encoding/binary"
	"math"
	"net/http"
	"os"
	"strconv"

	"github.com/dim/sentry/backend/db"
	"github.com/gin-gonic/gin"
)

// retroLabelThreshold: unknown events whose embedding cosine-matches the newly
// labeled event at or above this are auto-labeled too (spec: acquire threshold).
const retroLabelThreshold = 0.45

// FaceEnroller is the slice of the face-service client the labeling flow needs.
type FaceEnroller interface {
	CreatePerson(ctx context.Context, name string) (string, error)
	UploadPhoto(ctx context.Context, personID string, jpeg []byte, filename string) error
}

type EventsHandler struct {
	db   *db.DB
	face FaceEnroller
}

func NewEventsHandler(database *db.DB, face FaceEnroller) *EventsHandler {
	return &EventsHandler{db: database, face: face}
}

func eventJSON(e *db.Event) gin.H {
	h := gin.H{
		"id":                e.ID,
		"camera_id":         e.CameraID,
		"person_id":         nilIfEmpty(e.PersonID),
		"person_name":       e.PersonName,
		"similarity":        e.Similarity,
		"started_at":        e.StartedAt,
		"ended_at":          e.EndedAt,
		"labeled_person_id": nilIfEmpty(e.LabeledPersonID),
		"has_thumb":         e.ThumbPath != "",
		"has_clip":          e.ClipPath != "" && !e.ClipExpired,
		"clip_expired":      e.ClipExpired,
		"thumb_url":         nil,
		"clip_url":          nil,
	}
	if e.ThumbPath != "" {
		h["thumb_url"] = "/api/events/" + e.ID + "/thumb"
	}
	if e.ClipPath != "" && !e.ClipExpired {
		h["clip_url"] = "/api/events/" + e.ID + "/clip"
	}
	return h
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// List handles GET /api/events?camera_id&person_id&unknown=1&from&to&limit&before
func (h *EventsHandler) List(c *gin.Context) {
	f := db.EventFilter{
		CameraID: c.Query("camera_id"),
		PersonID: c.Query("person_id"),
	}
	f.UnknownOnly = c.Query("unknown") == "1" || c.Query("unknown") == "true"
	f.From, _ = strconv.ParseInt(c.Query("from"), 10, 64)
	f.To, _ = strconv.ParseInt(c.Query("to"), 10, 64)
	f.Before, _ = strconv.ParseInt(c.Query("before"), 10, 64)
	limit, _ := strconv.Atoi(c.Query("limit"))
	f.Limit = limit

	events, err := h.db.ListEvents(f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(events))
	for _, e := range events {
		out = append(out, eventJSON(e))
	}
	// A full page means there may be more: hand back a cursor. Mirrors the
	// clamping ListEvents applies (default 50, max 200).
	pageSize := f.Limit
	if pageSize <= 0 {
		pageSize = 50
	}
	if pageSize > 200 {
		pageSize = 200
	}
	var nextBefore any
	if len(events) == pageSize {
		nextBefore = events[len(events)-1].StartedAt
	}
	c.JSON(http.StatusOK, gin.H{"events": out, "next_before": nextBefore})
}

func (h *EventsHandler) Get(c *gin.Context) {
	ev, ok, err := h.db.GetEvent(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "event not found"})
		return
	}
	c.JSON(http.StatusOK, eventJSON(ev))
}

func (h *EventsHandler) Thumb(c *gin.Context) {
	ev, ok, err := h.db.GetEvent(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !ok || ev.ThumbPath == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "no thumbnail"})
		return
	}
	if _, err := os.Stat(ev.ThumbPath); err != nil {
		c.JSON(http.StatusGone, gin.H{"error": "thumbnail file missing"})
		return
	}
	c.Header("Content-Type", "image/jpeg")
	c.File(ev.ThumbPath)
}

func (h *EventsHandler) Clip(c *gin.Context) {
	ev, ok, err := h.db.GetEvent(c.Param("id"))
	if err != nil || !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "event not found"})
		return
	}
	if ev.ClipExpired {
		c.JSON(http.StatusGone, gin.H{"error": "clip expired (retention window passed)"})
		return
	}
	if ev.ClipPath == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "no clip for this event"})
		return
	}
	if _, err := os.Stat(ev.ClipPath); err != nil {
		c.JSON(http.StatusGone, gin.H{"error": "clip file missing"})
		return
	}
	c.Header("Content-Type", "video/mp4")
	c.File(ev.ClipPath)
}

// Label handles POST /api/events/:id/label with {"person_id"} or {"new_person_name"}.
// The event's best face crop is enrolled as a recognition photo for the person,
// and other unknown events with a matching embedding are retro-labeled.
func (h *EventsHandler) Label(c *gin.Context) {
	ev, ok, err := h.db.GetEvent(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "event not found"})
		return
	}
	if ev.PersonID != "" || ev.LabeledPersonID != "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "event is not unknown"})
		return
	}
	if ev.ThumbPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "event has no face crop to enroll"})
		return
	}

	var req struct {
		PersonID      string `json:"person_id"`
		NewPersonName string `json:"new_person_name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || (req.PersonID == "" && req.NewPersonName == "") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "person_id or new_person_name required"})
		return
	}
	if req.PersonID != "" && req.NewPersonName != "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "provide person_id or new_person_name, not both"})
		return
	}

	jpeg, err := os.ReadFile(ev.ThumbPath)
	if err != nil {
		c.JSON(http.StatusGone, gin.H{"error": "face crop file missing"})
		return
	}

	pid := req.PersonID
	if pid == "" {
		pid, err = h.face.CreatePerson(c.Request.Context(), req.NewPersonName)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
	}
	if err := h.face.UploadPhoto(c.Request.Context(), pid, jpeg, "event-"+ev.ID+".jpg"); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if err := h.db.LabelEvent(ev.ID, pid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	retro := 0
	if len(ev.Embedding) > 0 {
		unknowns, err := h.db.ListUnknownWithEmbeddings()
		if err == nil {
			for _, u := range unknowns {
				if u.ID == ev.ID {
					continue
				}
				if cosineSim(ev.Embedding, u.Embedding) >= retroLabelThreshold {
					if h.db.LabelEvent(u.ID, pid) == nil {
						retro++
					}
				}
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"labeled_person_id": pid, "retro_labeled": retro})
}

// cosineSim computes cosine similarity between two little-endian float32 blobs.
// Returns -1 for malformed/mismatched inputs.
func cosineSim(a, b []byte) float64 {
	if len(a) == 0 || len(a) != len(b) || len(a)%4 != 0 {
		return -1
	}
	var dot, na, nb float64
	for i := 0; i < len(a); i += 4 {
		x := float64(math.Float32frombits(binary.LittleEndian.Uint32(a[i:])))
		y := float64(math.Float32frombits(binary.LittleEndian.Uint32(b[i:])))
		dot += x * y
		na += x * x
		nb += y * y
	}
	if na == 0 || nb == 0 {
		return -1
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}
