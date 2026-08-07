package handlers

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// snapshotTimeout bounds a single upstream camera fetch. Cameras on a flaky
// LAN can hang the connection open, and the client is refreshing on an
// interval — a slow snapshot is worth less than a fast failure.
const snapshotTimeout = 5 * time.Second

// snapshotMaxBytes caps what we relay from the camera. A JPEG still from a 4K
// sensor is well under this; anything larger is a misconfigured URL pointing at
// something that is not a snapshot endpoint.
const snapshotMaxBytes = 8 << 20 // 8 MiB

// snapshotClient is the HTTP client used to reach cameras. It is a package
// variable so tests can swap in an httptest-backed transport.
var snapshotClient = &http.Client{Timeout: snapshotTimeout}

// Snapshot proxies the camera's still-image endpoint through the API.
//
// Cameras live on a private network the mobile app cannot reach, so clients
// must not fetch snapshot_url directly. This handler runs inside that network,
// fetches the JPEG, and relays it over the authenticated API connection the
// client already has.
func (h *CameraHandler) Snapshot(c *gin.Context) {
	cam, ok := h.store.Get(c.Param("id"))
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "camera not found"})
		return
	}

	raw := strings.TrimSpace(cam.SnapshotURL)
	if raw == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "camera has no snapshot url"})
		return
	}

	target, err := url.Parse(raw)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "camera snapshot url is not a valid http(s) url"})
		return
	}

	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "camera snapshot url is not a valid http(s) url"})
		return
	}

	resp, err := snapshotClient.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "camera snapshot unreachable"})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		c.JSON(http.StatusBadGateway, gin.H{"error": "camera snapshot returned " + resp.Status})
		return
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "image/jpeg"
	}

	// Stills change every refresh; caching them would defeat the client's
	// interval and can serve a stale frame after the camera goes offline.
	c.Header("Cache-Control", "no-store")
	c.DataFromReader(http.StatusOK, -1, contentType, io.LimitReader(resp.Body, snapshotMaxBytes), nil)
}
