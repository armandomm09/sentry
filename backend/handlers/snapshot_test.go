package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dim/sentry/backend/models"
	"github.com/dim/sentry/backend/storage"
	"github.com/gin-gonic/gin"
)

// setupSnapshot builds a router with a single camera whose snapshot_url is
// whatever the test needs (usually an httptest server standing in for the
// camera on the private network).
func setupSnapshot(t *testing.T, snapshotURL string) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	store, err := storage.NewJSONStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Create(&models.Camera{ID: "cam1", Name: "Front", SnapshotURL: snapshotURL}); err != nil {
		t.Fatal(err)
	}

	h := &CameraHandler{store: store}
	r := gin.New()
	r.GET("/api/cameras/:id/snapshot", h.Snapshot)
	return r
}

func doSnapshot(r *gin.Engine, id string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/cameras/"+id+"/snapshot", nil))
	return w
}

func TestSnapshotRelaysCameraJPEG(t *testing.T) {
	body := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10}
	cam := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write(body)
	}))
	defer cam.Close()

	w := doSnapshot(setupSnapshot(t, cam.URL+"/ISAPI/Streaming/channels/101/picture"), "cam1")

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if got := w.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Errorf("Content-Type = %q, want image/jpeg", got)
	}
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	if got := w.Body.Bytes(); string(got) != string(body) {
		t.Errorf("body = %v, want %v", got, body)
	}
}

func TestSnapshotDefaultsContentTypeToJPEG(t *testing.T) {
	cam := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header()["Content-Type"] = nil // camera sends no Content-Type
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte{0xFF, 0xD8})
	}))
	defer cam.Close()

	w := doSnapshot(setupSnapshot(t, cam.URL), "cam1")

	if got := w.Header().Get("Content-Type"); got != "image/jpeg" {
		t.Errorf("Content-Type = %q, want image/jpeg", got)
	}
}

func TestSnapshotUnknownCamera(t *testing.T) {
	if w := doSnapshot(setupSnapshot(t, "http://example.invalid"), "nope"); w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

func TestSnapshotCameraWithoutURL(t *testing.T) {
	if w := doSnapshot(setupSnapshot(t, "   "), "cam1"); w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

func TestSnapshotRejectsNonHTTPScheme(t *testing.T) {
	if w := doSnapshot(setupSnapshot(t, "rtsp://10.0.0.5/stream"), "cam1"); w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestSnapshotUpstreamUnreachable(t *testing.T) {
	cam := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := cam.URL
	cam.Close() // nothing listening now

	if w := doSnapshot(setupSnapshot(t, url), "cam1"); w.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", w.Code)
	}
}

func TestSnapshotUpstreamError(t *testing.T) {
	cam := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer cam.Close()

	if w := doSnapshot(setupSnapshot(t, cam.URL), "cam1"); w.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", w.Code)
	}
}
