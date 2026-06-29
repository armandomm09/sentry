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
	"github.com/gorilla/websocket"
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
		if err := client.EnableCamera(ctx, cam.ID); err != nil {
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

// CameraChecker is the subset of *storage.JSONStore used by CameraWS.
type CameraChecker interface {
	Get(id string) (*models.Camera, bool)
}

var faceWSUpgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 256 * 1024,
}

// CameraWS proxies the face-service per-camera detection WebSocket to the caller.
// The route must be registered behind jwtMgr.RequireAuth() — auth is not checked here.
func (p *Proxy) CameraWS(store CameraChecker) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		if _, ok := store.Get(id); !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "camera not found"})
			return
		}

		// Convert base URL from http:// → ws:// (or https: → wss:)
		base := p.client.BaseURL()
		wsBase := strings.Replace(base, "https://", "wss://", 1)
		wsBase = strings.Replace(wsBase, "http://", "ws://", 1)
		faceWS := wsBase + "/cameras/" + id + "/ws"

		upstream, _, err := websocket.DefaultDialer.Dial(faceWS, nil)
		if err != nil {
			log.Printf("[face-ws] dial %s: %v", faceWS, err)
			c.JSON(http.StatusBadGateway, gin.H{"error": "face-service unavailable"})
			return
		}
		defer upstream.Close()

		downstream, err := faceWSUpgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			// Upgrade writes its own error response.
			return
		}
		defer downstream.Close()

		done := make(chan struct{}, 2)

		// face-service → mobile
		go func() {
			defer func() { done <- struct{}{} }()
			for {
				mt, msg, err := upstream.ReadMessage()
				if err != nil {
					return
				}
				if err := downstream.WriteMessage(mt, msg); err != nil {
					return
				}
			}
		}()

		// mobile → face-service (detects client disconnect)
		go func() {
			defer func() { done <- struct{}{} }()
			for {
				if _, _, err := downstream.ReadMessage(); err != nil {
					return
				}
			}
		}()

		<-done
	}
}
