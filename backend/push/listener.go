package push

import (
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type detectionFrame struct {
	Type       string      `json:"type"`
	CameraID   string      `json:"camera_id"`
	Detections []detection `json:"detections"`
}

type detection struct {
	PersonID string  `json:"person_id"`
	Name     string  `json:"name"`
	Score    float64 `json:"score"`
}

// Sender is the notification outlet. *Notifier satisfies it.
type Sender interface {
	Send(Message)
}

type Listener struct {
	faceBaseURL string // e.g. "http://127.0.0.1:8090"
	notifier    Sender
	store       CameraNameStore
	mu          sync.Mutex
	lastSent    map[string]time.Time // key: cameraID+":"+personKey
	sink        func(raw []byte)
	sinkMu      sync.RWMutex
}

func NewListener(faceBaseURL string, notifier Sender, store CameraNameStore) *Listener {
	return &Listener{
		faceBaseURL: faceBaseURL,
		notifier:    notifier,
		store:       store,
		lastSent:    make(map[string]time.Time),
	}
}

// SetLifecycleSink registers a consumer for track lifecycle messages
// (track_confirmed / track_updated / track_ended). Call before WatchCamera.
func (l *Listener) SetLifecycleSink(fn func(raw []byte)) {
	l.sinkMu.Lock()
	l.sink = fn
	l.sinkMu.Unlock()
}

// WatchCamera starts a background goroutine that subscribes to the face-service
// detection WS for cameraID. Reconnects automatically on disconnect.
func (l *Listener) WatchCamera(cameraID string) {
	go l.reconnectLoop(cameraID)
}

func (l *Listener) reconnectLoop(cameraID string) {
	wsURL := strings.Replace(l.faceBaseURL, "http://", "ws://", 1)
	wsURL = strings.Replace(wsURL, "https://", "wss://", 1)
	wsURL += "/cameras/" + cameraID + "/ws"

	for {
		if err := l.connectAndRead(wsURL, cameraID); err != nil {
			log.Printf("[push-listener] camera %s disconnected: %v — reconnecting in 5s", cameraID, err)
		}
		time.Sleep(5 * time.Second)
	}
}

func (l *Listener) connectAndRead(wsURL, cameraID string) error {
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	log.Printf("[push-listener] connected to face-service for camera %s", cameraID)
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		l.handleMessage(cameraID, msg)
	}
}

// handleMessage routes one raw WS message: per-frame detections drive push
// notifications (unchanged behavior); track lifecycle messages go to the sink.
func (l *Listener) handleMessage(cameraID string, msg []byte) {
	var frame detectionFrame
	if err := json.Unmarshal(msg, &frame); err != nil {
		return
	}
	switch frame.Type {
	case "detections":
		l.handleDetections(cameraID, &frame)
	case "track_confirmed", "track_updated", "track_ended":
		l.sinkMu.RLock()
		sink := l.sink
		l.sinkMu.RUnlock()
		if sink != nil {
			sink(msg)
		}
	}
}

func (l *Listener) handleDetections(cameraID string, frame *detectionFrame) {
	if len(frame.Detections) == 0 {
		return
	}
	cameraName := l.store.GetCameraName(cameraID)
	for _, det := range frame.Detections {
		isKnown := det.PersonID != ""
		name := det.Name
		if !isKnown {
			name = ""
		}

		personKey := det.PersonID
		if personKey == "" {
			personKey = "unknown"
		}
		cooldownKey := cameraID + ":" + personKey

		l.mu.Lock()
		lastTime, exists := l.lastSent[cooldownKey]
		shouldSend := !exists || time.Since(lastTime) >= 60*time.Second
		if shouldSend {
			l.lastSent[cooldownKey] = time.Now()
		}
		l.mu.Unlock()

		if !shouldSend {
			continue
		}

		l.notifier.Send(Message{
			CameraID:   cameraID,
			CameraName: cameraName,
			PersonName: name,
			IsKnown:    isKnown,
		})
	}
}
