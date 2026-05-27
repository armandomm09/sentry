package face

import (
	"context"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/dim/sentry/backend/models"
	"github.com/gin-gonic/gin"
)

// Proxy wraps a Client with a reverse-proxy handler the Gin router can mount.
type Proxy struct {
	client *Client
	rp     *httputil.ReverseProxy
}

// NewProxy builds a reverse proxy targeting face-service's base URL. Paths are
// rewritten so /api/persons/* hits the face-service /persons/* surface.
func NewProxy(client *Client) (*Proxy, error) {
	target, err := url.Parse(client.BaseURL())
	if err != nil {
		return nil, err
	}
	rp := httputil.NewSingleHostReverseProxy(target)
	// Default director sets Host to the target — but for path rewriting we layer
	// on our own director on top.
	originalDirector := rp.Director
	rp.Director = func(req *http.Request) {
		originalDirector(req)
		// Strip the /api prefix so /api/persons -> /persons
		req.URL.Path = strings.TrimPrefix(req.URL.Path, "/api")
		req.URL.RawPath = strings.TrimPrefix(req.URL.RawPath, "/api")
		req.Host = target.Host
	}
	rp.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		log.Printf("[face-proxy] upstream error: %v", err)
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"error":"face-service unreachable"}`))
	}
	return &Proxy{client: client, rp: rp}, nil
}

// Handler returns a gin.HandlerFunc that proxies the request as-is.
func (p *Proxy) Handler() gin.HandlerFunc {
	return func(c *gin.Context) {
		p.rp.ServeHTTP(c.Writer, c.Request)
	}
}

// SyncFromStore is called once at startup: for every camera with face_recognition
// enabled, ask face-service to start its worker. Errors are logged but not fatal —
// the face-service may not be reachable yet (race on dev boot).
func SyncFromStore(ctx context.Context, client *Client, cameras []*models.Camera) {
	for _, cam := range cameras {
		if !cam.FaceRecognitionEnabled {
			continue
		}
		if err := client.EnableCamera(ctx, cam.ID, cam.RTSPURL); err != nil {
			log.Printf("[face-proxy] sync enable %s: %v", cam.ID, err)
		}
	}
}

// CameraLister is the slice of *storage.JSONStore we actually rely on. Defined
// here to avoid pulling storage into this package.
type CameraLister interface {
	List() []*models.Camera
}

// RunSyncLoop reconciles face-service worker state with the camera store on a
// fixed interval. EnableCamera is idempotent on the face-service side — a worker
// already running with the same URL is a no-op — so it's safe to call every tick.
// This makes the pipeline self-healing if face-service restarts after the Go
// backend has been up for a while (worker state is in-memory only in Python).
func RunSyncLoop(ctx context.Context, client *Client, store CameraLister, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			SyncFromStore(rctx, client, store.List())
			cancel()
		}
	}
}
