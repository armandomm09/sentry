package stream

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/dim/sentry/backend/models"
)

const (
	hlsBaseDir      = "/tmp/sentry/streams"
	reconnectDelay  = 5 * time.Second
	maxReconnects   = 10
)

type streamEntry struct {
	cancel    context.CancelFunc
	status    string // "live" | "reconnecting" | "offline"
	startedAt time.Time
	errMsg    string
}

type Manager struct {
	mu      sync.RWMutex
	streams map[string]*streamEntry
}

func NewManager() *Manager {
	return &Manager{streams: make(map[string]*streamEntry)}
}

// Start begins streaming a camera. Idempotent — safe to call if already running.
func (m *Manager) Start(camera *models.Camera) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if e, ok := m.streams[camera.ID]; ok && e.status == "live" {
		return nil // already streaming
	}

	outDir := filepath.Join(hlsBaseDir, camera.ID)
	if err := os.MkdirAll(outDir, 0755); err != nil {
		return fmt.Errorf("create HLS dir: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	entry := &streamEntry{
		cancel:    cancel,
		status:    "reconnecting",
		startedAt: time.Now(),
	}
	m.streams[camera.ID] = entry

	go m.runLoop(ctx, camera, entry, outDir)
	return nil
}

func (m *Manager) runLoop(ctx context.Context, camera *models.Camera, entry *streamEntry, outDir string) {
	attempts := 0
	for {
		select {
		case <-ctx.Done():
			m.setStatus(camera.ID, "offline", "")
			return
		default:
		}

		if attempts >= maxReconnects && !camera.AutoReconnect {
			m.setStatus(camera.ID, "offline", "max reconnects reached")
			return
		}

		m.setStatus(camera.ID, "reconnecting", "")
		playlist := filepath.Join(outDir, "stream.m3u8")

		cmd := exec.CommandContext(ctx, "ffmpeg",
			"-loglevel", "error",
			"-rtsp_transport", "tcp",
			"-i", camera.RTSPURL,
			"-c:v", "libx264",
			"-preset", "ultrafast",
			"-tune", "zerolatency",
			"-g", "30",
			"-sc_threshold", "0",
			"-c:a", "aac",
			"-b:a", "128k",
			"-f", "hls",
			"-hls_time", "2",
			"-hls_list_size", "5",
			"-hls_flags", "delete_segments+append_list",
			"-hls_segment_filename", filepath.Join(outDir, "seg%05d.ts"),
			playlist,
		)

		log.Printf("[stream] starting camera %s (%s)", camera.ID, camera.RTSPURL)
		m.setStatus(camera.ID, "live", "")

		if err := cmd.Run(); err != nil {
			if ctx.Err() != nil {
				m.setStatus(camera.ID, "offline", "")
				return
			}
			log.Printf("[stream] camera %s exited: %v", camera.ID, err)
			m.setStatus(camera.ID, "reconnecting", err.Error())
			attempts++
		} else {
			attempts = 0
		}

		select {
		case <-ctx.Done():
			m.setStatus(camera.ID, "offline", "")
			return
		case <-time.After(reconnectDelay):
		}
	}
}

func (m *Manager) setStatus(id, status, errMsg string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.streams[id]; ok {
		e.status = status
		e.errMsg = errMsg
	}
}

// Stop gracefully shuts down a camera stream.
func (m *Manager) Stop(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.streams[id]; ok {
		e.cancel()
		delete(m.streams, id)
	}
	// Clean up HLS segments
	_ = os.RemoveAll(filepath.Join(hlsBaseDir, id))
}

// Status returns the current stream status for a camera.
func (m *Manager) Status(id string) models.StreamStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()

	e, ok := m.streams[id]
	if !ok {
		return models.StreamStatus{CameraID: id, Status: "offline"}
	}

	hlsURL := ""
	if e.status == "live" {
		hlsURL = fmt.Sprintf("/hls/%s/stream.m3u8", id)
	}

	st := e.startedAt
	return models.StreamStatus{
		CameraID:  id,
		Status:    e.status,
		HLSURL:    hlsURL,
		StartedAt: &st,
		Error:     e.errMsg,
	}
}

// StartAll starts streams for all cameras with AutoReconnect enabled.
func (m *Manager) StartAll(cameras []*models.Camera) {
	for _, c := range cameras {
		if c.AutoReconnect {
			if err := m.Start(c); err != nil {
				log.Printf("[stream] failed to start %s: %v", c.ID, err)
			}
		}
	}
}

// HLSDir returns the HLS output directory for a camera.
func HLSDir() string {
	return hlsBaseDir
}
