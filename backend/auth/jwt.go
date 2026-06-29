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
