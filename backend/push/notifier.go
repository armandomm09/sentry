package push

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/dim/sentry/backend/db"
)

const expoURL = "https://exp.host/--/api/v2/push/send"

// Message describes one confirmed sighting event to (maybe) notify about.
type Message struct {
	CameraID   string
	CameraName string
	PersonID   string // empty = unknown
	PersonName string // empty = unknown
	IsKnown    bool
	TrackKey   string // lifecycle track key; resolves event_id at dispatch time
	StartedAt  int64  // event start, unix ms
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
	db        *db.DB
	store     CameraNameStore
	ch        chan Message
	loc       *time.Location // local calendar for first_of_day; time.Local in prod
	mu        sync.RWMutex
	subCache  []*db.PushSubscription
	cacheTime time.Time
}

func NewNotifier(database *db.DB, store CameraNameStore) *Notifier {
	return &Notifier{
		db:    database,
		store: store,
		ch:    make(chan Message, 256),
		loc:   time.Local,
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

func (n *Notifier) getSubscriptions() ([]*db.PushSubscription, error) {
	n.mu.RLock()
	if time.Since(n.cacheTime) < 30*time.Second && n.subCache != nil {
		subs := n.subCache
		n.mu.RUnlock()
		return subs, nil
	}
	n.mu.RUnlock()

	subs, err := n.db.ListPushSubscriptions()
	if err != nil {
		return nil, err
	}
	n.mu.Lock()
	n.subCache = subs
	n.cacheTime = time.Now()
	n.mu.Unlock()
	return subs, nil
}

func (n *Notifier) dispatch(msg Message) {
	batch := n.buildBatch(msg)
	for len(batch) > 0 {
		chunk := batch
		if len(chunk) > 100 {
			chunk = batch[:100]
		}
		n.sendBatch(chunk)
		batch = batch[len(chunk):]
	}
}

// buildBatch evaluates every subscription's filters and policy mode against
// one confirmed event and returns the Expo messages to send. "Last seen"
// state is read from the events table (spec § 4): known people dedupe by
// person across all cameras; unknowns dedupe per camera.
func (n *Notifier) buildBatch(msg Message) []expoMessage {
	subs, err := n.getSubscriptions()
	if err != nil {
		log.Printf("[push] list subscriptions: %v", err)
		return nil
	}

	// The recorder sink runs synchronously before Send, so the event row for
	// this track_key normally exists by now; a miss just omits event_id.
	eventID := ""
	if msg.TrackKey != "" {
		if ev, ok, err := n.db.GetEventByTrackKey(msg.TrackKey); err == nil && ok {
			eventID = ev.ID
		}
	}

	var lastSeen int64
	var hasLastSeen bool
	if msg.IsKnown {
		lastSeen, hasLastSeen, err = n.db.LastSeenPerson(msg.PersonID, msg.StartedAt)
	} else {
		lastSeen, hasLastSeen, err = n.db.LastSeenUnknown(msg.CameraID, msg.StartedAt)
	}
	if err != nil {
		// Fail open: a DB error must not silently mute alerts.
		log.Printf("[push] last-seen lookup: %v", err)
		hasLastSeen = false
	}

	var batch []expoMessage
	for _, sub := range subs {
		if !n.shouldNotify(sub, msg) {
			continue
		}
		mode, quietHours := sub.NotifyKnownMode, sub.KnownQuietHours
		if !msg.IsKnown {
			mode, quietHours = sub.NotifyUnknownMode, sub.UnknownQuietHours
		}
		if !policyAllows(mode, quietHours, lastSeen, hasLastSeen, msg.StartedAt, n.loc) {
			continue
		}
		data := map[string]string{"camera_id": msg.CameraID, "type": "detection"}
		if eventID != "" {
			data["event_id"] = eventID
		}
		batch = append(batch, expoMessage{
			To:    sub.ExpoPushToken,
			Title: "Sentry Alert",
			Body:  n.buildBody(msg),
			Data:  data,
		})
	}
	return batch
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
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("expo returned %d: %s", resp.StatusCode, string(body))
	}

	// Expo returns HTTP 200 even when individual messages fail. Parse the
	// per-message "tickets" so delivery errors (bad token, InvalidCredentials,
	// DeviceNotRegistered, ...) are not silently swallowed.
	var ticketResp struct {
		Data []struct {
			Status  string `json:"status"`
			ID      string `json:"id"`
			Message string `json:"message"`
			Details struct {
				Error string `json:"error"`
			} `json:"details"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &ticketResp); err != nil {
		log.Printf("[push] could not parse expo response: %v (body: %s)", err, string(body))
		return nil
	}
	ok := 0
	for i, t := range ticketResp.Data {
		if t.Status == "ok" {
			ok++
			continue
		}
		to := ""
		if i < len(batch) {
			to = batch[i].To
		}
		log.Printf("[push] expo rejected message to %s: %s (error=%s)", to, t.Message, t.Details.Error)
	}
	log.Printf("[push] expo accepted %d/%d messages", ok, len(ticketResp.Data))
	return nil
}
