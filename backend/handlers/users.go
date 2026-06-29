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
