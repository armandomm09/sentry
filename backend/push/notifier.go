package push

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/dim/sentry/backend/db"
)

const expoURL = "https://exp.host/push/send"

type Message struct {
	CameraID   string
	CameraName string
	PersonName string // empty = unknown
	IsKnown    bool
}

type CameraNameStore interface {
	GetCameraName(id string) string
}

type expoMessage struct {
	To    string            `json:"to"`
	Title string            `json:"title"`
	Body  string            `json:"body"`
	Data  map[string]string `json:"data"`
}

type Notifier struct {
	db    *db.DB
	store CameraNameStore
	ch    chan Message
}

func NewNotifier(database *db.DB, store CameraNameStore) *Notifier {
	return &Notifier{
		db:    database,
		store: store,
		ch:    make(chan Message, 256),
	}
}

func (n *Notifier) Send(msg Message) {
	select {
	case n.ch <- msg:
	default:
		log.Printf("[push] notification channel full, dropping event for camera %s", msg.CameraID)
	}
}

func (n *Notifier) Start() {
	go n.processLoop()
}

func (n *Notifier) processLoop() {
	for msg := range n.ch {
		n.dispatch(msg)
	}
}

func (n *Notifier) dispatch(msg Message) {
	subs, err := n.db.ListPushSubscriptions()
	if err != nil {
		log.Printf("[push] list subscriptions: %v", err)
		return
	}

	var batch []expoMessage
	for _, sub := range subs {
		if !n.shouldNotify(sub, msg) {
			continue
		}
		body := n.buildBody(msg)
		batch = append(batch, expoMessage{
			To:    sub.ExpoPushToken,
			Title: "Sentry Alert",
			Body:  body,
			Data:  map[string]string{"camera_id": msg.CameraID, "type": "detection"},
		})
		if len(batch) == 100 {
			n.sendBatch(batch)
			batch = nil
		}
	}
	if len(batch) > 0 {
		n.sendBatch(batch)
	}
}

func (n *Notifier) shouldNotify(sub *db.PushSubscription, msg Message) bool {
	if msg.IsKnown && !sub.NotifyKnown {
		return false
	}
	if !msg.IsKnown && !sub.NotifyUnknown {
		return false
	}
	// Empty camera_ids = all cameras
	if len(sub.CameraIDs) == 0 {
		return true
	}
	for _, id := range sub.CameraIDs {
		if id == msg.CameraID {
			return true
		}
	}
	return false
}

func (n *Notifier) buildBody(msg Message) string {
	if msg.IsKnown {
		return fmt.Sprintf("%s detected at %s", msg.PersonName, msg.CameraName)
	}
	return fmt.Sprintf("Unknown person detected at %s", msg.CameraName)
}

func (n *Notifier) sendBatch(batch []expoMessage) {
	if err := n.doSend(batch); err != nil {
		log.Printf("[push] send failed, retrying: %v", err)
		time.Sleep(2 * time.Second)
		if err := n.doSend(batch); err != nil {
			log.Printf("[push] retry failed: %v", err)
		}
	}
}

func (n *Notifier) doSend(batch []expoMessage) error {
	data, err := json.Marshal(batch)
	if err != nil {
		return err
	}
	resp, err := http.Post(expoURL, "application/json", bytes.NewReader(data))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("expo returned %d", resp.StatusCode)
	}
	return nil
}
