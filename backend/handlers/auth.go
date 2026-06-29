package handlers

import (
	"net/http"

	"github.com/dim/sentry/backend/auth"
	"github.com/dim/sentry/backend/db"
	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

type AuthHandler struct {
	db     *db.DB
	jwtMgr *auth.Manager
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
