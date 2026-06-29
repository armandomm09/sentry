# Auth + Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add JWT-based user authentication and Expo push notification delivery to the Sentry Go backend, plus a React login page for the web frontend.

**Architecture:** A SQLite database (`sentry.db`) stores users and push subscriptions. A JWT middleware protects all `/api/*` routes except login. A background goroutine subscribes to each face-service detection WebSocket and dispatches push notifications via Expo's API to matching subscribers.

**Tech Stack:** Go/Gin backend, `modernc.org/sqlite` (pure Go, no CGO), `github.com/golang-jwt/jwt/v5`, `golang.org/x/crypto/bcrypt` (already indirect dep), React + TypeScript frontend.

## Global Constraints

- SQLite DB path from `SENTRY_DB_PATH` env var, default `./data/sentry.db`
- JWT secret from `JWT_SECRET` env var; if unset, generate random 32-byte secret on startup (log a warning)
- JWT tokens expire in 24 hours
- Default admin created at first startup: username=`admin`, password=`sentry123` — log to stdout
- All `/api/*` routes except `POST /api/auth/login` require `Authorization: Bearer <token>`
- Keep `cameras.json` for camera storage — no SQLite migration
- Expo push endpoint: `https://exp.host/push/send`; batch up to 100 per request; retry once on network error
- Module path: `github.com/dim/sentry/backend`
- Go version: 1.22

---

## File Map

**New files:**
- `backend/db/db.go` — SQLite open/migrate, User and PushSubscription CRUD
- `backend/auth/jwt.go` — token generation, validation, in-memory blacklist
- `backend/auth/middleware.go` — `RequireAuth` and `RequireAdmin` Gin middleware
- `backend/handlers/auth.go` — `POST /api/auth/login`, `POST /api/auth/logout`
- `backend/handlers/users.go` — `GET /api/users`, `POST /api/users`, `DELETE /api/users/:id`, `PATCH /api/users/:id/password`
- `backend/handlers/push.go` — `POST /api/push/register`, `GET /api/push/subscription`, `DELETE /api/push/subscription`
- `backend/push/notifier.go` — Expo push sender with channel + retry
- `backend/push/listener.go` — per-camera face-service WS listener
- `frontend/src/pages/Login.tsx` — login form page

**Modified files:**
- `backend/go.mod` / `backend/go.sum` — add sqlite, jwt deps
- `backend/main.go` — wire DB, auth, push routes
- `frontend/src/api/client.ts` — add JWT header, 401 redirect
- `frontend/src/App.tsx` — auth gate + /login route

---

## Task 1: Add Go Dependencies

**Files:**
- Modify: `backend/go.mod`

**Interfaces:**
- Produces: `modernc.org/sqlite`, `github.com/golang-jwt/jwt/v5` available for import; `golang.org/x/crypto` promoted to direct

- [ ] **Step 1: Add dependencies**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
go get modernc.org/sqlite@latest
go get github.com/golang-jwt/jwt/v5@latest
go get golang.org/x/crypto@latest
go mod tidy
```

Expected output: lines like `go: added modernc.org/sqlite v1.x.x` and `go: added github.com/golang-jwt/jwt/v5 v5.x.x`

- [ ] **Step 2: Verify build still compiles**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
go build ./...
```

Expected: no output (clean build)

- [ ] **Step 3: Commit**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
git add go.mod go.sum
git commit -m "chore: add sqlite, jwt, crypto dependencies"
```

---

## Task 2: Database Layer

**Files:**
- Create: `backend/db/db.go`

**Interfaces:**
- Produces:
  - `db.Open(path string) (*DB, error)`
  - `db.User` struct: `{ ID, Username, PasswordHash, CreatedAt string; IsAdmin bool }`
  - `db.PushSubscription` struct: `{ UserID, ExpoPushToken string; CameraIDs []string; NotifyKnown, NotifyUnknown bool; UpdatedAt string }`
  - `(*DB).CreateUser(username, passwordHash string, isAdmin bool) (*User, error)`
  - `(*DB).GetUserByUsername(username string) (*User, bool, error)`
  - `(*DB).GetUserByID(id string) (*User, bool, error)`
  - `(*DB).ListUsers() ([]*User, error)`
  - `(*DB).DeleteUser(id string) error`
  - `(*DB).UpdateUserPassword(id, hash string) error`
  - `(*DB).UpsertPushSubscription(sub *PushSubscription) error`
  - `(*DB).GetPushSubscription(userID string) (*PushSubscription, bool, error)`
  - `(*DB).DeletePushSubscription(userID string) error`
  - `(*DB).ListPushSubscriptions() ([]*PushSubscription, error)`

- [ ] **Step 1: Create `backend/db/db.go`**

```go
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
```

- [ ] **Step 2: Compile check**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
go build ./db/...
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
git add db/db.go
git commit -m "feat: add SQLite db layer for users and push subscriptions"
```

---

## Task 3: JWT Auth Layer

**Files:**
- Create: `backend/auth/jwt.go`
- Create: `backend/auth/middleware.go`

**Interfaces:**
- Consumes: `github.com/golang-jwt/jwt/v5`, `github.com/gin-gonic/gin`
- Produces:
  - `auth.NewManager(secret []byte) *Manager`
  - `(*Manager).GenerateToken(userID, username string, isAdmin bool) (string, error)`
  - `(*Manager).ValidateToken(token string) (*Claims, error)` — returns error if blacklisted
  - `(*Manager).BlacklistToken(token string)`
  - `auth.Claims` struct: `{ UserID, Username string; IsAdmin bool; jwt.RegisteredClaims }`
  - `(*Manager).RequireAuth() gin.HandlerFunc` — sets `c.Set("claims", *Claims)`
  - `(*Manager).RequireAdmin() gin.HandlerFunc`
  - Context key constants: `auth.CtxClaims = "claims"`

- [ ] **Step 1: Create `backend/auth/jwt.go`**

```go
package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const CtxClaims = "claims"

type Claims struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
	IsAdmin  bool   `json:"is_admin"`
	jwt.RegisteredClaims
}

type Manager struct {
	secret    []byte
	mu        sync.RWMutex
	blacklist map[string]time.Time // token jti → expiry
}

func NewManager(secret []byte) *Manager {
	m := &Manager{
		secret:    secret,
		blacklist: make(map[string]time.Time),
	}
	go m.sweepLoop()
	return m
}

// SecretFromEnv reads JWT_SECRET or generates a random one.
func SecretFromEnv() []byte {
	if s := os.Getenv("JWT_SECRET"); s != "" {
		return []byte(s)
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("cannot generate JWT secret: " + err.Error())
	}
	log.Printf("[auth] WARNING: JWT_SECRET not set, using random secret — tokens will be invalid after restart")
	return b
}

// SecretAsHex generates a printable random secret for first-run hint.
func SecretAsHex() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (m *Manager) GenerateToken(userID, username string, isAdmin bool) (string, error) {
	jti := fmt.Sprintf("%d", time.Now().UnixNano())
	claims := Claims{
		UserID:   userID,
		Username: username,
		IsAdmin:  isAdmin,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ID:        jti,
		},
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString(m.secret)
}

func (m *Manager) ValidateToken(tokenStr string) (*Claims, error) {
	t, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return m.secret, nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := t.Claims.(*Claims)
	if !ok || !t.Valid {
		return nil, errors.New("invalid token")
	}
	m.mu.RLock()
	_, blacklisted := m.blacklist[claims.ID]
	m.mu.RUnlock()
	if blacklisted {
		return nil, errors.New("token revoked")
	}
	return claims, nil
}

func (m *Manager) BlacklistToken(tokenStr string) {
	t, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		return m.secret, nil
	})
	if err != nil {
		return
	}
	claims, ok := t.Claims.(*Claims)
	if !ok {
		return
	}
	exp := time.Now().Add(25 * time.Hour) // keep slightly past expiry
	if claims.ExpiresAt != nil {
		exp = claims.ExpiresAt.Time.Add(time.Minute)
	}
	m.mu.Lock()
	m.blacklist[claims.ID] = exp
	m.mu.Unlock()
}

func (m *Manager) sweepLoop() {
	for range time.Tick(10 * time.Minute) {
		now := time.Now()
		m.mu.Lock()
		for jti, exp := range m.blacklist {
			if now.After(exp) {
				delete(m.blacklist, jti)
			}
		}
		m.mu.Unlock()
	}
}
```

- [ ] **Step 2: Create `backend/auth/middleware.go`**

```go
package auth

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// RequireAuth extracts and validates the Bearer token, sets CtxClaims.
func (m *Manager) RequireAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		if !strings.HasPrefix(header, "Bearer ") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing authorization header"})
			return
		}
		tokenStr := strings.TrimPrefix(header, "Bearer ")
		claims, err := m.ValidateToken(tokenStr)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired token"})
			return
		}
		c.Set(CtxClaims, claims)
		c.Set("raw_token", tokenStr)
		c.Next()
	}
}

// RequireAdmin must be chained after RequireAuth.
func (m *Manager) RequireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		v, exists := c.Get(CtxClaims)
		if !exists {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthenticated"})
			return
		}
		claims := v.(*Claims)
		if !claims.IsAdmin {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "admin access required"})
			return
		}
		c.Next()
	}
}
```

- [ ] **Step 3: Compile check**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
go build ./auth/...
```

Expected: no output

- [ ] **Step 4: Commit**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
git add auth/jwt.go auth/middleware.go
git commit -m "feat: add JWT auth manager and Gin middleware"
```

---

## Task 4: Auth & User Handlers

**Files:**
- Create: `backend/handlers/auth.go`
- Create: `backend/handlers/users.go`

**Interfaces:**
- Consumes:
  - `db.DB` (from Task 2): `GetUserByUsername`, `CreateUser`, `ListUsers`, `DeleteUser`, `UpdateUserPassword`
  - `auth.Manager` (from Task 3): `GenerateToken`, `BlacklistToken`, `CtxClaims`, `Claims`
  - `golang.org/x/crypto/bcrypt`
- Produces: handler funcs wired in main.go

- [ ] **Step 1: Create `backend/handlers/auth.go`**

```go
package handlers

import (
	"net/http"

	"github.com/dim/sentry/backend/auth"
	"github.com/dim/sentry/backend/db"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

type AuthHandler struct {
	db      *db.DB
	jwtMgr  *auth.Manager
}

func NewAuthHandler(database *db.DB, jwtMgr *auth.Manager) *AuthHandler {
	return &AuthHandler{db: database, jwtMgr: jwtMgr}
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req struct {
		Username string `json:"username" binding:"required"`
		Password string `json:"password" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	user, found, err := h.db.GetUserByUsername(req.Username)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	if !found {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid credentials"})
		return
	}
	token, err := h.jwtMgr.GenerateToken(user.ID, user.Username, user.IsAdmin)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "token generation failed"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"token":    token,
		"user_id":  user.ID,
		"username": user.Username,
		"is_admin": user.IsAdmin,
	})
}

func (h *AuthHandler) Logout(c *gin.Context) {
	rawToken, _ := c.Get("raw_token")
	if tok, ok := rawToken.(string); ok {
		h.jwtMgr.BlacklistToken(tok)
	}
	c.Status(http.StatusNoContent)
}
```

- [ ] **Step 2: Create `backend/handlers/users.go`**

```go
package handlers

import (
	"net/http"

	"github.com/dim/sentry/backend/auth"
	"github.com/dim/sentry/backend/db"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

type UserHandler struct {
	db *db.DB
}

func NewUserHandler(database *db.DB) *UserHandler {
	return &UserHandler{db: database}
}

func (h *UserHandler) List(c *gin.Context) {
	users, err := h.db.ListUsers()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	type userResp struct {
		ID        string `json:"id"`
		Username  string `json:"username"`
		CreatedAt string `json:"created_at"`
		IsAdmin   bool   `json:"is_admin"`
	}
	resp := make([]userResp, len(users))
	for i, u := range users {
		resp[i] = userResp{ID: u.ID, Username: u.Username, CreatedAt: u.CreatedAt, IsAdmin: u.IsAdmin}
	}
	c.JSON(http.StatusOK, resp)
}

func (h *UserHandler) Create(c *gin.Context) {
	var req struct {
		Username string `json:"username" binding:"required"`
		Password string `json:"password" binding:"required"`
		IsAdmin  bool   `json:"is_admin"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "hash error"})
		return
	}
	user, err := h.db.CreateUser(req.Username, string(hash), req.IsAdmin)
	if err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "username already exists"})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": user.ID, "username": user.Username, "is_admin": user.IsAdmin})
}

func (h *UserHandler) Delete(c *gin.Context) {
	id := c.Param("id")
	claims := c.MustGet(auth.CtxClaims).(*auth.Claims)
	if claims.UserID == id {
		c.JSON(http.StatusBadRequest, gin.H{"error": "cannot delete yourself"})
		return
	}
	if err := h.db.DeleteUser(id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *UserHandler) ChangePassword(c *gin.Context) {
	id := c.Param("id")
	claims := c.MustGet(auth.CtxClaims).(*auth.Claims)
	// Non-admins can only change their own password.
	if !claims.IsAdmin && claims.UserID != id {
		c.JSON(http.StatusForbidden, gin.H{"error": "forbidden"})
		return
	}
	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	user, found, err := h.db.GetUserByID(id)
	if err != nil || !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	// Non-admins must supply current password.
	if !claims.IsAdmin {
		if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.CurrentPassword)); err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "current password incorrect"})
			return
		}
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "hash error"})
		return
	}
	if err := h.db.UpdateUserPassword(id, string(hash)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	c.Status(http.StatusNoContent)
}
```

- [ ] **Step 3: Compile check**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
go build ./handlers/...
```

Expected: no output

- [ ] **Step 4: Commit**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
git add handlers/auth.go handlers/users.go
git commit -m "feat: add auth login/logout and user management handlers"
```

---

## Task 5: Push Subscription Handlers

**Files:**
- Create: `backend/handlers/push.go`

**Interfaces:**
- Consumes:
  - `db.DB`: `UpsertPushSubscription`, `GetPushSubscription`, `DeletePushSubscription`
  - `auth.CtxClaims`, `auth.Claims`
  - `db.PushSubscription`
- Produces: `NewPushHandler(database *db.DB) *PushHandler`, handler methods

- [ ] **Step 1: Create `backend/handlers/push.go`**

```go
package handlers

import (
	"net/http"

	"github.com/dim/sentry/backend/auth"
	"github.com/dim/sentry/backend/db"
	"github.com/gin-gonic/gin"
)

type PushHandler struct {
	db *db.DB
}

func NewPushHandler(database *db.DB) *PushHandler {
	return &PushHandler{db: database}
}

func (h *PushHandler) Register(c *gin.Context) {
	claims := c.MustGet(auth.CtxClaims).(*auth.Claims)
	var req struct {
		ExpoPushToken string   `json:"expo_push_token" binding:"required"`
		CameraIDs     []string `json:"camera_ids"`
		NotifyKnown   *bool    `json:"notify_known"`
		NotifyUnknown *bool    `json:"notify_unknown"`
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
	sub := &db.PushSubscription{
		UserID:        claims.UserID,
		ExpoPushToken: req.ExpoPushToken,
		CameraIDs:     cameraIDs,
		NotifyKnown:   notifyKnown,
		NotifyUnknown: notifyUnknown,
	}
	if err := h.db.UpsertPushSubscription(sub); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	c.JSON(http.StatusOK, sub)
}

func (h *PushHandler) Get(c *gin.Context) {
	claims := c.MustGet(auth.CtxClaims).(*auth.Claims)
	sub, found, err := h.db.GetPushSubscription(claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "no subscription"})
		return
	}
	c.JSON(http.StatusOK, sub)
}

func (h *PushHandler) Delete(c *gin.Context) {
	claims := c.MustGet(auth.CtxClaims).(*auth.Claims)
	if err := h.db.DeletePushSubscription(claims.UserID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "database error"})
		return
	}
	c.Status(http.StatusNoContent)
}
```

- [ ] **Step 2: Compile check**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
go build ./handlers/...
```

Expected: no output

- [ ] **Step 3: Commit**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
git add handlers/push.go
git commit -m "feat: add push subscription handlers"
```

---

## Task 6: Push Notification Engine

**Files:**
- Create: `backend/push/notifier.go`
- Create: `backend/push/listener.go`

**Interfaces:**
- Consumes:
  - `db.DB`: `ListPushSubscriptions`
  - `db.PushSubscription`
  - `storage.JSONStore` (via `CameraLister` interface for camera names)
  - `github.com/gorilla/websocket`
- Produces:
  - `push.Notifier` with `Send(msg Message)` method and `Start()` to launch background goroutine
  - `push.Listener` with `Start(faceBaseURL string, cameras []string)` to launch per-camera WS goroutines
  - `push.Message` struct: `{ CameraID, CameraName, PersonName string; IsKnown bool }`
  - `push.NewNotifier(database *db.DB, store CameraNameStore) *Notifier`
  - `push.NewListener(faceBaseURL string, notifier *Notifier, database *db.DB, store CameraNameStore) *Listener`
  - `CameraNameStore` interface: `GetCameraName(id string) string`

- [ ] **Step 1: Create `backend/push/notifier.go`**

```go
package push

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/dim/sentry/backend/db"
)

const expoURL = "https://exp.host/push/send"

type Message struct {
	CameraID   string
	CameraName string
	PersonName string // empty = unknown
	IsKnown    bool
}

type CameraNameStore interface {
	GetCameraName(id string) string
}

type expoMessage struct {
	To    string            `json:"to"`
	Title string            `json:"title"`
	Body  string            `json:"body"`
	Data  map[string]string `json:"data"`
}

type Notifier struct {
	db    *db.DB
	store CameraNameStore
	ch    chan Message
}

func NewNotifier(database *db.DB, store CameraNameStore) *Notifier {
	return &Notifier{
		db:    database,
		store: store,
		ch:    make(chan Message, 256),
	}
}

func (n *Notifier) Send(msg Message) {
	select {
	case n.ch <- msg:
	default:
		log.Printf("[push] notification channel full, dropping event for camera %s", msg.CameraID)
	}
}

func (n *Notifier) Start() {
	go n.processLoop()
}

func (n *Notifier) processLoop() {
	for msg := range n.ch {
		n.dispatch(msg)
	}
}

func (n *Notifier) dispatch(msg Message) {
	subs, err := n.db.ListPushSubscriptions()
	if err != nil {
		log.Printf("[push] list subscriptions: %v", err)
		return
	}

	var batch []expoMessage
	for _, sub := range subs {
		if !n.shouldNotify(sub, msg) {
			continue
		}
		body := n.buildBody(msg)
		batch = append(batch, expoMessage{
			To:    sub.ExpoPushToken,
			Title: "Sentry Alert",
			Body:  body,
			Data:  map[string]string{"camera_id": msg.CameraID, "type": "detection"},
		})
		if len(batch) == 100 {
			n.sendBatch(batch)
			batch = nil
		}
	}
	if len(batch) > 0 {
		n.sendBatch(batch)
	}
}

func (n *Notifier) shouldNotify(sub *db.PushSubscription, msg Message) bool {
	if msg.IsKnown && !sub.NotifyKnown {
		return false
	}
	if !msg.IsKnown && !sub.NotifyUnknown {
		return false
	}
	// Empty camera_ids = all cameras
	if len(sub.CameraIDs) == 0 {
		return true
	}
	for _, id := range sub.CameraIDs {
		if id == msg.CameraID {
			return true
		}
	}
	return false
}

func (n *Notifier) buildBody(msg Message) string {
	if msg.IsKnown {
		return fmt.Sprintf("%s detected at %s", msg.PersonName, msg.CameraName)
	}
	return fmt.Sprintf("Unknown person detected at %s", msg.CameraName)
}

func (n *Notifier) sendBatch(batch []expoMessage) {
	if err := n.doSend(batch); err != nil {
		log.Printf("[push] send failed, retrying: %v", err)
		time.Sleep(2 * time.Second)
		if err := n.doSend(batch); err != nil {
			log.Printf("[push] retry failed: %v", err)
		}
	}
}

func (n *Notifier) doSend(batch []expoMessage) error {
	data, err := json.Marshal(batch)
	if err != nil {
		return err
	}
	resp, err := http.Post(expoURL, "application/json", bytes.NewReader(data))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("expo returned %d", resp.StatusCode)
	}
	return nil
}
```

- [ ] **Step 2: Create `backend/push/listener.go`**

```go
package push

import (
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

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

type Listener struct {
	faceBaseURL string // e.g. "http://127.0.0.1:8090"
	notifier    *Notifier
	store       CameraNameStore
}

func NewListener(faceBaseURL string, notifier *Notifier, store CameraNameStore) *Listener {
	return &Listener{
		faceBaseURL: faceBaseURL,
		notifier:    notifier,
		store:       store,
	}
}

// WatchCamera starts a background goroutine that subscribes to the face-service
// detection WS for cameraID. Reconnects automatically on disconnect.
func (l *Listener) WatchCamera(cameraID string) {
	go l.reconnectLoop(cameraID)
}

func (l *Listener) reconnectLoop(cameraID string) {
	wsURL := strings.Replace(l.faceBaseURL, "http://", "ws://", 1)
	wsURL = strings.Replace(wsURL, "https://", "wss://", 1)
	wsURL += "/cameras/" + cameraID + "/ws"

	for {
		if err := l.connectAndRead(wsURL, cameraID); err != nil {
			log.Printf("[push-listener] camera %s disconnected: %v — reconnecting in 5s", cameraID, err)
		}
		time.Sleep(5 * time.Second)
	}
}

func (l *Listener) connectAndRead(wsURL, cameraID string) error {
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	log.Printf("[push-listener] connected to face-service for camera %s", cameraID)
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var frame detectionFrame
		if err := json.Unmarshal(msg, &frame); err != nil {
			continue
		}
		if frame.Type != "detections" || len(frame.Detections) == 0 {
			continue
		}
		cameraName := l.store.GetCameraName(cameraID)
		for _, det := range frame.Detections {
			isKnown := det.PersonID != ""
			name := det.Name
			if !isKnown {
				name = ""
			}
			l.notifier.Send(Message{
				CameraID:   cameraID,
				CameraName: cameraName,
				PersonName: name,
				IsKnown:    isKnown,
			})
		}
	}
}
```

- [ ] **Step 3: Compile check**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
go build ./push/...
```

Expected: no output

- [ ] **Step 4: Commit**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
git add push/notifier.go push/listener.go
git commit -m "feat: add Expo push notifier and face-service WS listener"
```

---

## Task 7: Wire Everything in main.go

**Files:**
- Modify: `backend/main.go`
- Modify: `backend/storage/json_store.go` — add `GetCameraName(id string) string`

**Interfaces:**
- Consumes: all packages from Tasks 1–6
- Produces: running server with auth + push routes

- [ ] **Step 1: Add `GetCameraName` to `backend/storage/json_store.go`**

Add after the `Delete` method:

```go
// GetCameraName returns the camera name for a given ID, or the ID itself if not found.
func (s *JSONStore) GetCameraName(id string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if c, ok := s.cameras[id]; ok {
		return c.Name
	}
	return id
}
```

- [ ] **Step 2: Rewrite `backend/main.go`**

Replace the entire file with:

```go
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/dim/sentry/backend/auth"
	"github.com/dim/sentry/backend/db"
	"github.com/dim/sentry/backend/face"
	"github.com/dim/sentry/backend/handlers"
	"github.com/dim/sentry/backend/push"
	"github.com/dim/sentry/backend/storage"
	"github.com/dim/sentry/backend/stream"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

func main() {
	dataDir := envOr("SENTRY_DATA_DIR", "./data")
	dbPath := envOr("SENTRY_DB_PATH", "./data/sentry.db")
	port := envOr("PORT", "8080")
	faceURL := envOr("FACE_SERVICE_URL", "http://127.0.0.1:8090")

	// SQLite database
	database, err := db.Open(dbPath)
	if err != nil {
		log.Fatalf("db init: %v", err)
	}
	defer database.Close()

	// Seed default admin if users table is empty
	if empty, err := database.IsEmpty(); err != nil {
		log.Fatalf("db check: %v", err)
	} else if empty {
		hash, _ := bcrypt.GenerateFromPassword([]byte("sentry123"), bcrypt.DefaultCost)
		if _, err := database.CreateUser("admin", string(hash), true); err != nil {
			log.Fatalf("seed admin: %v", err)
		}
		log.Println("[startup] Created default admin user: username=admin password=sentry123")
	}

	// JWT manager
	jwtMgr := auth.NewManager(auth.SecretFromEnv())

	// Camera storage (cameras.json)
	store, err := storage.NewJSONStore(dataDir)
	if err != nil {
		log.Fatalf("storage init: %v", err)
	}

	manager := stream.NewManager()
	faceClient := face.NewClient(faceURL)
	faceProxy, err := face.NewProxy(faceClient)
	if err != nil {
		log.Fatalf("face proxy init: %v", err)
	}

	// Push notification engine
	notifier := push.NewNotifier(database, store)
	notifier.Start()
	listener := push.NewListener(faceURL, notifier, store)
	for _, cam := range store.List() {
		if cam.FaceRecognitionEnabled {
			listener.WatchCamera(cam.ID)
		}
	}

	// Auto-start streams
	manager.StartAll(store.List())

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		face.SyncFromStore(ctx, faceClient, store.List())
	}()
	go face.RunSyncLoop(context.Background(), faceClient, store, 30*time.Second)

	r := gin.Default()

	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization"},
		AllowCredentials: false,
	}))

	hlsRoot := stream.HLSDir()
	r.Static("/hls", hlsRoot)

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	// Handlers
	cameraH := handlers.NewCameraHandler(store, manager, faceClient)
	authH := handlers.NewAuthHandler(database, jwtMgr)
	userH := handlers.NewUserHandler(database)
	pushH := handlers.NewPushHandler(database)

	api := r.Group("/api")
	{
		// Public: login only
		api.POST("/auth/login", authH.Login)

		// All other /api routes require auth
		authed := api.Group("")
		authed.Use(jwtMgr.RequireAuth())
		{
			authed.POST("/auth/logout", authH.Logout)

			// User management (admin only)
			adminUsers := authed.Group("/users")
			adminUsers.Use(jwtMgr.RequireAdmin())
			{
				adminUsers.GET("", userH.List)
				adminUsers.POST("", userH.Create)
				adminUsers.DELETE("/:id", userH.Delete)
			}
			// Password change — auth only (handler enforces own-user or admin)
			authed.PATCH("/users/:id/password", userH.ChangePassword)

			// Push subscriptions
			pushGroup := authed.Group("/push")
			{
				pushGroup.POST("/register", pushH.Register)
				pushGroup.GET("/subscription", pushH.Get)
				pushGroup.DELETE("/subscription", pushH.Delete)
			}

			// Cameras
			cameras := authed.Group("/cameras")
			{
				cameras.GET("", cameraH.List)
				cameras.POST("", cameraH.Create)
				cameras.GET("/:id", cameraH.Get)
				cameras.PUT("/:id", cameraH.Update)
				cameras.DELETE("/:id", cameraH.Delete)
				cameras.POST("/:id/stream/start", cameraH.StreamStart)
				cameras.POST("/:id/stream/stop", cameraH.StreamStop)
				cameras.GET("/:id/stream/status", cameraH.StreamStatus)
				cameras.GET("/:id/frames", cameraH.FramesWS)
			}

			authed.GET("/streams", cameraH.AllStreamStatuses)

			// Face-recognition surface — proxied to Python service
			authed.Any("/persons", faceProxy.Handler())
			authed.Any("/persons/*proxyPath", faceProxy.Handler())
		}
	}

	log.Printf("Sentry backend listening on :%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
```

- [ ] **Step 3: Build and start the server to verify it starts correctly**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
go build ./... && echo "BUILD OK"
```

Expected: `BUILD OK`

- [ ] **Step 4: Smoke-test the auth endpoint**

In one terminal, start the server:
```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
./backend &
sleep 2
```

Test login:
```bash
curl -s -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"sentry123"}' | python3 -m json.tool
```

Expected: JSON with `token`, `user_id`, `username`, `is_admin`

Test that a protected route returns 401 without token:
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/cameras
```

Expected: `401`

Test with token:
```bash
TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"sentry123"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/cameras \
  -H "Authorization: Bearer $TOKEN"
```

Expected: `200`

Kill test server: `kill %1`

- [ ] **Step 5: Commit**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend
git add main.go storage/json_store.go
git commit -m "feat: wire auth middleware, user/push routes, and push listener into main"
```

---

## Task 8: Frontend Auth — Login Page + API Client

**Files:**
- Create: `frontend/src/pages/Login.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `POST /api/auth/login` returning `{ token, user_id, username, is_admin }`
- Produces: localStorage key `sentry_token`; redirects to `/login` on 401; `<Login>` page component

- [ ] **Step 1: Create `frontend/src/pages/Login.tsx`**

```tsx
import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'

export function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as { error?: string }).error ?? 'Login failed')
        return
      }
      const data = await res.json()
      localStorage.setItem('sentry_token', data.token)
      navigate('/', { replace: true })
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-ink-deeper">
      <div className="w-full max-w-sm p-8 rounded-2xl bg-ink-deep border border-white/10">
        <div className="font-sans font-bold text-[22px] text-fg-1 mb-2">Sentry</div>
        <div className="font-sans text-[13px] text-fg-3 mb-6">Sign in to continue</div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-[11px] font-semibold text-fg-3 mb-1 uppercase tracking-wider">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-ink-deeper border border-white/10 text-fg-1 text-[13px] outline-none focus:border-white/30"
              autoFocus
              required
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-fg-3 mb-1 uppercase tracking-wider">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-ink-deeper border border-white/10 text-fg-1 text-[13px] outline-none focus:border-white/30"
              required
            />
          </div>
          {error && (
            <div className="text-[12px] text-red-400">{error}</div>
          )}
          <button
            type="submit"
            disabled={loading}
            className="mt-2 py-2 rounded-lg bg-white text-black font-semibold text-[13px] hover:bg-white/90 transition disabled:opacity-50"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Modify `frontend/src/api/client.ts`**

Replace the `request` function with a version that injects the token and handles 401:

```ts
import type { CameraWithStream, CreateCameraPayload, StreamInfo } from '../types/camera'
import type { Person, Photo, PhotoUploadResult } from '../types/person'

const BASE = '/api'

function getToken(): string {
  return localStorage.getItem('sentry_token') ?? ''
}

function handleUnauthorized() {
  localStorage.removeItem('sentry_token')
  window.location.href = '/login'
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData
  const headers: Record<string, string> = isFormData
    ? { ...(init?.headers as Record<string, string> | undefined) }
    : { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) }

  const token = getToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers })

  if (res.status === 401) {
    handleUnauthorized()
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  cameras: {
    list: () => request<CameraWithStream[]>('/cameras'),
    get: (id: string) => request<{ camera: CameraWithStream; stream: StreamInfo }>(`/cameras/${id}`),
    create: (payload: CreateCameraPayload) =>
      request<{ camera: CameraWithStream; stream: StreamInfo }>('/cameras', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    update: (id: string, payload: Partial<CreateCameraPayload>) =>
      request<{ camera: CameraWithStream; stream: StreamInfo }>(`/cameras/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    delete: (id: string) => request<void>(`/cameras/${id}`, { method: 'DELETE' }),
    setFaceRecognition: (id: string, enabled: boolean) =>
      request<{ camera: CameraWithStream; stream: StreamInfo }>(`/cameras/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ face_recognition_enabled: enabled }),
      }),
  },
  streams: {
    start: (id: string) => request<StreamInfo>(`/cameras/${id}/stream/start`, { method: 'POST' }),
    stop: (id: string) => request<StreamInfo>(`/cameras/${id}/stream/stop`, { method: 'POST' }),
    status: (id: string) => request<StreamInfo>(`/cameras/${id}/stream/status`),
    all: () => request<Record<string, StreamInfo>>('/streams'),
  },
  persons: {
    list: () => request<Person[]>('/persons'),
    get: (pid: string) => request<Person>(`/persons/${pid}`),
    create: (name: string) =>
      request<Person>('/persons', { method: 'POST', body: JSON.stringify({ name }) }),
    rename: (pid: string, name: string) =>
      request<Person>(`/persons/${pid}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    delete: (pid: string) => request<void>(`/persons/${pid}`, { method: 'DELETE' }),

    listPhotos: (pid: string) => request<Photo[]>(`/persons/${pid}/photos`),
    uploadPhotos: (pid: string, files: File[]) => {
      const fd = new FormData()
      for (const f of files) fd.append('photo', f, f.name)
      return request<PhotoUploadResult>(`/persons/${pid}/photos`, {
        method: 'POST',
        body: fd,
      })
    },
    deletePhoto: (pid: string, photoId: string) =>
      request<void>(`/persons/${pid}/photos/${photoId}`, { method: 'DELETE' }),
    photoUrl: (pid: string, photoId: string) => `${BASE}/persons/${pid}/photos/${photoId}/raw`,
  },
}
```

- [ ] **Step 3: Modify `frontend/src/App.tsx`**

Replace with auth-gated version:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Sidebar } from './components/layout/Sidebar'
import { Dashboard } from './pages/Dashboard'
import { Login } from './pages/Login'
import { Settings } from './pages/Settings'
import { SystemHealth } from './pages/SystemHealth'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2000,
      retry: 2,
    },
  },
})

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center">
        <div className="font-sans font-bold text-[22px] text-fg-1">{title}</div>
        <div className="font-sans text-[13px] text-fg-3 mt-2">Coming soon.</div>
      </div>
    </div>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('sentry_token')
  if (!token) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/*"
            element={
              <RequireAuth>
                <div className="flex h-screen bg-ink-deeper text-fg-1 font-sans overflow-hidden">
                  <Sidebar />
                  <main className="flex-1 overflow-auto">
                    <Routes>
                      <Route path="/"         element={<Dashboard />} />
                      <Route path="/health"   element={<SystemHealth />} />
                      <Route path="/alerts"   element={<PlaceholderPage title="Alerts" />} />
                      <Route path="/settings" element={<Settings />} />
                    </Routes>
                  </main>
                </div>
              </RequireAuth>
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
```

- [ ] **Step 4: Type-check the frontend**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/frontend
npm run build 2>&1 | tail -20
```

Expected: build completes without TypeScript errors

- [ ] **Step 5: Commit**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/frontend
git add src/pages/Login.tsx src/api/client.ts src/App.tsx
git commit -m "feat: add login page and JWT auth to frontend API client"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Covered by |
|---|---|
| SQLite at `sentry.db`, `users` table | Task 2 |
| JWT tokens, 24h expiry | Task 3 |
| `POST /api/auth/login` | Task 4 |
| `POST /api/auth/logout` (token blacklist) | Task 3 + 4 |
| `GET /api/users` (admin only) | Task 4 |
| `POST /api/users` (admin only) | Task 4 |
| `DELETE /api/users/:id` (admin only) | Task 4 |
| `PATCH /api/users/:id/password` | Task 4 |
| Default admin on first startup | Task 7 |
| All `/api/*` require auth except login | Task 7 |
| `POST /api/push/register` | Task 5 |
| `GET /api/push/subscription` | Task 5 |
| `DELETE /api/push/subscription` | Task 5 |
| `notify_known`, `notify_unknown`, `camera_ids` in push_subscriptions | Task 2 + 5 |
| Empty `camera_ids` = all cameras | Task 6 (`shouldNotify`) |
| Face-service WS listener for detections | Task 6 |
| Expo push API, batch 100, retry once | Task 6 |
| Background goroutine for push dispatch | Task 6 |
| Frontend login page | Task 8 |
| Frontend sends `Authorization: Bearer` | Task 8 |
| Frontend redirects to `/login` on 401 | Task 8 |
| `SENTRY_DB_PATH` env var | Task 7 |
| Pure Go SQLite (no CGO) | Task 1: `modernc.org/sqlite` |

**Placeholder scan:** None found — all steps contain complete code.

**Type consistency check:** 
- `db.PushSubscription` defined in Task 2, used identically in Tasks 5 and 6 ✓
- `push.CameraNameStore` interface in Task 6 is satisfied by `*storage.JSONStore.GetCameraName` added in Task 7 ✓
- `auth.CtxClaims = "claims"` used in middleware (Task 3) and handlers (Tasks 4, 5) ✓
- `auth.Claims` type cast with `c.MustGet(auth.CtxClaims).(*auth.Claims)` consistent across Tasks 4 and 5 ✓
