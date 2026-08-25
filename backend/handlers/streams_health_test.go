package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dim/sentry/backend/models"
	"github.com/dim/sentry/backend/storage"
	"github.com/dim/sentry/backend/stream"
	"github.com/gin-gonic/gin"
)

func setupStreamsHealth(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	store, err := storage.NewJSONStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, cam := range []*models.Camera{
		{ID: "cam1", Name: "Porton"},
		{ID: "cam2", Name: "Patio"},
	} {
		if err := store.Create(cam); err != nil {
			t.Fatal(err)
		}
	}

	h := NewCameraHandler(store, stream.NewManager(), nil)
	r := gin.New()
	r.GET("/health/streams", h.StreamsHealth)
	return r
}

type streamsHealthBody struct {
	Status  string `json:"status"`
	Cameras []struct {
		ID                  string `json:"id"`
		Name                string `json:"name"`
		Status              string `json:"status"`
		Stalled             bool   `json:"stalled"`
		LastFrameAgeSeconds *int64 `json:"last_frame_age_seconds"`
	} `json:"cameras"`
	Summary struct {
		Total   int `json:"total"`
		Live    int `json:"live"`
		Stalled int `json:"stalled"`
	} `json:"summary"`
}

func TestStreamsHealthListsEveryCamera(t *testing.T) {
	r := setupStreamsHealth(t)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health/streams", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	var body streamsHealthBody
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (body %s)", err, w.Body.String())
	}

	if body.Summary.Total != 2 || len(body.Cameras) != 2 {
		t.Fatalf("expected 2 cameras, got total=%d len=%d", body.Summary.Total, len(body.Cameras))
	}
	// No relay was ever started, so the cameras are stopped, not stalled — a
	// stopped camera must never be reported as a fault.
	if body.Status != "ok" || body.Summary.Stalled != 0 {
		t.Errorf("stopped cameras reported as degraded: %+v", body.Summary)
	}
	for _, c := range body.Cameras {
		if c.Status != "offline" {
			t.Errorf("camera %s status = %q, want offline", c.ID, c.Status)
		}
		if c.LastFrameAgeSeconds != nil {
			t.Errorf("camera %s reported a frame age with no relay running", c.ID)
		}
	}
}

// The endpoint is polled by unauthenticated healthchecks, so it must never leak
// camera credentials.
func TestStreamsHealthLeaksNoCredentials(t *testing.T) {
	gin.SetMode(gin.TestMode)

	store, err := storage.NewJSONStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	secret := "rtsp://admin:sup3rs3cret@10.0.0.9:554/Streaming/Channels/101"
	if err := store.Create(&models.Camera{
		ID: "cam1", Name: "Porton", RTSPURL: secret, SnapshotURL: secret,
	}); err != nil {
		t.Fatal(err)
	}

	h := NewCameraHandler(store, stream.NewManager(), nil)
	r := gin.New()
	r.GET("/health/streams", h.StreamsHealth)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/health/streams", nil))

	if got := w.Body.String(); strings.Contains(got, "sup3rs3cret") || strings.Contains(got, "rtsp://") {
		t.Fatalf("stream health response leaked camera URL/credentials: %s", got)
	}
}
