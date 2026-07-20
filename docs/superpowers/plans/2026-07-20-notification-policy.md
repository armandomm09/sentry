# Notification Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-frame 60-second push-notification cooldown with a once-per-event notification on `track_confirmed`, governed by per-subscription policy modes (`every` / `quiet_period` / `first_of_day`) configured independently for known and unknown people, and add `event_id` to the push payload so clients can deep-link to the event.

**Architecture:** The Go backend already receives `track_confirmed` lifecycle messages in `push/listener.go` (routed to the events recorder sink). This phase makes the listener *also* emit one `push.Message` per `track_confirmed` — and stop notifying from the per-frame `detections` path. The `Notifier` evaluates each subscription's policy against "last seen" state read from the existing `events` table (no new tracking state): known people dedupe across all cameras by person id; unknowns (who have no identity) dedupe per camera. Because the listener calls the recorder sink synchronously *before* enqueueing the notification, the event row already exists when the notifier dispatches, so it can look up the `event_id` by `track_key` for the payload.

**Tech Stack:** Go 1.22, Gin, `modernc.org/sqlite` (pure Go; `SetMaxOpenConns(1)`), Expo Push API. Tests use the standard library + real SQLite files in `t.TempDir()` (the established pattern in `backend/db/events_test.go` and `backend/handlers/events_test.go`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-19-face-recognition-reliability-design.md` § 4 — "Notifications fire **once per event**, on `track_confirmed`", modes `every` (default) / `quiet_period` / `first_of_day`, quiet period is per-person across all cameras for knowns and per-camera for unknowns, "'Last seen' state is read from the events table itself; no separate tracking", "`track_updated` (unknown → known) does not send a second notification".
- `first_of_day` uses the server's **local** calendar day (`time.Local` in production; injectable for tests).
- Backwards compatibility: existing SQLite files must migrate in place (SQLite `ALTER TABLE ADD COLUMN`, ignore "duplicate column name"); existing mobile clients keep working — `data.type` stays `"detection"` and `data.camera_id` is unchanged; `event_id` is additive.
- The pre-existing per-subscription filters (`notify_known`, `notify_unknown`, `camera_ids`) still apply *before* the policy mode is evaluated.
- Never `git add -A` / `git add .`. Stage only the files this task touches, by exact path. The user's uncommitted `mobile/eas.json` change must stay uncommitted. Never commit `backend/backend` (tracked build artifact) — if `go build` modifies it, run `git restore backend/backend` before committing.
- Never commit with a failing test. If a test in this plan appears wrong, STOP and report it (plan bug) rather than changing spec'd implementation code to make it pass.
- Run all Go commands from `/Users/armando/Progra/ai/dim/monitoring/backend` (absolute `cd` first — shell cwd may have drifted).

---

### Task 1: Push-subscription policy columns + migration

**Files:**
- Modify: `backend/db/db.go`
- Test: `backend/db/push_test.go` (create)

**Interfaces:**
- Produces: `db.PushSubscription` gains fields `NotifyKnownMode string`, `NotifyUnknownMode string`, `KnownQuietHours float64`, `UnknownQuietHours float64` (JSON tags `notify_known_mode`, `notify_unknown_mode`, `known_quiet_hours`, `unknown_quiet_hours`). `UpsertPushSubscription`, `GetPushSubscription`, `ListPushSubscriptions` keep their exact signatures but round-trip the new fields. DB defaults for pre-existing rows: modes `'every'`, quiet hours `4`.

- [ ] **Step 1: Write the failing test**

Create `backend/db/push_test.go`:

```go
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/armando/Progra/ai/dim/monitoring/backend && go test ./db/ -run TestPushSubscription -v`
Expected: compile error — `unknown field NotifyKnownMode in struct literal`.

- [ ] **Step 3: Implement**

In `backend/db/db.go`:

3a. Add `"strings"` to the imports.

3b. Extend the struct (replace the existing `PushSubscription` declaration):

```go
type PushSubscription struct {
	UserID            string   `json:"user_id"`
	ExpoPushToken     string   `json:"expo_push_token"`
	CameraIDs         []string `json:"camera_ids"`
	NotifyKnown       bool     `json:"notify_known"`
	NotifyUnknown     bool     `json:"notify_unknown"`
	NotifyKnownMode   string   `json:"notify_known_mode"`   // every | quiet_period | first_of_day
	NotifyUnknownMode string   `json:"notify_unknown_mode"` // every | quiet_period | first_of_day
	KnownQuietHours   float64  `json:"known_quiet_hours"`
	UnknownQuietHours float64  `json:"unknown_quiet_hours"`
	UpdatedAt         string   `json:"updated_at"`
}
```

3c. Extend the `push_subscriptions` CREATE in the `schema` const (fresh installs get the columns directly):

```go
CREATE TABLE IF NOT EXISTS push_subscriptions (
	user_id        TEXT PRIMARY KEY,
	expo_push_token TEXT NOT NULL,
	camera_ids     TEXT NOT NULL DEFAULT '[]',
	notify_known   INTEGER NOT NULL DEFAULT 1,
	notify_unknown INTEGER NOT NULL DEFAULT 1,
	notify_known_mode   TEXT NOT NULL DEFAULT 'every',
	notify_unknown_mode TEXT NOT NULL DEFAULT 'every',
	known_quiet_hours   REAL NOT NULL DEFAULT 4,
	unknown_quiet_hours REAL NOT NULL DEFAULT 4,
	updated_at     TEXT NOT NULL
);
```

3d. In `Open`, after the `eventsSchema` Exec, run the upgrade ALTERs (they no-op with "duplicate column name" on fresh installs and already-migrated files):

```go
	// In-place upgrades for databases created before the notification-policy
	// columns existed. SQLite has no ADD COLUMN IF NOT EXISTS; a duplicate
	// column error means the column is already there.
	migrations := []string{
		`ALTER TABLE push_subscriptions ADD COLUMN notify_known_mode TEXT NOT NULL DEFAULT 'every'`,
		`ALTER TABLE push_subscriptions ADD COLUMN notify_unknown_mode TEXT NOT NULL DEFAULT 'every'`,
		`ALTER TABLE push_subscriptions ADD COLUMN known_quiet_hours REAL NOT NULL DEFAULT 4`,
		`ALTER TABLE push_subscriptions ADD COLUMN unknown_quiet_hours REAL NOT NULL DEFAULT 4`,
	}
	for _, m := range migrations {
		if _, err := q.Exec(m); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return nil, fmt.Errorf("db migrate push policy: %w", err)
		}
	}
```

3e. `UpsertPushSubscription` — write the new columns (full replacement body):

```go
func (d *DB) UpsertPushSubscription(sub *PushSubscription) error {
	cameraIDsJSON, err := json.Marshal(sub.CameraIDs)
	if err != nil {
		return err
	}
	notifyKnownInt := 0
	if sub.NotifyKnown {
		notifyKnownInt = 1
	}
	notifyUnknownInt := 0
	if sub.NotifyUnknown {
		notifyUnknownInt = 1
	}
	sub.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	_, err = d.q.Exec(`
		INSERT INTO push_subscriptions (user_id, expo_push_token, camera_ids,
			notify_known, notify_unknown, notify_known_mode, notify_unknown_mode,
			known_quiet_hours, unknown_quiet_hours, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(user_id) DO UPDATE SET
			expo_push_token=excluded.expo_push_token,
			camera_ids=excluded.camera_ids,
			notify_known=excluded.notify_known,
			notify_unknown=excluded.notify_unknown,
			notify_known_mode=excluded.notify_known_mode,
			notify_unknown_mode=excluded.notify_unknown_mode,
			known_quiet_hours=excluded.known_quiet_hours,
			unknown_quiet_hours=excluded.unknown_quiet_hours,
			updated_at=excluded.updated_at`,
		sub.UserID, sub.ExpoPushToken, string(cameraIDsJSON),
		notifyKnownInt, notifyUnknownInt, sub.NotifyKnownMode, sub.NotifyUnknownMode,
		sub.KnownQuietHours, sub.UnknownQuietHours, sub.UpdatedAt,
	)
	return err
}
```

3f. `GetPushSubscription` — read the new columns (full replacement body):

```go
func (d *DB) GetPushSubscription(userID string) (*PushSubscription, bool, error) {
	sub := &PushSubscription{}
	var cameraIDsJSON string
	var notifyKnownInt, notifyUnknownInt int
	err := d.q.QueryRow(
		`SELECT user_id, expo_push_token, camera_ids, notify_known, notify_unknown,
			notify_known_mode, notify_unknown_mode, known_quiet_hours, unknown_quiet_hours,
			updated_at
		FROM push_subscriptions WHERE user_id=?`,
		userID,
	).Scan(&sub.UserID, &sub.ExpoPushToken, &cameraIDsJSON, &notifyKnownInt, &notifyUnknownInt,
		&sub.NotifyKnownMode, &sub.NotifyUnknownMode, &sub.KnownQuietHours, &sub.UnknownQuietHours,
		&sub.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if err := json.Unmarshal([]byte(cameraIDsJSON), &sub.CameraIDs); err != nil {
		sub.CameraIDs = []string{}
	}
	sub.NotifyKnown = notifyKnownInt != 0
	sub.NotifyUnknown = notifyUnknownInt != 0
	return sub, true, nil
}
```

3g. `ListPushSubscriptions` — same additions (full replacement body):

```go
func (d *DB) ListPushSubscriptions() ([]*PushSubscription, error) {
	rows, err := d.q.Query(`SELECT user_id, expo_push_token, camera_ids,
		notify_known, notify_unknown, notify_known_mode, notify_unknown_mode,
		known_quiet_hours, unknown_quiet_hours
		FROM push_subscriptions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var subs []*PushSubscription
	for rows.Next() {
		sub := &PushSubscription{}
		var cameraIDsJSON string
		var notifyKnownInt, notifyUnknownInt int
		if err := rows.Scan(&sub.UserID, &sub.ExpoPushToken, &cameraIDsJSON,
			&notifyKnownInt, &notifyUnknownInt, &sub.NotifyKnownMode, &sub.NotifyUnknownMode,
			&sub.KnownQuietHours, &sub.UnknownQuietHours); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(cameraIDsJSON), &sub.CameraIDs); err != nil {
			sub.CameraIDs = []string{}
		}
		sub.NotifyKnown = notifyKnownInt != 0
		sub.NotifyUnknown = notifyUnknownInt != 0
		subs = append(subs, sub)
	}
	return subs, rows.Err()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/armando/Progra/ai/dim/monitoring/backend && go test ./db/ -v`
Expected: all `TestPushSubscription*` PASS and the pre-existing events tests still PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/armando/Progra/ai/dim/monitoring
git add backend/db/db.go backend/db/push_test.go
git commit -m "feat(push): per-subscription notification policy columns"
```

---

### Task 2: Last-seen queries on the events table

**Files:**
- Modify: `backend/db/events.go`
- Test: `backend/db/events_test.go` (append)

**Interfaces:**
- Consumes: the `events` table and `Event` struct as they exist today (Phase 2).
- Produces: two methods used by Task 4:
  - `func (d *DB) LastSeenPerson(personID string, beforeMs int64) (int64, bool, error)` — max `started_at` over events where `person_id=? OR labeled_person_id=?` and `started_at < beforeMs`, **any camera**. `false` when the person has never been seen before.
  - `func (d *DB) LastSeenUnknown(cameraID string, beforeMs int64) (int64, bool, error)` — same but `person_id='' AND labeled_person_id=''` and **restricted to one camera**.
  - Passing the current event's own `started_at` as `beforeMs` excludes the current event (strict `<`), so callers never dedupe against the sighting they are notifying about.

- [ ] **Step 1: Write the failing test**

Append to `backend/db/events_test.go` (it already has an `openTestDB`-equivalent helper — reuse whatever helper that file defines for opening a temp DB; if it opens inline, do the same):

```go
func TestLastSeenPerson(t *testing.T) {
	d := openTestDB(t)
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
	d := openTestDB(t)
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
```

Note: if `events_test.go` has no `openTestDB` helper, Task 1 added one in `push_test.go` in the same package — use that.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/armando/Progra/ai/dim/monitoring/backend && go test ./db/ -run TestLastSeen -v`
Expected: compile error — `d.LastSeenPerson undefined`.

- [ ] **Step 3: Implement**

Append to `backend/db/events.go`:

```go
// LastSeenPerson returns the started_at of the person's most recent event that
// began strictly before beforeMs, across all cameras. Labeled unknowns count.
// Pass the current event's started_at as beforeMs so it never matches itself.
func (d *DB) LastSeenPerson(personID string, beforeMs int64) (int64, bool, error) {
	var ts sql.NullInt64
	err := d.q.QueryRow(`SELECT MAX(started_at) FROM events
		WHERE (person_id=? OR labeled_person_id=?) AND started_at<?`,
		personID, personID, beforeMs).Scan(&ts)
	if err != nil {
		return 0, false, err
	}
	return ts.Int64, ts.Valid, nil
}

// LastSeenUnknown returns the started_at of the most recent still-unlabeled
// unknown sighting on one camera that began strictly before beforeMs.
// Unknowns have no identity to dedupe on, so the quiet period is per camera.
func (d *DB) LastSeenUnknown(cameraID string, beforeMs int64) (int64, bool, error) {
	var ts sql.NullInt64
	err := d.q.QueryRow(`SELECT MAX(started_at) FROM events
		WHERE person_id='' AND labeled_person_id='' AND camera_id=? AND started_at<?`,
		cameraID, beforeMs).Scan(&ts)
	if err != nil {
		return 0, false, err
	}
	return ts.Int64, ts.Valid, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/armando/Progra/ai/dim/monitoring/backend && go test ./db/ -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/armando/Progra/ai/dim/monitoring
git add backend/db/events.go backend/db/events_test.go
git commit -m "feat(events): last-seen queries for notification policy"
```

---

### Task 3: Pure policy evaluator

**Files:**
- Create: `backend/push/policy.go`
- Test: `backend/push/policy_test.go` (create)

**Interfaces:**
- Produces (used by Task 4):
  - Constants `ModeEvery = "every"`, `ModeQuietPeriod = "quiet_period"`, `ModeFirstOfDay = "first_of_day"`, and `func ValidMode(m string) bool` (accepts the three constants; exported because the handler in Task 6 validates input with it).
  - `func policyAllows(mode string, quietHours float64, lastSeenMs int64, hasLastSeen bool, startedAtMs int64, loc *time.Location) bool` — pure, no I/O.

- [ ] **Step 1: Write the failing test**

Create `backend/push/policy_test.go`:

```go
package push

import (
	"testing"
	"time"
)

func TestPolicyAllows(t *testing.T) {
	loc := time.FixedZone("test", -6*3600) // UTC-6, DST-free
	// 2026-07-20 12:00:00 local
	noon := time.Date(2026, 7, 20, 12, 0, 0, 0, loc).UnixMilli()
	hour := int64(3600 * 1000)

	cases := []struct {
		name        string
		mode        string
		quietHours  float64
		lastSeen    int64
		hasLastSeen bool
		want        bool
	}{
		{"every always fires", ModeEvery, 4, noon - hour, true, true},
		{"unrecognized mode behaves as every", "bogus", 4, noon - hour, true, true},
		{"quiet: first sighting ever fires", ModeQuietPeriod, 4, 0, false, true},
		{"quiet: seen 1h ago inside 4h window suppresses", ModeQuietPeriod, 4, noon - hour, true, false},
		{"quiet: seen exactly 4h ago suppresses (strictly more than)", ModeQuietPeriod, 4, noon - 4*hour, true, false},
		{"quiet: seen 5h ago fires", ModeQuietPeriod, 4, noon - 5*hour, true, true},
		{"quiet: fractional hours honored", ModeQuietPeriod, 0.5, noon - hour, true, true},
		{"first_of_day: first sighting ever fires", ModeFirstOfDay, 0, 0, false, true},
		{"first_of_day: already seen today suppresses", ModeFirstOfDay, 0, noon - 2*hour, true, false},
		{"first_of_day: seen yesterday 23:59 local fires", ModeFirstOfDay, 0,
			time.Date(2026, 7, 19, 23, 59, 0, 0, loc).UnixMilli(), true, true},
		{"first_of_day: seen today 00:00 local suppresses", ModeFirstOfDay, 0,
			time.Date(2026, 7, 20, 0, 0, 0, 0, loc).UnixMilli(), true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := policyAllows(tc.mode, tc.quietHours, tc.lastSeen, tc.hasLastSeen, noon, loc)
			if got != tc.want {
				t.Fatalf("policyAllows = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestValidMode(t *testing.T) {
	for _, m := range []string{ModeEvery, ModeQuietPeriod, ModeFirstOfDay} {
		if !ValidMode(m) {
			t.Fatalf("%q should be valid", m)
		}
	}
	for _, m := range []string{"", "bogus", "EVERY"} {
		if ValidMode(m) {
			t.Fatalf("%q should be invalid", m)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/armando/Progra/ai/dim/monitoring/backend && go test ./push/ -run 'TestPolicyAllows|TestValidMode' -v`
Expected: compile error — `undefined: ModeEvery`.

- [ ] **Step 3: Implement**

Create `backend/push/policy.go`:

```go
package push

import "time"

// Notification policy modes (spec § 4). Stored per subscription, independently
// for known and unknown people.
const (
	ModeEvery       = "every"        // every event (default)
	ModeQuietPeriod = "quiet_period" // only if not seen for more than quietHours
	ModeFirstOfDay  = "first_of_day" // first event per local calendar day
)

// ValidMode reports whether m is a recognized policy mode. Used by the
// registration handler to reject bad input; the evaluator itself treats
// unrecognized modes as ModeEvery so a corrupt row can never mute alerts.
func ValidMode(m string) bool {
	return m == ModeEvery || m == ModeQuietPeriod || m == ModeFirstOfDay
}

// policyAllows decides whether one subscription's mode permits notifying about
// an event that started at startedAtMs. lastSeenMs is the previous sighting of
// the same person (any camera) or, for unknowns, the same camera; it is
// ignored when hasLastSeen is false — a first-ever sighting always notifies.
func policyAllows(mode string, quietHours float64, lastSeenMs int64, hasLastSeen bool, startedAtMs int64, loc *time.Location) bool {
	switch mode {
	case ModeQuietPeriod:
		if !hasLastSeen {
			return true
		}
		quiet := time.Duration(quietHours * float64(time.Hour))
		return time.UnixMilli(startedAtMs).Sub(time.UnixMilli(lastSeenMs)) > quiet
	case ModeFirstOfDay:
		if !hasLastSeen {
			return true
		}
		t := time.UnixMilli(startedAtMs).In(loc)
		dayStart := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, loc)
		return lastSeenMs < dayStart.UnixMilli()
	default: // ModeEvery and anything unrecognized
		return true
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/armando/Progra/ai/dim/monitoring/backend && go test ./push/ -v`
Expected: new tests PASS; pre-existing listener tests still PASS (nothing else changed yet).

- [ ] **Step 5: Commit**

```bash
cd /Users/armando/Progra/ai/dim/monitoring
git add backend/push/policy.go backend/push/policy_test.go
git commit -m "feat(push): pure notification-policy evaluator"
```

---

### Task 4: Policy-aware Notifier dispatch + event_id in payload

**Files:**
- Modify: `backend/push/notifier.go`
- Test: `backend/push/notifier_test.go` (create)

**Interfaces:**
- Consumes: Task 1 subscription fields, Task 2 `LastSeenPerson`/`LastSeenUnknown`, Task 3 `policyAllows`.
- Produces (used by Task 5): extended `Message` struct —

  ```go
  type Message struct {
  	CameraID   string
  	CameraName string
  	PersonID   string // empty = unknown
  	PersonName string // empty = unknown
  	IsKnown    bool
  	TrackKey   string // lifecycle track key; resolves event_id at dispatch time
  	StartedAt  int64  // event start, unix ms
  }
  ```

  `Notifier` gains unexported fields `loc *time.Location` (set to `time.Local` in `NewNotifier`) and method `buildBatch(msg Message) []expoMessage`; `dispatch` becomes "buildBatch then send in chunks of 100". Public API (`NewNotifier`, `Start`, `Send`) is unchanged.

- [ ] **Step 1: Write the failing test**

Create `backend/push/notifier_test.go`:

```go
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/armando/Progra/ai/dim/monitoring/backend && go test ./push/ -run TestBuildBatch -v`
Expected: compile error — `unknown field PersonID`/`TrackKey` in `Message`, `n.buildBatch undefined`.

- [ ] **Step 3: Implement**

In `backend/push/notifier.go`:

3a. Replace the `Message` struct:

```go
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
```

3b. Add `loc *time.Location` to `Notifier` and set it in the constructor:

```go
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
```

3c. Replace `dispatch` with buildBatch + chunked send:

```go
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
```

`shouldNotify` and `buildBody` are unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/armando/Progra/ai/dim/monitoring/backend && go test ./push/ -v`
Expected: new notifier tests PASS. **Known state:** `listener.go` still compiles because `handleDetections` sets only fields that still exist (`CameraID`, `CameraName`, `PersonName`, `IsKnown`) — Task 5 replaces that path. `go build ./...` must succeed.

- [ ] **Step 5: Commit**

```bash
cd /Users/armando/Progra/ai/dim/monitoring
git add backend/push/notifier.go backend/push/notifier_test.go
git commit -m "feat(push): policy-aware dispatch with event_id payload"
```

---

### Task 5: Notify once per event on track_confirmed; delete the cooldown path

**Files:**
- Modify: `backend/push/listener.go`
- Test: `backend/push/listener_test.go` (rewrite two tests, keep two)

**Interfaces:**
- Consumes: Task 4 `Message` fields (`PersonID`, `TrackKey`, `StartedAt`).
- Produces: `Listener.handleMessage` sends exactly one `Message` per `track_confirmed` (after forwarding to the lifecycle sink); `detections`, `track_updated`, and `track_ended` never notify. The `lastSent` cooldown map is deleted. `NewListener`, `WatchCamera`, `EnsureWatching`, `SetLifecycleSink` signatures unchanged.

- [ ] **Step 1: Update the tests (failing first)**

In `backend/push/listener_test.go`:

1a. **Delete** `TestDetectionsStillNotify` and replace with:

```go
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
```

1b. **Replace** `TestLifecycleGoesToSinkNotNotifier` with (the sink contract is unchanged, but `track_confirmed` now also notifies — assert both):

```go
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
```

Keep `TestEnsureWatchingIsIdempotent` and `TestNilSinkAndGarbageAreSafe` as they are.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/armando/Progra/ai/dim/monitoring/backend && go test ./push/ -run 'TestDetectionsDoNotNotify|TestTrackConfirmedNotifiesOnce|TestLifecycleGoesToSink' -v`
Expected: FAIL — `TestDetectionsDoNotNotify` sees an unwanted notification; `TestTrackConfirmedNotifiesOnce` sees none.

- [ ] **Step 3: Implement**

In `backend/push/listener.go`:

3a. Replace the message structs at the top (the detections structs shrink to what routing still needs):

```go
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

// trackConfirmedMsg mirrors face-service lifecycle.py's track_confirmed
// payload (only the fields notifications need).
type trackConfirmedMsg struct {
	TrackKey string  `json:"track_key"`
	TS       float64 `json:"ts"`
	PersonID *string `json:"person_id"`
	Name     *string `json:"name"`
}
```

3b. Delete the cooldown state: remove `lastSent map[string]time.Time` from the `Listener` struct, remove its initialization in `NewListener`, and remove the `"time"` import **only if** nothing else in the file uses it (the reconnect loop uses `time.Sleep` — keep the import).

3c. Replace the `switch` in `handleMessage`:

```go
	switch frame.Type {
	case "track_confirmed", "track_updated", "track_ended":
		l.sinkMu.RLock()
		sink := l.sink
		l.sinkMu.RUnlock()
		if sink != nil {
			// Synchronous: the events recorder persists the row before we
			// enqueue the notification, so dispatch can resolve event_id.
			sink(msg)
		}
		if frame.Type == "track_confirmed" {
			l.notifyConfirmed(cameraID, msg)
		}
	}
```

(The `"detections"` case is gone — per-frame detections still stream to WS viewers via the face-service proxy; the Go listener just no longer notifies on them.)

3d. Replace `handleDetections` with `notifyConfirmed`:

```go
// notifyConfirmed emits exactly one notification per confirmed track.
// Policy filtering (every / quiet_period / first_of_day) happens in the
// Notifier, which reads last-seen state from the events table.
func (l *Listener) notifyConfirmed(cameraID string, raw []byte) {
	var m trackConfirmedMsg
	if err := json.Unmarshal(raw, &m); err != nil || m.TrackKey == "" {
		return
	}
	personID, name := "", ""
	if m.PersonID != nil {
		personID = *m.PersonID
	}
	if m.Name != nil {
		name = *m.Name
	}
	l.notifier.Send(Message{
		CameraID:   cameraID,
		CameraName: l.store.GetCameraName(cameraID),
		PersonID:   personID,
		PersonName: name,
		IsKnown:    personID != "",
		TrackKey:   m.TrackKey,
		StartedAt:  int64(m.TS * 1000),
	})
}
```

Note: `detectionFrame`/`detection` are still referenced by `handleMessage`'s envelope unmarshal — if after your edit the `detection` struct is truly unused, delete it and shrink `detectionFrame` to `{ Type string \`json:"type"\` }`. `go vet` must be clean either way.

- [ ] **Step 4: Run tests and build to verify**

Run: `cd /Users/armando/Progra/ai/dim/monitoring/backend && go test ./push/ -v && go build ./... && go vet ./...`
Expected: all PASS, clean build and vet. If `go build` modifies `backend/backend`, run `git restore backend/backend`.

- [ ] **Step 5: Commit**

```bash
cd /Users/armando/Progra/ai/dim/monitoring
git add backend/push/listener.go backend/push/listener_test.go
git commit -m "feat(push): notify once per event on track_confirmed, drop 60s cooldown"
```

---

### Task 6: Registration API accepts policy settings + docs

**Files:**
- Modify: `backend/handlers/push.go`
- Test: `backend/handlers/push_test.go` (create)
- Modify: `CLAUDE.md` (push bullet + data-flow step 5)
- Modify: `.env.example` (comment note only — policy is per-subscription, not env)

**Interfaces:**
- Consumes: Task 1 `db.PushSubscription` fields, Task 3 `push.ValidMode`.
- Produces: `POST /api/push/register` accepts optional `notify_known_mode`, `notify_unknown_mode` (must satisfy `push.ValidMode`; empty defaults to `"every"`), `known_quiet_hours`, `unknown_quiet_hours` (must be `>= 0`; `0`/omitted defaults to `4`). Invalid values → 400 with a JSON `error` string. Response echoes the stored subscription (unchanged shape + new fields).

- [ ] **Step 1: Write the failing test**

Create `backend/handlers/push_test.go`:

```go
package handlers

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/dim/sentry/backend/auth"
	"github.com/dim/sentry/backend/db"
	"github.com/gin-gonic/gin"
)

func setupPush(t *testing.T) (*gin.Engine, *db.DB) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	h := NewPushHandler(d)
	r := gin.New()
	r.Use(func(c *gin.Context) { // stand-in for RequireAuth
		c.Set(auth.CtxClaims, &auth.Claims{UserID: "u1"})
	})
	r.POST("/api/push/register", h.Register)
	return r, d
}

func TestRegisterWithPolicy(t *testing.T) {
	r, d := setupPush(t)
	w := doReq(t, r, "POST", "/api/push/register", map[string]any{
		"expo_push_token":     "tok",
		"notify_known_mode":   "quiet_period",
		"known_quiet_hours":   6,
		"notify_unknown_mode": "first_of_day",
	})
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	sub, found, err := d.GetPushSubscription("u1")
	if err != nil || !found {
		t.Fatalf("found=%v err=%v", found, err)
	}
	if sub.NotifyKnownMode != "quiet_period" || sub.KnownQuietHours != 6 {
		t.Fatalf("known policy: %+v", sub)
	}
	if sub.NotifyUnknownMode != "first_of_day" || sub.UnknownQuietHours != 4 {
		t.Fatalf("unknown policy (quiet hours should default to 4): %+v", sub)
	}
	var resp map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp["notify_known_mode"] != "quiet_period" {
		t.Fatalf("response must echo policy: %v", resp)
	}
}

func TestRegisterDefaultsToEvery(t *testing.T) {
	r, d := setupPush(t)
	w := doReq(t, r, "POST", "/api/push/register", map[string]any{
		"expo_push_token": "tok",
	})
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	sub, _, _ := d.GetPushSubscription("u1")
	if sub.NotifyKnownMode != "every" || sub.NotifyUnknownMode != "every" {
		t.Fatalf("default modes: %+v", sub)
	}
	if sub.KnownQuietHours != 4 || sub.UnknownQuietHours != 4 {
		t.Fatalf("default quiet hours: %+v", sub)
	}
}

func TestRegisterRejectsBadPolicy(t *testing.T) {
	r, _ := setupPush(t)
	for _, body := range []map[string]any{
		{"expo_push_token": "tok", "notify_known_mode": "sometimes"},
		{"expo_push_token": "tok", "notify_unknown_mode": "QUIET_PERIOD"},
		{"expo_push_token": "tok", "known_quiet_hours": -1},
		{"expo_push_token": "tok", "unknown_quiet_hours": -0.5},
	} {
		w := doReq(t, r, "POST", "/api/push/register", body)
		if w.Code != 400 {
			t.Fatalf("body %v: status %d, want 400", body, w.Code)
		}
	}
}
```

(`doReq` already exists in `backend/handlers/events_test.go`, same package.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/armando/Progra/ai/dim/monitoring/backend && go test ./handlers/ -run TestRegister -v`
Expected: FAIL — policy fields silently ignored (modes stay `""` in DB, bad values return 200).

- [ ] **Step 3: Implement**

In `backend/handlers/push.go`, add the import `"github.com/dim/sentry/backend/push"` and replace `Register`:

```go
func (h *PushHandler) Register(c *gin.Context) {
	claims := c.MustGet(auth.CtxClaims).(*auth.Claims)
	var req struct {
		ExpoPushToken     string   `json:"expo_push_token" binding:"required"`
		CameraIDs         []string `json:"camera_ids"`
		NotifyKnown       *bool    `json:"notify_known"`
		NotifyUnknown     *bool    `json:"notify_unknown"`
		NotifyKnownMode   string   `json:"notify_known_mode"`
		NotifyUnknownMode string   `json:"notify_unknown_mode"`
		KnownQuietHours   float64  `json:"known_quiet_hours"`
		UnknownQuietHours float64  `json:"unknown_quiet_hours"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cameraIDs := req.CameraIDs
	if cameraIDs == nil {
		cameraIDs = []string{}
	}
	notifyKnown := true
	if req.NotifyKnown != nil {
		notifyKnown = *req.NotifyKnown
	}
	notifyUnknown := true
	if req.NotifyUnknown != nil {
		notifyUnknown = *req.NotifyUnknown
	}
	knownMode, err := normalizeMode(req.NotifyKnownMode)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "notify_known_mode: " + err.Error()})
		return
	}
	unknownMode, err := normalizeMode(req.NotifyUnknownMode)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "notify_unknown_mode: " + err.Error()})
		return
	}
	knownQuiet, err := normalizeQuietHours(req.KnownQuietHours)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "known_quiet_hours: " + err.Error()})
		return
	}
	unknownQuiet, err := normalizeQuietHours(req.UnknownQuietHours)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown_quiet_hours: " + err.Error()})
		return
	}
	sub := &db.PushSubscription{
		UserID:            claims.UserID,
		ExpoPushToken:     req.ExpoPushToken,
		CameraIDs:         cameraIDs,
		NotifyKnown:       notifyKnown,
		NotifyUnknown:     notifyUnknown,
		NotifyKnownMode:   knownMode,
		NotifyUnknownMode: unknownMode,
		KnownQuietHours:   knownQuiet,
		UnknownQuietHours: unknownQuiet,
	}
	if err := h.db.UpsertPushSubscription(sub); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	c.JSON(http.StatusOK, sub)
}

// normalizeMode maps "" to the default and rejects unrecognized modes.
func normalizeMode(m string) (string, error) {
	if m == "" {
		return push.ModeEvery, nil
	}
	if !push.ValidMode(m) {
		return "", fmt.Errorf("must be one of every, quiet_period, first_of_day")
	}
	return m, nil
}

// normalizeQuietHours maps 0 (omitted) to the 4h default and rejects negatives.
func normalizeQuietHours(h float64) (float64, error) {
	if h < 0 {
		return 0, fmt.Errorf("must be >= 0")
	}
	if h == 0 {
		return 4, nil
	}
	return h, nil
}
```

Also add `"fmt"` to the imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/armando/Progra/ai/dim/monitoring/backend && go test ./... && go vet ./...`
Expected: everything PASS, vet clean. Restore `backend/backend` if `go build` touched it.

- [ ] **Step 5: Update docs**

In `CLAUDE.md`:

5a. Replace the `push/` architecture bullet:

```markdown
- `push/` — `listener.go` subscribes to the face-service detection WebSocket per camera and emits one notification per sighting event on `track_confirmed` (per-frame `detections` never notify); `notifier.go` evaluates each subscription's notification policy — `every` (default), `quiet_period` (suppress if the person was seen less than `known_quiet_hours`/`unknown_quiet_hours` ago; per person across cameras for knowns, per camera for unknowns), `first_of_day` (first sighting per local calendar day) — reading last-seen state from the events table, then sends batched push via the Expo Push API with `event_id` in the payload. Policy is configured per subscription via `POST /api/push/register` (`notify_known_mode`, `notify_unknown_mode`, `known_quiet_hours`, `unknown_quiet_hours`).
```

5b. Replace step 5 of "Data Flow: Detection → Push Notification":

```markdown
5. On `track_confirmed`: `push/Notifier` evaluates each subscription's notification policy (every / quiet_period / first_of_day) against the events table, looks up Expo push tokens from SQLite, and sends batched push via `https://exp.host/push/send` with `event_id` in the payload
```

In `.env.example`, append under the retention block:

```
# Notification policy is per subscription (POST /api/push/register:
# notify_known_mode / notify_unknown_mode = every | quiet_period | first_of_day,
# known_quiet_hours / unknown_quiet_hours), not an env var.
```

- [ ] **Step 6: Commit**

```bash
cd /Users/armando/Progra/ai/dim/monitoring
git add backend/handlers/push.go backend/handlers/push_test.go CLAUDE.md .env.example
git commit -m "feat(push): register API accepts notification policy settings"
```

---

## Self-Review Notes

- **Spec § 4 coverage:** once-per-event on `track_confirmed` → Task 5; three modes per known/unknown per subscription via `POST /api/push/register` → Tasks 1, 3, 6; quiet period per person any-camera / per camera for unknowns → Tasks 2, 4; last-seen from events table, no new state → Task 2; `track_updated` never re-notifies → Task 5 test. Backlog items folded in: `event_id` in payload → Tasks 4; pending-state guard → inherent (lifecycle.py emits `track_confirmed` only for non-pending tracks), asserted by the Task 5 test comment.
- **Type consistency:** `Message{CameraID, CameraName, PersonID, PersonName, IsKnown, TrackKey, StartedAt}` defined in Task 4, consumed in Task 5. `policyAllows(mode, quietHours, lastSeenMs, hasLastSeen, startedAtMs, loc)` defined in Task 3, called in Task 4. `LastSeenPerson/LastSeenUnknown(id, beforeMs) (int64, bool, error)` defined in Task 2, called in Task 4. `ValidMode` defined in Task 3, called in Task 6.
- **Ordering hazard handled:** listener calls the recorder sink synchronously before `notifier.Send`, so the event row exists when `buildBatch` resolves `event_id`; a lookup miss degrades to a payload without `event_id` (tested).
- **Notifier 30s subscription cache:** policy changes may take up to 30s to apply — pre-existing behavior, acceptable.
