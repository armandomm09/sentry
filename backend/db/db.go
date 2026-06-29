package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

type DB struct{ q *sql.DB }

type User struct {
	ID           string
	Username     string
	PasswordHash string
	CreatedAt    string
	IsAdmin      bool
}

type PushSubscription struct {
	UserID        string
	ExpoPushToken string
	CameraIDs     []string
	NotifyKnown   bool
	NotifyUnknown bool
	UpdatedAt     string
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
	id           TEXT PRIMARY KEY,
	username     TEXT UNIQUE NOT NULL,
	password_hash TEXT NOT NULL,
	created_at   TEXT NOT NULL,
	is_admin     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
	user_id        TEXT PRIMARY KEY,
	expo_push_token TEXT NOT NULL,
	camera_ids     TEXT NOT NULL DEFAULT '[]',
	notify_known   INTEGER NOT NULL DEFAULT 1,
	notify_unknown INTEGER NOT NULL DEFAULT 1,
	updated_at     TEXT NOT NULL
);
`

func Open(path string) (*DB, error) {
	q, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("db open: %w", err)
	}
	q.SetMaxOpenConns(1) // SQLite is single-writer
	if _, err := q.Exec(schema); err != nil {
		return nil, fmt.Errorf("db migrate: %w", err)
	}
	return &DB{q: q}, nil
}

func (d *DB) Close() error { return d.q.Close() }

// IsEmpty returns true if the users table has no rows.
func (d *DB) IsEmpty() (bool, error) {
	var count int
	err := d.q.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count)
	return count == 0, err
}

func (d *DB) CreateUser(username, passwordHash string, isAdmin bool) (*User, error) {
	u := &User{
		ID:           uuid.New().String(),
		Username:     username,
		PasswordHash: passwordHash,
		CreatedAt:    time.Now().UTC().Format(time.RFC3339),
		IsAdmin:      isAdmin,
	}
	isAdminInt := 0
	if isAdmin {
		isAdminInt = 1
	}
	_, err := d.q.Exec(
		`INSERT INTO users (id, username, password_hash, created_at, is_admin) VALUES (?,?,?,?,?)`,
		u.ID, u.Username, u.PasswordHash, u.CreatedAt, isAdminInt,
	)
	if err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}
	return u, nil
}

func (d *DB) GetUserByUsername(username string) (*User, bool, error) {
	u := &User{}
	var isAdminInt int
	err := d.q.QueryRow(
		`SELECT id, username, password_hash, created_at, is_admin FROM users WHERE username=?`, username,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &u.CreatedAt, &isAdminInt)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	u.IsAdmin = isAdminInt != 0
	return u, true, nil
}

func (d *DB) GetUserByID(id string) (*User, bool, error) {
	u := &User{}
	var isAdminInt int
	err := d.q.QueryRow(
		`SELECT id, username, password_hash, created_at, is_admin FROM users WHERE id=?`, id,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &u.CreatedAt, &isAdminInt)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	u.IsAdmin = isAdminInt != 0
	return u, true, nil
}

func (d *DB) ListUsers() ([]*User, error) {
	rows, err := d.q.Query(`SELECT id, username, created_at, is_admin FROM users ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var users []*User
	for rows.Next() {
		u := &User{}
		var isAdminInt int
		if err := rows.Scan(&u.ID, &u.Username, &u.CreatedAt, &isAdminInt); err != nil {
			return nil, err
		}
		u.IsAdmin = isAdminInt != 0
		users = append(users, u)
	}
	return users, rows.Err()
}

func (d *DB) DeleteUser(id string) error {
	_, err := d.q.Exec(`DELETE FROM users WHERE id=?`, id)
	return err
}

func (d *DB) UpdateUserPassword(id, hash string) error {
	_, err := d.q.Exec(`UPDATE users SET password_hash=? WHERE id=?`, hash, id)
	return err
}

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
		INSERT INTO push_subscriptions (user_id, expo_push_token, camera_ids, notify_known, notify_unknown, updated_at)
		VALUES (?,?,?,?,?,?)
		ON CONFLICT(user_id) DO UPDATE SET
			expo_push_token=excluded.expo_push_token,
			camera_ids=excluded.camera_ids,
			notify_known=excluded.notify_known,
			notify_unknown=excluded.notify_unknown,
			updated_at=excluded.updated_at`,
		sub.UserID, sub.ExpoPushToken, string(cameraIDsJSON),
		notifyKnownInt, notifyUnknownInt, sub.UpdatedAt,
	)
	return err
}

func (d *DB) GetPushSubscription(userID string) (*PushSubscription, bool, error) {
	sub := &PushSubscription{}
	var cameraIDsJSON string
	var notifyKnownInt, notifyUnknownInt int
	err := d.q.QueryRow(
		`SELECT user_id, expo_push_token, camera_ids, notify_known, notify_unknown, updated_at FROM push_subscriptions WHERE user_id=?`,
		userID,
	).Scan(&sub.UserID, &sub.ExpoPushToken, &cameraIDsJSON, &notifyKnownInt, &notifyUnknownInt, &sub.UpdatedAt)
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

func (d *DB) DeletePushSubscription(userID string) error {
	_, err := d.q.Exec(`DELETE FROM push_subscriptions WHERE user_id=?`, userID)
	return err
}

func (d *DB) ListPushSubscriptions() ([]*PushSubscription, error) {
	rows, err := d.q.Query(`SELECT user_id, expo_push_token, camera_ids, notify_known, notify_unknown FROM push_subscriptions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var subs []*PushSubscription
	for rows.Next() {
		sub := &PushSubscription{}
		var cameraIDsJSON string
		var notifyKnownInt, notifyUnknownInt int
		if err := rows.Scan(&sub.UserID, &sub.ExpoPushToken, &cameraIDsJSON, &notifyKnownInt, &notifyUnknownInt); err != nil {
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
