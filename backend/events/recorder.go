package events

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/dim/sentry/backend/db"
	"github.com/google/uuid"
)

// Cutter abstracts the ClipCutter so the recorder is testable without ffmpeg.
type Cutter interface {
	Start(eventID, cameraID string, done func(clipPath string, err error))
	Stop(eventID string)
}

// Recorder persists face-service track lifecycle messages as sighting events.
type Recorder struct {
	db            *db.DB
	thumbsDir     string
	cutter        Cutter
	clipRetention time.Duration
	nowFn         func() time.Time
}

func NewRecorder(database *db.DB, thumbsDir string, cutter Cutter, clipRetention time.Duration) *Recorder {
	return &Recorder{
		db:            database,
		thumbsDir:     thumbsDir,
		cutter:        cutter,
		clipRetention: clipRetention,
		nowFn:         time.Now,
	}
}

type lifecycleMsg struct {
	Type        string   `json:"type"`
	CameraID    string   `json:"camera_id"`
	TrackKey    string   `json:"track_key"`
	TS          float64  `json:"ts"`
	StartedTS   float64  `json:"started_ts"`
	EndedTS     float64  `json:"ended_ts"`
	PersonID    *string  `json:"person_id"`
	Name        *string  `json:"name"`
	Similarity  *float64 `json:"similarity"`
	CropJPEG    *string  `json:"crop_jpeg_b64"`
	EmbeddingB4 *string  `json:"embedding_b64"`
}

// OnLifecycle handles one raw WS message. Non-lifecycle and malformed messages
// are ignored. Safe for concurrent use (SQLite serializes writes).
func (r *Recorder) OnLifecycle(raw []byte) {
	var m lifecycleMsg
	if err := json.Unmarshal(raw, &m); err != nil || m.TrackKey == "" {
		return
	}
	switch m.Type {
	case "track_confirmed":
		r.onConfirmed(&m)
	case "track_updated":
		r.onUpdated(&m)
	case "track_ended":
		r.onEnded(&m)
	}
}

func (r *Recorder) onConfirmed(m *lifecycleMsg) {
	e := &db.Event{
		ID:         uuid.New().String(),
		CameraID:   m.CameraID,
		TrackKey:   m.TrackKey,
		PersonID:   deref(m.PersonID),
		PersonName: deref(m.Name),
		Similarity: derefF(m.Similarity),
		StartedAt:  toMs(m.TS),
	}
	e.ThumbPath = r.writeThumb(e.ID, m.CropJPEG)
	created, err := r.db.CreateEvent(e)
	if err != nil {
		log.Printf("[events] create %s: %v", m.TrackKey, err)
		return
	}
	if !created {
		// Duplicate delivery (reconnect replay): drop the thumb we just wrote
		// for the discarded uuid so it doesn't sit orphaned on disk.
		if e.ThumbPath != "" {
			os.Remove(e.ThumbPath)
		}
		return
	}
	eventID := e.ID
	r.cutter.Start(eventID, e.CameraID, func(clipPath string, err error) {
		if err != nil {
			log.Printf("[events] clip for %s: %v", eventID, err)
			return
		}
		expires := r.nowFn().Add(r.clipRetention).UnixMilli()
		if err := r.db.SetEventClip(eventID, clipPath, expires); err != nil {
			log.Printf("[events] persist clip for %s: %v", eventID, err)
		}
	})
}

func (r *Recorder) onUpdated(m *lifecycleMsg) {
	ev, ok, err := r.db.GetEventByTrackKey(m.TrackKey)
	if err != nil || !ok || m.PersonID == nil {
		return
	}
	if err := r.db.UpdateEventIdentity(ev.ID, *m.PersonID, deref(m.Name), derefF(m.Similarity)); err != nil {
		log.Printf("[events] update identity %s: %v", ev.ID, err)
	}
}

func (r *Recorder) onEnded(m *lifecycleMsg) {
	ev, ok, err := r.db.GetEventByTrackKey(m.TrackKey)
	if err != nil || !ok {
		return // track never confirmed — nothing to close
	}
	thumb := r.writeThumb(ev.ID, m.CropJPEG) // final best crop may be better
	var embedding []byte
	if deref(m.PersonID) == "" && m.EmbeddingB4 != nil {
		if b, err := base64.StdEncoding.DecodeString(*m.EmbeddingB4); err == nil {
			embedding = b
		}
	}
	if err := r.db.CloseEvent(ev.ID, toMs(m.EndedTS), thumb, embedding); err != nil {
		log.Printf("[events] close %s: %v", ev.ID, err)
	}
	r.cutter.Stop(ev.ID)
}

// writeThumb decodes and stores the crop; returns the path or "".
func (r *Recorder) writeThumb(eventID string, cropB64 *string) string {
	if cropB64 == nil || *cropB64 == "" {
		return ""
	}
	data, err := base64.StdEncoding.DecodeString(*cropB64)
	if err != nil {
		return ""
	}
	path := filepath.Join(r.thumbsDir, eventID+".jpg")
	if err := os.WriteFile(path, data, 0644); err != nil {
		log.Printf("[events] thumb %s: %v", eventID, err)
		return ""
	}
	return path
}

func toMs(ts float64) int64 { return int64(ts * 1000) }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefF(f *float64) float64 {
	if f == nil {
		return 0
	}
	return *f
}
