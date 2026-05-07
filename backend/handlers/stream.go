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
