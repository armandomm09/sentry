package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func openTestDB(t *testing.T) *DB {
	t.Helper()
	d, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func TestPushSubscriptionPolicyRoundTrip(t *testing.T) {
	d := openTestDB(t)
	sub := &PushSubscription{
		UserID:            "u1",
		ExpoPushToken:     "ExponentPushToken[x]",
		CameraIDs:         []string{"cam1"},
		NotifyKnown:       true,
		NotifyUnknown:     true,
		NotifyKnownMode:   "quiet_period",
		NotifyUnknownMode: "first_of_day",
		KnownQuietHours:   2.5,
		UnknownQuietHours: 12,
	}
	if err := d.UpsertPushSubscription(sub); err != nil {
		t.Fatal(err)
	}
	got, found, err := d.GetPushSubscription("u1")
	if err != nil || !found {
		t.Fatalf("get: found=%v err=%v", found, err)
	}
	if got.NotifyKnownMode != "quiet_period" || got.NotifyUnknownMode != "first_of_day" {
		t.Fatalf("modes: %+v", got)
	}
	if got.KnownQuietHours != 2.5 || got.UnknownQuietHours != 12 {
		t.Fatalf("quiet hours: %+v", got)
	}
	subs, err := d.ListPushSubscriptions()
	if err != nil || len(subs) != 1 {
		t.Fatalf("list: %v %v", subs, err)
	}
	if subs[0].NotifyKnownMode != "quiet_period" || subs[0].UnknownQuietHours != 12 {
		t.Fatalf("list fields: %+v", subs[0])
	}
}

// A database created before this migration (no policy columns) must open
// cleanly and report the defaults for existing rows.
func TestPushSubscriptionMigratesOldSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = raw.Exec(`CREATE TABLE push_subscriptions (
		user_id        TEXT PRIMARY KEY,
		expo_push_token TEXT NOT NULL,
		camera_ids     TEXT NOT NULL DEFAULT '[]',
		notify_known   INTEGER NOT NULL DEFAULT 1,
		notify_unknown INTEGER NOT NULL DEFAULT 1,
		updated_at     TEXT NOT NULL
	);
	INSERT INTO push_subscriptions (user_id, expo_push_token, updated_at)
	VALUES ('u1', 'tok', '2026-01-01T00:00:00Z');`)
	if err != nil {
		t.Fatal(err)
	}
	raw.Close()

	d, err := Open(path)
	if err != nil {
		t.Fatalf("open migrated: %v", err)
	}
	defer d.Close()
	got, found, err := d.GetPushSubscription("u1")
	if err != nil || !found {
		t.Fatalf("get after migrate: found=%v err=%v", found, err)
	}
	if got.NotifyKnownMode != "every" || got.NotifyUnknownMode != "every" {
		t.Fatalf("default modes: %+v", got)
	}
	if got.KnownQuietHours != 4 || got.UnknownQuietHours != 4 {
		t.Fatalf("default quiet hours: %+v", got)
	}
	// Opening twice must be harmless (ALTERs ignored on duplicate).
	d.Close()
	if d2, err := Open(path); err != nil {
		t.Fatalf("reopen: %v", err)
	} else {
		d2.Close()
	}
}
