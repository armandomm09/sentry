package events

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/dim/sentry/backend/db"
)

type fakeCutter struct {
	mu     sync.Mutex
	starts []string // eventIDs
	stops  []string
	dones  map[string]func(string, error)
}

func newFakeCutter() *fakeCutter { return &fakeCutter{dones: map[string]func(string, error){}} }

func (f *fakeCutter) Start(eventID, cameraID string, done func(string, error)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts = append(f.starts, eventID)
	f.dones[eventID] = done
}

func (f *fakeCutter) Stop(eventID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stops = append(f.stops, eventID)
}

func testRecorder(t *testing.T) (*Recorder, *db.DB, *fakeCutter, string) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	thumbs := t.TempDir()
	fc := newFakeCutter()
	r := NewRecorder(d, thumbs, fc, 72*time.Hour)
	return r, d, fc, thumbs
}

var testJPEG = base64.StdEncoding.EncodeToString([]byte{0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3})

func confirmedMsg(trackKey, personID string) []byte {
	pid := "null"
	name := "null"
	if personID != "" {
		pid = fmt.Sprintf("%q", personID)
		name = `"Alice"`
	}
	return []byte(fmt.Sprintf(`{"type":"track_confirmed","camera_id":"cam1","track_key":%q,
		"ts":100.5,"person_id":%s,"name":%s,"similarity":0.5,"crop_jpeg_b64":%q}`,
		trackKey, pid, name, testJPEG))
}

func TestConfirmedCreatesEventThumbAndStartsClip(t *testing.T) {
	r, d, fc, thumbs := testRecorder(t)
	r.OnLifecycle(confirmedMsg("cam1:0:1", "p1"))

	ev, ok, err := d.GetEventByTrackKey("cam1:0:1")
	if err != nil || !ok {
		t.Fatalf("event not created: %v", err)
	}
	if ev.PersonID != "p1" || ev.PersonName != "Alice" || ev.StartedAt != 100500 {
		t.Fatalf("event: %+v", ev)
	}
	wantThumb := filepath.Join(thumbs, ev.ID+".jpg")
	if ev.ThumbPath != wantThumb {
		t.Fatalf("thumb path: %s", ev.ThumbPath)
	}
	if _, err := os.Stat(wantThumb); err != nil {
		t.Fatalf("thumb file: %v", err)
	}
	if len(fc.starts) != 1 || fc.starts[0] != ev.ID {
		t.Fatalf("cutter starts: %v", fc.starts)
	}

	// clip done callback persists path + expiry
	fc.dones[ev.ID]("/clips/x.mp4", nil)
	ev, _, _ = d.GetEvent(ev.ID)
	if ev.ClipPath != "/clips/x.mp4" || ev.ClipExpiresAt == 0 {
		t.Fatalf("clip not persisted: %+v", ev)
	}
}

func TestDuplicateConfirmedIgnored(t *testing.T) {
	r, d, fc, _ := testRecorder(t)
	r.OnLifecycle(confirmedMsg("k1", ""))
	r.OnLifecycle(confirmedMsg("k1", ""))
	all, _ := d.ListEvents(db.EventFilter{})
	if len(all) != 1 {
		t.Fatalf("events: %d", len(all))
	}
	if len(fc.starts) != 1 {
		t.Fatalf("cutter started %d times", len(fc.starts))
	}
}

func TestUpdatedUpgradesIdentity(t *testing.T) {
	r, d, _, _ := testRecorder(t)
	r.OnLifecycle(confirmedMsg("k1", "")) // unknown
	r.OnLifecycle([]byte(`{"type":"track_updated","camera_id":"cam1","track_key":"k1",
		"ts":105,"person_id":"p2","name":"Bob","similarity":0.6}`))
	ev, _, _ := d.GetEventByTrackKey("k1")
	if ev.PersonID != "p2" || ev.PersonName != "Bob" || ev.Similarity != 0.6 {
		t.Fatalf("identity not upgraded: %+v", ev)
	}
}

func TestEndedClosesStoresEmbeddingAndStopsClip(t *testing.T) {
	r, d, fc, _ := testRecorder(t)
	r.OnLifecycle(confirmedMsg("k1", "")) // unknown -> embedding must be stored
	emb := make([]byte, 8)
	embB64 := base64.StdEncoding.EncodeToString(emb)
	r.OnLifecycle([]byte(fmt.Sprintf(`{"type":"track_ended","camera_id":"cam1","track_key":"k1",
		"ts":110,"started_ts":100.5,"ended_ts":110,"person_id":null,"name":null,
		"similarity":null,"crop_jpeg_b64":%q,"embedding_b64":%q}`, testJPEG, embB64)))

	ev, _, _ := d.GetEventByTrackKey("k1")
	if ev.EndedAt != 110000 {
		t.Fatalf("ended_at: %d", ev.EndedAt)
	}
	if len(ev.Embedding) != 8 {
		t.Fatalf("embedding not stored: %d bytes", len(ev.Embedding))
	}
	if len(fc.stops) != 1 || fc.stops[0] != ev.ID {
		t.Fatalf("cutter stops: %v", fc.stops)
	}
}

func TestEndedKnownDoesNotStoreEmbedding(t *testing.T) {
	r, d, _, _ := testRecorder(t)
	r.OnLifecycle(confirmedMsg("k1", "p1"))
	embB64 := base64.StdEncoding.EncodeToString(make([]byte, 8))
	r.OnLifecycle([]byte(fmt.Sprintf(`{"type":"track_ended","camera_id":"cam1","track_key":"k1",
		"ts":110,"started_ts":100.5,"ended_ts":110,"person_id":"p1","name":"Alice",
		"similarity":0.5,"crop_jpeg_b64":null,"embedding_b64":%q}`, embB64)))
	ev, _, _ := d.GetEventByTrackKey("k1")
	if len(ev.Embedding) != 0 {
		t.Fatal("known event must not store embedding")
	}
}

func TestEndedWithoutConfirmedIsIgnored(t *testing.T) {
	r, d, fc, _ := testRecorder(t)
	r.OnLifecycle([]byte(`{"type":"track_ended","camera_id":"cam1","track_key":"never-seen",
		"ts":110,"started_ts":100,"ended_ts":110,"person_id":null,"name":null,
		"similarity":null,"crop_jpeg_b64":null,"embedding_b64":null}`))
	all, _ := d.ListEvents(db.EventFilter{})
	if len(all) != 0 || len(fc.stops) != 0 {
		t.Fatal("orphan ended must be ignored")
	}
}

func TestGarbageInputIgnored(t *testing.T) {
	r, d, _, _ := testRecorder(t)
	r.OnLifecycle([]byte(`not json`))
	r.OnLifecycle([]byte(`{"type":"detections"}`))
	all, _ := d.ListEvents(db.EventFilter{})
	if len(all) != 0 {
		t.Fatal("garbage created events")
	}
}
