package db

import (
	"path/filepath"
	"testing"
)

func testDB(t *testing.T) *DB {
	t.Helper()
	d, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func mkEvent(track string, startedAt int64) *Event {
	return &Event{CameraID: "cam1", TrackKey: track, StartedAt: startedAt}
}

func TestCreateAndGetEvent(t *testing.T) {
	d := testDB(t)
	e := &Event{CameraID: "cam1", TrackKey: "cam1:0:1", PersonID: "p1",
		PersonName: "Alice", Similarity: 0.5, StartedAt: 1000, ThumbPath: "/t/x.jpg"}
	created, err := d.CreateEvent(e)
	if err != nil || !created {
		t.Fatalf("create: created=%v err=%v", created, err)
	}
	if e.ID == "" {
		t.Fatal("expected generated ID")
	}
	got, ok, err := d.GetEvent(e.ID)
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.PersonName != "Alice" || got.StartedAt != 1000 || got.ThumbPath != "/t/x.jpg" {
		t.Fatalf("roundtrip mismatch: %+v", got)
	}
	byKey, ok, _ := d.GetEventByTrackKey("cam1:0:1")
	if !ok || byKey.ID != e.ID {
		t.Fatalf("by track key: ok=%v", ok)
	}
}

func TestDuplicateTrackKeyIgnored(t *testing.T) {
	d := testDB(t)
	if created, _ := d.CreateEvent(mkEvent("k1", 1)); !created {
		t.Fatal("first insert should create")
	}
	created, err := d.CreateEvent(mkEvent("k1", 2))
	if err != nil {
		t.Fatalf("dup err: %v", err)
	}
	if created {
		t.Fatal("duplicate track_key must be ignored")
	}
}

func TestIdentityCloseClipLabel(t *testing.T) {
	d := testDB(t)
	e := mkEvent("k1", 1000)
	d.CreateEvent(e)
	if err := d.UpdateEventIdentity(e.ID, "p9", "Bob", 0.61); err != nil {
		t.Fatal(err)
	}
	emb := []byte{1, 2, 3, 4}
	if err := d.CloseEvent(e.ID, 2000, "/t/new.jpg", emb); err != nil {
		t.Fatal(err)
	}
	if err := d.SetEventClip(e.ID, "/c/e.mp4", 999999); err != nil {
		t.Fatal(err)
	}
	if err := d.LabelEvent(e.ID, "p9"); err != nil {
		t.Fatal(err)
	}
	got, _, _ := d.GetEvent(e.ID)
	if got.PersonID != "p9" || got.PersonName != "Bob" || got.Similarity != 0.61 {
		t.Fatalf("identity: %+v", got)
	}
	if got.EndedAt != 2000 || got.ThumbPath != "/t/new.jpg" || string(got.Embedding) != string(emb) {
		t.Fatalf("close: %+v", got)
	}
	if got.ClipPath != "/c/e.mp4" || got.ClipExpiresAt != 999999 || got.ClipExpired {
		t.Fatalf("clip: %+v", got)
	}
	if got.LabeledPersonID != "p9" {
		t.Fatalf("label: %+v", got)
	}
}

func TestCloseEventPreservesThumbAndEmbeddingWhenEmpty(t *testing.T) {
	d := testDB(t)
	e := &Event{CameraID: "c", TrackKey: "k", StartedAt: 1, ThumbPath: "/t/orig.jpg"}
	d.CreateEvent(e)
	if err := d.CloseEvent(e.ID, 5, "", nil); err != nil {
		t.Fatal(err)
	}
	got, _, _ := d.GetEvent(e.ID)
	if got.ThumbPath != "/t/orig.jpg" {
		t.Fatalf("thumb clobbered: %+v", got)
	}
}

func TestListEventsFilters(t *testing.T) {
	d := testDB(t)
	a := &Event{CameraID: "cam1", TrackKey: "k1", PersonID: "p1", StartedAt: 100}
	b := &Event{CameraID: "cam2", TrackKey: "k2", StartedAt: 200} // unknown
	c := &Event{CameraID: "cam1", TrackKey: "k3", StartedAt: 300} // unknown
	for _, e := range []*Event{a, b, c} {
		d.CreateEvent(e)
	}
	d.LabelEvent(c.ID, "p1")

	all, err := d.ListEvents(EventFilter{})
	if err != nil || len(all) != 3 {
		t.Fatalf("all: %d %v", len(all), err)
	}
	if all[0].StartedAt != 300 { // DESC order
		t.Fatalf("order: %+v", all[0])
	}
	cam1, _ := d.ListEvents(EventFilter{CameraID: "cam1"})
	if len(cam1) != 2 {
		t.Fatalf("cam1: %d", len(cam1))
	}
	p1, _ := d.ListEvents(EventFilter{PersonID: "p1"})
	if len(p1) != 2 { // person_id match + labeled match
		t.Fatalf("p1: %d", len(p1))
	}
	unk, _ := d.ListEvents(EventFilter{UnknownOnly: true})
	if len(unk) != 1 || unk[0].ID != b.ID {
		t.Fatalf("unknown: %d", len(unk))
	}
	page, _ := d.ListEvents(EventFilter{Before: 300, Limit: 1})
	if len(page) != 1 || page[0].StartedAt != 200 {
		t.Fatalf("pagination: %+v", page)
	}
	ranged, _ := d.ListEvents(EventFilter{From: 150, To: 250})
	if len(ranged) != 1 || ranged[0].StartedAt != 200 {
		t.Fatalf("range: %d", len(ranged))
	}
}

func TestRetentionQueries(t *testing.T) {
	d := testDB(t)
	old := &Event{CameraID: "c", TrackKey: "k1", StartedAt: 100}
	fresh := &Event{CameraID: "c", TrackKey: "k2", StartedAt: 5000}
	d.CreateEvent(old)
	d.CreateEvent(fresh)
	d.SetEventClip(old.ID, "/c/old.mp4", 150)
	d.SetEventClip(fresh.ID, "/c/new.mp4", 9000)

	expired, err := d.ListExpiredClips(151)
	if err != nil || len(expired) != 1 || expired[0].ID != old.ID {
		t.Fatalf("expired: %d %v", len(expired), err)
	}
	if err := d.MarkClipExpired(old.ID); err != nil {
		t.Fatal(err)
	}
	expired, _ = d.ListExpiredClips(151)
	if len(expired) != 0 {
		t.Fatal("marked clip should not reappear")
	}
	got, _, _ := d.GetEvent(old.ID)
	if !got.ClipExpired {
		t.Fatal("clip_expired not set")
	}

	before, _ := d.ListEventsBefore(1000)
	if len(before) != 1 || before[0].ID != old.ID {
		t.Fatalf("before: %d", len(before))
	}
	if err := d.DeleteEvent(old.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := d.GetEvent(old.ID); ok {
		t.Fatal("event not deleted")
	}
}

func TestListUnknownWithEmbeddings(t *testing.T) {
	d := testDB(t)
	u1 := &Event{CameraID: "c", TrackKey: "k1", StartedAt: 1, Embedding: []byte{1, 2, 3, 4}}
	u2 := &Event{CameraID: "c", TrackKey: "k2", StartedAt: 2}                          // no embedding
	k := &Event{CameraID: "c", TrackKey: "k3", StartedAt: 3, PersonID: "p1", Embedding: []byte{5, 6, 7, 8}} // known
	for _, e := range []*Event{u1, u2, k} {
		d.CreateEvent(e)
	}
	got, err := d.ListUnknownWithEmbeddings()
	if err != nil || len(got) != 1 || got[0].ID != u1.ID {
		t.Fatalf("unknown w/ emb: %d %v", len(got), err)
	}
}

func TestLastSeenPerson(t *testing.T) {
	d := testDB(t)
	mk := func(key, personID, labeled string, startedAt int64, camera string) {
		t.Helper()
		if _, err := d.CreateEvent(&Event{
			CameraID: camera, TrackKey: key,
			PersonID: personID, LabeledPersonID: labeled, StartedAt: startedAt,
		}); err != nil {
			t.Fatal(err)
		}
	}
	mk("k1", "alice", "", 1000, "cam1")
	mk("k2", "alice", "", 5000, "cam2") // most recent, different camera
	mk("k3", "", "alice", 3000, "cam1") // labeled counts too
	mk("k4", "bob", "", 9000, "cam1")   // other person

	ts, ok, err := d.LastSeenPerson("alice", 10000)
	if err != nil || !ok || ts != 5000 {
		t.Fatalf("got ts=%d ok=%v err=%v, want 5000 true", ts, ok, err)
	}
	// beforeMs excludes events at or after it — the current event never counts.
	ts, ok, err = d.LastSeenPerson("alice", 5000)
	if err != nil || !ok || ts != 3000 {
		t.Fatalf("got ts=%d ok=%v err=%v, want 3000 true", ts, ok, err)
	}
	_, ok, err = d.LastSeenPerson("carol", 10000)
	if err != nil || ok {
		t.Fatalf("unseen person: ok=%v err=%v, want false", ok, err)
	}
}

func TestLastSeenUnknownPerCamera(t *testing.T) {
	d := testDB(t)
	mk := func(key, personID, labeled string, startedAt int64, camera string) {
		t.Helper()
		if _, err := d.CreateEvent(&Event{
			CameraID: camera, TrackKey: key,
			PersonID: personID, LabeledPersonID: labeled, StartedAt: startedAt,
		}); err != nil {
			t.Fatal(err)
		}
	}
	mk("u1", "", "", 1000, "cam1")
	mk("u2", "", "", 4000, "cam2")      // other camera must not count
	mk("u3", "alice", "", 6000, "cam1") // known must not count
	mk("u4", "", "bob", 7000, "cam1")   // labeled unknown must not count

	ts, ok, err := d.LastSeenUnknown("cam1", 10000)
	if err != nil || !ok || ts != 1000 {
		t.Fatalf("got ts=%d ok=%v err=%v, want 1000 true", ts, ok, err)
	}
	_, ok, err = d.LastSeenUnknown("cam3", 10000)
	if err != nil || ok {
		t.Fatalf("camera with no unknowns: ok=%v, want false", ok)
	}
}
