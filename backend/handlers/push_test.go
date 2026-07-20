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
