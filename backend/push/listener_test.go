package push

import (
	"sync"
	"testing"
)

type fakeSender struct {
	mu   sync.Mutex
	msgs []Message
}

func (f *fakeSender) Send(m Message) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgs = append(f.msgs, m)
}

type fakeStore struct{}

func (fakeStore) GetCameraName(id string) string { return "Front Door" }

// Per-frame detections must NOT notify anymore — notifications fire once per
// event on track_confirmed (spec § 4), which kills both the 60s-cooldown spam
// and pending-track noise (lifecycle.py only confirms non-pending tracks).
func TestDetectionsDoNotNotify(t *testing.T) {
	sender := &fakeSender{}
	l := NewListener("http://x", sender, fakeStore{})
	l.handleMessage("cam1", []byte(`{"type":"detections","camera_id":"cam1",
		"detections":[{"person_id":"p1","name":"Alice","score":0.9}]}`))
	if len(sender.msgs) != 0 {
		t.Fatalf("detections must not notify: %+v", sender.msgs)
	}
}

func TestTrackConfirmedNotifiesOnce(t *testing.T) {
	sender := &fakeSender{}
	l := NewListener("http://x", sender, fakeStore{})
	l.SetLifecycleSink(func([]byte) {})

	l.handleMessage("cam1", []byte(`{"type":"track_confirmed","camera_id":"cam1",
		"track_key":"cam1:7:123","ts":1721480000.5,"person_id":"p1","name":"Alice","similarity":0.61}`))
	if len(sender.msgs) != 1 {
		t.Fatalf("want 1 notification, got %+v", sender.msgs)
	}
	m := sender.msgs[0]
	if !m.IsKnown || m.PersonID != "p1" || m.PersonName != "Alice" ||
		m.TrackKey != "cam1:7:123" || m.StartedAt != 1721480000500 ||
		m.CameraID != "cam1" || m.CameraName != "Front Door" {
		t.Fatalf("message fields: %+v", m)
	}

	// Unknown confirm: person_id null.
	l.handleMessage("cam1", []byte(`{"type":"track_confirmed","camera_id":"cam1",
		"track_key":"cam1:8:123","ts":1721480001.0,"person_id":null,"name":null,"similarity":null}`))
	if len(sender.msgs) != 2 || sender.msgs[1].IsKnown || sender.msgs[1].PersonID != "" {
		t.Fatalf("unknown confirm: %+v", sender.msgs)
	}

	// track_updated (unknown → known) and track_ended never notify again.
	l.handleMessage("cam1", []byte(`{"type":"track_updated","camera_id":"cam1",
		"track_key":"cam1:8:123","ts":1721480002.0,"person_id":"p1","name":"Alice","similarity":0.6}`))
	l.handleMessage("cam1", []byte(`{"type":"track_ended","camera_id":"cam1",
		"track_key":"cam1:8:123","ts":1721480003.0}`))
	if len(sender.msgs) != 2 {
		t.Fatalf("updated/ended must not notify: %+v", sender.msgs)
	}
}

func TestLifecycleGoesToSink(t *testing.T) {
	sender := &fakeSender{}
	l := NewListener("http://x", sender, fakeStore{})
	var got [][]byte
	l.SetLifecycleSink(func(raw []byte) { got = append(got, raw) })
	for _, typ := range []string{"track_confirmed", "track_updated", "track_ended"} {
		l.handleMessage("cam1", []byte(`{"type":"`+typ+`","camera_id":"cam1","track_key":"k","ts":1.0}`))
	}
	if len(got) != 3 {
		t.Fatalf("sink calls: %d", len(got))
	}
	if len(sender.msgs) != 1 { // only track_confirmed notifies
		t.Fatalf("want exactly 1 notification from track_confirmed: %+v", sender.msgs)
	}
}

func TestEnsureWatchingIsIdempotent(t *testing.T) {
	l := NewListener("http://127.0.0.1:1", &fakeSender{}, fakeStore{})
	l.EnsureWatching("cam1")
	l.EnsureWatching("cam1")
	l.EnsureWatching("cam2")
	l.mu.Lock()
	n := len(l.watching)
	l.mu.Unlock()
	if n != 2 {
		t.Fatalf("watching entries = %d, want 2", n)
	}
}

func TestNilSinkAndGarbageAreSafe(t *testing.T) {
	l := NewListener("http://x", &fakeSender{}, fakeStore{})
	l.handleMessage("cam1", []byte(`{"type":"track_confirmed","track_key":"k"}`)) // no sink set
	l.handleMessage("cam1", []byte(`garbage`))
	l.handleMessage("cam1", []byte(`{"type":"hello"}`))
}
