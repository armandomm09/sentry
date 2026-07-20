package events

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dim/sentry/backend/db"
)

func TestRunOnceExpiresClipsAndDeletesOldEvents(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	files := t.TempDir()

	now := time.UnixMilli(10_000_000)

	// Event with an expired clip (fresh enough to keep the row)
	expiredClip := &db.Event{CameraID: "c", TrackKey: "k1", StartedAt: now.UnixMilli() - 1000}
	d.CreateEvent(expiredClip)
	clipPath := filepath.Join(files, "k1.mp4")
	os.WriteFile(clipPath, []byte("mp4"), 0644)
	d.SetEventClip(expiredClip.ID, clipPath, now.UnixMilli()-1) // already past expiry

	// Event with a live clip
	liveClip := &db.Event{CameraID: "c", TrackKey: "k2", StartedAt: now.UnixMilli() - 1000}
	d.CreateEvent(liveClip)
	livePath := filepath.Join(files, "k2.mp4")
	os.WriteFile(livePath, []byte("mp4"), 0644)
	d.SetEventClip(liveClip.ID, livePath, now.UnixMilli()+1_000_000)

	// Ancient event past event-retention with a thumb file
	ancient := &db.Event{CameraID: "c", TrackKey: "k3",
		StartedAt: now.Add(-91 * 24 * time.Hour).UnixMilli()}
	d.CreateEvent(ancient)
	thumbPath := filepath.Join(files, "k3.jpg")
	os.WriteFile(thumbPath, []byte("jpg"), 0644)
	d.CloseEvent(ancient.ID, ancient.StartedAt+1, thumbPath, nil)

	r := NewRetention(d, 90*24*time.Hour)
	r.NowFn = func() time.Time { return now }

	clips, events := r.RunOnce()
	if clips != 1 || events != 1 {
		t.Fatalf("clips=%d events=%d", clips, events)
	}
	if _, err := os.Stat(clipPath); !os.IsNotExist(err) {
		t.Fatal("expired clip file not deleted")
	}
	if _, err := os.Stat(livePath); err != nil {
		t.Fatal("live clip file must remain")
	}
	if _, err := os.Stat(thumbPath); !os.IsNotExist(err) {
		t.Fatal("ancient event thumb not deleted")
	}
	got, _, _ := d.GetEvent(expiredClip.ID)
	if !got.ClipExpired {
		t.Fatal("clip_expired not set")
	}
	if _, ok, _ := d.GetEvent(ancient.ID); ok {
		t.Fatal("ancient event row not deleted")
	}
	if _, ok, _ := d.GetEvent(liveClip.ID); !ok {
		t.Fatal("fresh event must remain")
	}

	// idempotent
	clips, events = r.RunOnce()
	if clips != 0 || events != 0 {
		t.Fatalf("second run: clips=%d events=%d", clips, events)
	}
}

func TestRunOnceClosesStaleOpenEvents(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	now := time.UnixMilli(100_000_000)

	stale := &db.Event{CameraID: "c", TrackKey: "k-stale",
		StartedAt: now.Add(-time.Hour).UnixMilli()}
	fresh := &db.Event{CameraID: "c", TrackKey: "k-fresh",
		StartedAt: now.Add(-time.Minute).UnixMilli()}
	d.CreateEvent(stale)
	d.CreateEvent(fresh)

	r := NewRetention(d, 90*24*time.Hour)
	r.NowFn = func() time.Time { return now }
	r.RunOnce()

	got, _, _ := d.GetEvent(stale.ID)
	want := stale.StartedAt + (2 * time.Minute).Milliseconds()
	if got.EndedAt != want {
		t.Fatalf("stale ended_at = %d, want %d", got.EndedAt, want)
	}
	got, _, _ = d.GetEvent(fresh.ID)
	if got.EndedAt != 0 {
		t.Fatal("fresh open event must stay open")
	}
}

func TestRunOnceKeepsRowWhenFileDeletionFails(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	files := t.TempDir()

	now := time.UnixMilli(10_000_000)

	lockedDir := filepath.Join(files, "locked")
	if err := os.MkdirAll(lockedDir, 0755); err != nil {
		t.Fatal(err)
	}
	thumb := filepath.Join(lockedDir, "t.jpg")
	if err := os.WriteFile(thumb, []byte("j"), 0644); err != nil {
		t.Fatal(err)
	}
	// Read-only parent dir makes os.Remove fail with a real (non-IsNotExist) error.
	if err := os.Chmod(lockedDir, 0555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(lockedDir, 0755) })

	ancient := &db.Event{CameraID: "c", TrackKey: "k-locked",
		StartedAt: now.Add(-91 * 24 * time.Hour).UnixMilli()}
	d.CreateEvent(ancient)
	d.CloseEvent(ancient.ID, ancient.StartedAt+1, thumb, nil)

	r := NewRetention(d, 90*24*time.Hour)
	r.NowFn = func() time.Time { return now }

	_, events := r.RunOnce()
	if events != 0 {
		t.Fatalf("events deleted = %d, want 0", events)
	}
	if _, ok, _ := d.GetEvent(ancient.ID); !ok {
		t.Fatal("row must survive a failed file deletion so a later pass can retry")
	}
	if _, err := os.Stat(thumb); err != nil {
		t.Fatal("thumb should still exist")
	}
}
