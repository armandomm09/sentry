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

func TestDetectionsStillNotify(t *testing.T) {
	sender := &fakeSender{}
	l := NewListener("http://x", sender, fakeStore{})
	l.handleMessage("cam1", []byte(`{"type":"detections","camera_id":"cam1",
		"detections":[{"person_id":"p1","name":"Alice","score":0.9}]}`))
	if len(sender.msgs) != 1 || !sender.msgs[0].IsKnown || sender.msgs[0].PersonName != "Alice" {
		t.Fatalf("msgs: %+v", sender.msgs)
	}
	// cooldown: identical detection within 60s must not notify again
	l.handleMessage("cam1", []byte(`{"type":"detections","camera_id":"cam1",
		"detections":[{"person_id":"p1","name":"Alice","score":0.9}]}`))
	if len(sender.msgs) != 1 {
		t.Fatalf("cooldown broken: %d msgs", len(sender.msgs))
	}
}

func TestLifecycleGoesToSinkNotNotifier(t *testing.T) {
	sender := &fakeSender{}
	l := NewListener("http://x", sender, fakeStore{})
	var got [][]byte
	l.SetLifecycleSink(func(raw []byte) { got = append(got, raw) })
	for _, typ := range []string{"track_confirmed", "track_updated", "track_ended"} {
		l.handleMessage("cam1", []byte(`{"type":"`+typ+`","camera_id":"cam1","track_key":"k"}`))
	}
	if len(got) != 3 {
		t.Fatalf("sink calls: %d", len(got))
	}
	if len(sender.msgs) != 0 {
		t.Fatalf("lifecycle must not notify: %+v", sender.msgs)
	}
}

func TestNilSinkAndGarbageAreSafe(t *testing.T) {
	l := NewListener("http://x", &fakeSender{}, fakeStore{})
	l.handleMessage("cam1", []byte(`{"type":"track_confirmed","track_key":"k"}`)) // no sink set
	l.handleMessage("cam1", []byte(`garbage`))
	l.handleMessage("cam1", []byte(`{"type":"hello"}`))
}
