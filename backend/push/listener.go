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
	Type     string `json:"type"`
	CameraID string `json:"camera_id"`
}

// trackConfirmedMsg mirrors face-service lifecycle.py's track_confirmed
// payload (only the fields notifications need).
type trackConfirmedMsg struct {
	TrackKey string  `json:"track_key"`
	TS       float64 `json:"ts"`
	PersonID *string `json:"person_id"`
	Name     *string `json:"name"`
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
	sink        func(raw []byte)
	sinkMu      sync.RWMutex

	watching map[string]bool // cameraIDs with an active reconnectLoop goroutine
}

func NewListener(faceBaseURL string, notifier Sender, store CameraNameStore) *Listener {
	return &Listener{
		faceBaseURL: faceBaseURL,
		notifier:    notifier,
		store:       store,
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
	l.EnsureWatching(cameraID)
}

// EnsureWatching starts the per-camera subscription goroutine once; later
// calls for the same camera are no-ops. Safe from any goroutine.
func (l *Listener) EnsureWatching(cameraID string) {
	l.mu.Lock()
	if l.watching == nil {
		l.watching = make(map[string]bool)
	}
	if l.watching[cameraID] {
		l.mu.Unlock()
		return
	}
	l.watching[cameraID] = true
	l.mu.Unlock()
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

// handleMessage routes one raw WS message: track lifecycle messages go to the
// sink; track_confirmed also triggers a notification.
func (l *Listener) handleMessage(cameraID string, msg []byte) {
	var frame detectionFrame
	if err := json.Unmarshal(msg, &frame); err != nil {
		return
	}
	switch frame.Type {
	case "track_confirmed", "track_updated", "track_ended":
		l.sinkMu.RLock()
		sink := l.sink
		l.sinkMu.RUnlock()
		if sink != nil {
			// Synchronous: the events recorder persists the row before we
			// enqueue the notification, so dispatch can resolve event_id.
			sink(msg)
		}
		if frame.Type == "track_confirmed" {
			l.notifyConfirmed(cameraID, msg)
		}
	}
}

// notifyConfirmed emits exactly one notification per confirmed track.
// Policy filtering (every / quiet_period / first_of_day) happens in the
// Notifier, which reads last-seen state from the events table.
func (l *Listener) notifyConfirmed(cameraID string, raw []byte) {
	var m trackConfirmedMsg
	if err := json.Unmarshal(raw, &m); err != nil || m.TrackKey == "" {
		return
	}
	personID, name := "", ""
	if m.PersonID != nil {
		personID = *m.PersonID
	}
	if m.Name != nil {
		name = *m.Name
	}
	l.notifier.Send(Message{
		CameraID:   cameraID,
		CameraName: l.store.GetCameraName(cameraID),
		PersonID:   personID,
		PersonName: name,
		IsKnown:    personID != "",
		TrackKey:   m.TrackKey,
		StartedAt:  int64(m.TS * 1000),
	})
}
