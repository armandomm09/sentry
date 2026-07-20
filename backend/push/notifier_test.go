package push

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/dim/sentry/backend/db"
)

type nameStore struct{}

func (nameStore) GetCameraName(id string) string { return "Front Door" }

func newTestNotifier(t *testing.T) (*Notifier, *db.DB) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	n := NewNotifier(d, nameStore{})
	n.loc = time.UTC // deterministic first_of_day tests
	return n, d
}

func sub(userID, knownMode, unknownMode string, quietHours float64) *db.PushSubscription {
	return &db.PushSubscription{
		UserID:            userID,
		ExpoPushToken:     "tok-" + userID,
		CameraIDs:         []string{},
		NotifyKnown:       true,
		NotifyUnknown:     true,
		NotifyKnownMode:   knownMode,
		NotifyUnknownMode: unknownMode,
		KnownQuietHours:   quietHours,
		UnknownQuietHours: quietHours,
	}
}

func TestBuildBatchPolicyMatrix(t *testing.T) {
	n, d := newTestNotifier(t)
	for _, s := range []*db.PushSubscription{
		sub("every", ModeEvery, ModeEvery, 4),
		sub("quiet", ModeQuietPeriod, ModeQuietPeriod, 4),
		sub("daily", ModeFirstOfDay, ModeFirstOfDay, 0),
	} {
		if err := d.UpsertPushSubscription(s); err != nil {
			t.Fatal(err)
		}
	}

	now := time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC).UnixMilli()
	hour := int64(3600 * 1000)
	// Prior sighting of alice 1h ago today: inside quiet window AND same day.
	if _, err := d.CreateEvent(&db.Event{
		CameraID: "cam1", TrackKey: "prev", PersonID: "alice", StartedAt: now - hour,
	}); err != nil {
		t.Fatal(err)
	}

	batch := n.buildBatch(Message{
		CameraID: "cam1", CameraName: "Front Door",
		PersonID: "alice", PersonName: "Alice", IsKnown: true,
		TrackKey: "cur", StartedAt: now,
	})
	// Only the "every" subscription fires; quiet (1h < 4h) and daily (same day) suppress.
	if len(batch) != 1 || batch[0].To != "tok-every" {
		t.Fatalf("batch: %+v", batch)
	}

	// 5h gap, still the same day: quiet fires, daily still suppressed.
	batch = n.buildBatch(Message{
		CameraID: "cam1", PersonID: "alice", PersonName: "Alice", IsKnown: true,
		TrackKey: "cur2", StartedAt: now + 5*hour,
	})
	if len(batch) != 2 {
		t.Fatalf("want every+quiet, got: %+v", batch)
	}
}

func TestBuildBatchUnknownDedupesPerCamera(t *testing.T) {
	n, d := newTestNotifier(t)
	if err := d.UpsertPushSubscription(sub("quiet", ModeQuietPeriod, ModeQuietPeriod, 4)); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC).UnixMilli()
	hour := int64(3600 * 1000)
	// Unknown seen on cam1 an hour ago.
	if _, err := d.CreateEvent(&db.Event{
		CameraID: "cam1", TrackKey: "prev-unk", StartedAt: now - hour,
	}); err != nil {
		t.Fatal(err)
	}

	// Same camera: suppressed.
	batch := n.buildBatch(Message{CameraID: "cam1", IsKnown: false, TrackKey: "c1", StartedAt: now})
	if len(batch) != 0 {
		t.Fatalf("same-camera unknown should be quiet: %+v", batch)
	}
	// Different camera: fires (unknowns dedupe per camera).
	batch = n.buildBatch(Message{CameraID: "cam2", IsKnown: false, TrackKey: "c2", StartedAt: now})
	if len(batch) != 1 {
		t.Fatalf("cross-camera unknown should fire: %+v", batch)
	}
}

func TestBuildBatchIncludesEventID(t *testing.T) {
	n, d := newTestNotifier(t)
	if err := d.UpsertPushSubscription(sub("every", ModeEvery, ModeEvery, 4)); err != nil {
		t.Fatal(err)
	}
	ev := &db.Event{CameraID: "cam1", TrackKey: "tk1", PersonID: "alice", StartedAt: 1000}
	if _, err := d.CreateEvent(ev); err != nil {
		t.Fatal(err)
	}
	batch := n.buildBatch(Message{
		CameraID: "cam1", PersonID: "alice", PersonName: "Alice", IsKnown: true,
		TrackKey: "tk1", StartedAt: 1000,
	})
	if len(batch) != 1 {
		t.Fatalf("batch: %+v", batch)
	}
	if batch[0].Data["event_id"] != ev.ID {
		t.Fatalf("event_id = %q, want %q", batch[0].Data["event_id"], ev.ID)
	}
	if batch[0].Data["type"] != "detection" || batch[0].Data["camera_id"] != "cam1" {
		t.Fatalf("legacy payload fields broken: %+v", batch[0].Data)
	}

	// No matching event row (recorder failed): still notifies, just without event_id.
	batch = n.buildBatch(Message{
		CameraID: "cam1", PersonID: "alice", PersonName: "Alice", IsKnown: true,
		TrackKey: "missing", StartedAt: 99000,
	})
	if len(batch) != 1 {
		t.Fatalf("batch: %+v", batch)
	}
	if _, ok := batch[0].Data["event_id"]; ok {
		t.Fatalf("event_id should be absent when lookup fails: %+v", batch[0].Data)
	}
}

func TestBuildBatchRespectsBaseFilters(t *testing.T) {
	n, d := newTestNotifier(t)
	noKnown := sub("nk", ModeEvery, ModeEvery, 4)
	noKnown.NotifyKnown = false
	otherCam := sub("oc", ModeEvery, ModeEvery, 4)
	otherCam.CameraIDs = []string{"cam9"}
	for _, s := range []*db.PushSubscription{noKnown, otherCam} {
		if err := d.UpsertPushSubscription(s); err != nil {
			t.Fatal(err)
		}
	}
	batch := n.buildBatch(Message{
		CameraID: "cam1", PersonID: "alice", PersonName: "Alice", IsKnown: true,
		TrackKey: "x", StartedAt: 1000,
	})
	if len(batch) != 0 {
		t.Fatalf("base filters must still apply before policy: %+v", batch)
	}
}
