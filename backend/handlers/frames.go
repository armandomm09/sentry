package handlers

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var wsUpgrader = websocket.Upgrader{
	// Allow any origin — tighten in production.
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 512 * 1024,
}

// FramesWS streams raw JPEG frames (one binary WS message per frame) to any
// subscriber — primarily the face-service, which connects here instead of
// pulling its own RTSP stream.
func (h *CameraHandler) FramesWS(c *gin.Context) {
	id := c.Param("id")
	if _, ok := h.store.Get(id); !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "camera not found"})
		return
	}

	ch := h.manager.Subscribe(id)
	if ch == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "stream not active for camera " + id})
		return
	}
	defer h.manager.Unsubscribe(id, ch)

	conn, err := wsUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		// Upgrade writes the error response itself.
		return
	}
	defer conn.Close()

	// Read goroutine detects disconnects; write goroutine sends frames.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-done:
			return
		case frame, ok := <-ch:
			if !ok {
				return
			}
			if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				log.Printf("[frames-ws] write error for camera %s: %v", id, err)
				return
			}
		}
	}
}
