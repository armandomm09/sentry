package db

import (
	"database/sql"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// Event is one sighting: a confirmed track's lifetime on one camera.
// PersonID "" means unknown at close time; LabeledPersonID is set when a user
// later assigns the unknown to a person. Timestamps are unix milliseconds.
type Event struct {
	ID              string
	CameraID        string
	TrackKey        string
	PersonID        string
	PersonName      string
	Similarity      float64
	StartedAt       int64
	EndedAt         int64 // 0 while open
	ThumbPath       string
	ClipPath        string
	ClipExpiresAt   int64
	ClipExpired     bool
	LabeledPersonID string
	Embedding       []byte // best-crop embedding; stored for unknown events only
}

type EventFilter struct {
	CameraID    string
	PersonID    string // matches person_id OR labeled_person_id
	UnknownOnly bool   // person_id='' AND labeled_person_id=''
	From, To    int64  // started_at range; 0 = unbounded
	Before      int64  // pagination cursor: started_at < Before
	Limit       int    // default 50, max 200
}

const eventsSchema = `
CREATE TABLE IF NOT EXISTS events (
	id                TEXT PRIMARY KEY,
	camera_id         TEXT NOT NULL,
	track_key         TEXT NOT NULL UNIQUE,
	person_id         TEXT NOT NULL DEFAULT '',
	person_name       TEXT NOT NULL DEFAULT '',
	similarity        REAL NOT NULL DEFAULT 0,
	started_at        INTEGER NOT NULL,
	ended_at          INTEGER NOT NULL DEFAULT 0,
	thumb_path        TEXT NOT NULL DEFAULT '',
	clip_path         TEXT NOT NULL DEFAULT '',
	clip_expires_at   INTEGER NOT NULL DEFAULT 0,
	clip_expired      INTEGER NOT NULL DEFAULT 0,
	labeled_person_id TEXT NOT NULL DEFAULT '',
	embedding         BLOB
);
CREATE INDEX IF NOT EXISTS idx_events_started ON events(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_person ON events(person_id);
`

const eventCols = `id, camera_id, track_key, person_id, person_name, similarity,
	started_at, ended_at, thumb_path, clip_path, clip_expires_at, clip_expired,
	labeled_person_id, embedding`

func scanEvent(row interface{ Scan(...any) error }) (*Event, error) {
	e := &Event{}
	var expired int
	err := row.Scan(&e.ID, &e.CameraID, &e.TrackKey, &e.PersonID, &e.PersonName,
		&e.Similarity, &e.StartedAt, &e.EndedAt, &e.ThumbPath, &e.ClipPath,
		&e.ClipExpiresAt, &expired, &e.LabeledPersonID, &e.Embedding)
	if err != nil {
		return nil, err
	}
	e.ClipExpired = expired != 0
	return e, nil
}

// CreateEvent inserts the event, generating an ID if empty. Returns false when
// an event with the same track_key already exists (duplicate delivery).
func (d *DB) CreateEvent(e *Event) (bool, error) {
	if e.ID == "" {
		e.ID = uuid.New().String()
	}
	expired := 0
	if e.ClipExpired {
		expired = 1
	}
	res, err := d.q.Exec(`INSERT OR IGNORE INTO events (`+eventCols+`)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		e.ID, e.CameraID, e.TrackKey, e.PersonID, e.PersonName, e.Similarity,
		e.StartedAt, e.EndedAt, e.ThumbPath, e.ClipPath, e.ClipExpiresAt,
		expired, e.LabeledPersonID, e.Embedding)
	if err != nil {
		return false, fmt.Errorf("create event: %w", err)
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func (d *DB) GetEvent(id string) (*Event, bool, error) {
	e, err := scanEvent(d.q.QueryRow(`SELECT `+eventCols+` FROM events WHERE id=?`, id))
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return e, true, nil
}

func (d *DB) GetEventByTrackKey(key string) (*Event, bool, error) {
	e, err := scanEvent(d.q.QueryRow(`SELECT `+eventCols+` FROM events WHERE track_key=?`, key))
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return e, true, nil
}

func (d *DB) UpdateEventIdentity(id, personID, name string, similarity float64) error {
	_, err := d.q.Exec(`UPDATE events SET person_id=?, person_name=?, similarity=? WHERE id=?`,
		personID, name, similarity, id)
	return err
}

// CloseEvent sets ended_at; thumbPath/embedding update only when non-empty/non-nil.
func (d *DB) CloseEvent(id string, endedAt int64, thumbPath string, embedding []byte) error {
	_, err := d.q.Exec(`UPDATE events SET ended_at=?,
		thumb_path = CASE WHEN ?<>'' THEN ? ELSE thumb_path END,
		embedding  = CASE WHEN ? IS NOT NULL THEN ? ELSE embedding END
		WHERE id=?`,
		endedAt, thumbPath, thumbPath, embedding, embedding, id)
	return err
}

func (d *DB) SetEventClip(id, clipPath string, expiresAt int64) error {
	_, err := d.q.Exec(`UPDATE events SET clip_path=?, clip_expires_at=?, clip_expired=0 WHERE id=?`,
		clipPath, expiresAt, id)
	return err
}

func (d *DB) LabelEvent(id, personID string) error {
	_, err := d.q.Exec(`UPDATE events SET labeled_person_id=? WHERE id=?`, personID, id)
	return err
}

func (d *DB) ListEvents(f EventFilter) ([]*Event, error) {
	where := []string{"1=1"}
	args := []any{}
	if f.CameraID != "" {
		where = append(where, "camera_id=?")
		args = append(args, f.CameraID)
	}
	if f.PersonID != "" {
		where = append(where, "(person_id=? OR labeled_person_id=?)")
		args = append(args, f.PersonID, f.PersonID)
	}
	if f.UnknownOnly {
		where = append(where, "person_id='' AND labeled_person_id=''")
	}
	if f.From > 0 {
		where = append(where, "started_at>=?")
		args = append(args, f.From)
	}
	if f.To > 0 {
		where = append(where, "started_at<=?")
		args = append(args, f.To)
	}
	if f.Before > 0 {
		where = append(where, "started_at<?")
		args = append(args, f.Before)
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	args = append(args, limit)
	return d.queryEvents(`SELECT `+eventCols+` FROM events WHERE `+
		strings.Join(where, " AND ")+` ORDER BY started_at DESC LIMIT ?`, args...)
}

func (d *DB) ListUnknownWithEmbeddings() ([]*Event, error) {
	return d.queryEvents(`SELECT ` + eventCols + ` FROM events
		WHERE person_id='' AND labeled_person_id='' AND embedding IS NOT NULL`)
}

func (d *DB) ListExpiredClips(nowMs int64) ([]*Event, error) {
	return d.queryEvents(`SELECT `+eventCols+` FROM events
		WHERE clip_path<>'' AND clip_expired=0 AND clip_expires_at<=?`, nowMs)
}

func (d *DB) MarkClipExpired(id string) error {
	_, err := d.q.Exec(`UPDATE events SET clip_expired=1 WHERE id=?`, id)
	return err
}

func (d *DB) ListEventsBefore(cutoffMs int64) ([]*Event, error) {
	return d.queryEvents(`SELECT `+eventCols+` FROM events WHERE started_at<?`, cutoffMs)
}

func (d *DB) DeleteEvent(id string) error {
	_, err := d.q.Exec(`DELETE FROM events WHERE id=?`, id)
	return err
}

func (d *DB) queryEvents(query string, args ...any) ([]*Event, error) {
	rows, err := d.q.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Event
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
