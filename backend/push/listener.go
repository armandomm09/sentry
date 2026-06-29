package push

import (
	"encoding/json"
	"log"
	"strings"
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

type Listener struct {
	faceBaseURL string // e.g. "http://127.0.0.1:8090"
	notifier    *Notifier
	store       CameraNameStore
}

func NewListener(faceBaseURL string, notifier *Notifier, store CameraNameStore) *Listener {
	return &Listener{
		faceBaseURL: faceBaseURL,
		notifier:    notifier,
		store:       store,
	}
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
		var frame detectionFrame
		if err := json.Unmarshal(msg, &frame); err != nil {
			continue
		}
		if frame.Type != "detections" || len(frame.Detections) == 0 {
			continue
		}
		cameraName := l.store.GetCameraName(cameraID)
		for _, det := range frame.Detections {
			isKnown := det.PersonID != ""
			name := det.Name
			if !isKnown {
				name = ""
			}
			l.notifier.Send(Message{
				CameraID:   cameraID,
				CameraName: cameraName,
				PersonName: name,
				IsKnown:    isKnown,
			})
		}
	}
}
