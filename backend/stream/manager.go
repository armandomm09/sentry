package stream

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"sync"

	"github.com/dim/sentry/backend/models"
)

const hlsBaseDir = "/tmp/sentry/streams"

// Manager starts and stops per-camera Relays and exposes frame subscriptions.
type Manager struct {
	mu     sync.RWMutex
	relays map[string]*Relay
	// sourceURL tracks the URL used when the relay was last started so we can
	// detect changes and recycle the relay automatically.
	sourceURLs map[string]string
}

func NewManager() *Manager {
	return &Manager{
		relays:     make(map[string]*Relay),
		sourceURLs: make(map[string]string),
	}
}

// Start begins streaming a camera. If already streaming with the same source
// URL it is a no-op. If the URL changed the old relay is stopped and replaced.
func (m *Manager) Start(camera *models.Camera) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	existing, ok := m.relays[camera.ID]
	if ok {
		if m.sourceURLs[camera.ID] == camera.RTSPURL {
			return nil // same URL, already running
		}
		// URL changed — stop old relay and start fresh.
		log.Printf("[stream] source URL changed for %s, recycling relay", camera.ID)
		existing.stop()
		_ = os.RemoveAll(filepath.Join(hlsBaseDir, camera.ID))
		delete(m.relays, camera.ID)
		delete(m.sourceURLs, camera.ID)
	}

	outDir := filepath.Join(hlsBaseDir, camera.ID)
	r := newRelay(camera.ID, outDir)
	src := NewSource(camera.RTSPURL)

	if err := r.start(context.Background(), src); err != nil {
		return err
	}

	m.relays[camera.ID] = r
	m.sourceURLs[camera.ID] = camera.RTSPURL
	log.Printf("[stream] relay started for camera %s (%s)", camera.ID, camera.RTSPURL)
	return nil
}

// Stop shuts down the relay for a camera and removes its HLS directory.
func (m *Manager) Stop(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.relays[id]; ok {
		r.stop()
		delete(m.relays, id)
		delete(m.sourceURLs, id)
	}
	_ = os.RemoveAll(filepath.Join(hlsBaseDir, id))
}

// Status returns the current stream status for a camera.
func (m *Manager) Status(id string) models.StreamStatus {
	m.mu.RLock()
	r, ok := m.relays[id]
	m.mu.RUnlock()
	if !ok {
		return models.StreamStatus{CameraID: id, Status: "offline"}
	}
	return r.Status()
}

// StartAll starts relays for all cameras that have auto_reconnect enabled.
func (m *Manager) StartAll(cameras []*models.Camera) {
	for _, c := range cameras {
		if c.AutoReconnect {
			if err := m.Start(c); err != nil {
				log.Printf("[stream] failed to start %s: %v", c.ID, err)
			}
		}
	}
}

// Subscribe returns a channel that receives JPEG frames from the camera's relay.
// Returns nil if no relay is running for that camera.
// The caller must call Unsubscribe when done to avoid leaking the channel.
func (m *Manager) Subscribe(id string) chan []byte {
	m.mu.RLock()
	r, ok := m.relays[id]
	m.mu.RUnlock()
	if !ok {
		return nil
	}
	return r.subscribe()
}

// Unsubscribe removes a channel previously returned by Subscribe.
func (m *Manager) Unsubscribe(id string, ch chan []byte) {
	m.mu.RLock()
	r, ok := m.relays[id]
	m.mu.RUnlock()
	if !ok {
		return
	}
	r.unsubscribe(ch)
}

// HLSDir returns the root directory where HLS segments are stored.
func HLSDir() string { return hlsBaseDir }
