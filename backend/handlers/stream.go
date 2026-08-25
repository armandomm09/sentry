package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func (h *CameraHandler) StreamStart(c *gin.Context) {
	id := c.Param("id")
	cam, ok := h.store.Get(id)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "camera not found"})
		return
	}

	if err := h.manager.Start(cam); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, h.manager.Status(id))
}

func (h *CameraHandler) StreamStop(c *gin.Context) {
	id := c.Param("id")
	if _, ok := h.store.Get(id); !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "camera not found"})
		return
	}

	h.manager.Stop(id)
	c.JSON(http.StatusOK, h.manager.Status(id))
}

func (h *CameraHandler) StreamStatus(c *gin.Context) {
	id := c.Param("id")
	if _, ok := h.store.Get(id); !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "camera not found"})
		return
	}

	c.JSON(http.StatusOK, h.manager.Status(id))
}

func (h *CameraHandler) AllStreamStatuses(c *gin.Context) {
	cameras := h.store.List()
	statuses := make(map[string]interface{})
	for _, cam := range cameras {
		statuses[cam.ID] = h.manager.Status(cam.ID)
	}
	c.JSON(http.StatusOK, statuses)
}

// StreamsHealth reports per-camera streaming health for monitoring.
//
// It exists because /health only proves the process is alive, which stayed true
// for ten days while every camera was wedged. This endpoint answers the question
// that actually matters: are frames still arriving?
//
// It is intentionally unauthenticated so container healthchecks and external
// monitors can poll it, so it exposes no URLs and no credentials — only camera
// ids/names and staleness. With ?strict=1 it returns 503 when any camera is
// stalled, which is the form to point a Docker HEALTHCHECK or an uptime monitor at.
func (h *CameraHandler) StreamsHealth(c *gin.Context) {
	cameras := h.store.List()

	type cameraHealth struct {
		ID                  string `json:"id"`
		Name                string `json:"name"`
		Status              string `json:"status"`
		Stalled             bool   `json:"stalled"`
		LastFrameAgeSeconds *int64 `json:"last_frame_age_seconds"`
	}

	out := make([]cameraHealth, 0, len(cameras))
	var live, stalled int

	for _, cam := range cameras {
		st := h.manager.Status(cam.ID)
		ch := cameraHealth{
			ID:      cam.ID,
			Name:    cam.Name,
			Status:  st.Status,
			Stalled: st.Stalled,
		}
		if st.LastFrameAt != nil {
			age := st.LastFrameAgeSeconds
			ch.LastFrameAgeSeconds = &age
		}
		switch {
		case st.Status == "live":
			live++
		case st.Stalled:
			stalled++
		}
		out = append(out, ch)
	}

	status := "ok"
	code := http.StatusOK
	if stalled > 0 {
		status = "degraded"
		if c.Query("strict") != "" {
			code = http.StatusServiceUnavailable
		}
	}

	c.JSON(code, gin.H{
		"status":  status,
		"cameras": out,
		"summary": gin.H{
			"total":   len(cameras),
			"live":    live,
			"stalled": stalled,
		},
	})
}
