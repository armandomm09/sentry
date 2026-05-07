package models

import "time"

type Camera struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Location      string    `json:"location"`
	RTSPURL       string    `json:"rtsp_url"`
	AutoReconnect bool      `json:"auto_reconnect"`
	CreatedAt     time.Time `json:"created_at"`
}

type CreateCameraRequest struct {
	Name          string `json:"name"          binding:"required"`
	Location      string `json:"location"`
	RTSPURL       string `json:"rtsp_url"      binding:"required"`
	AutoReconnect bool   `json:"auto_reconnect"`
}

type UpdateCameraRequest struct {
	Name          *string `json:"name"`
	Location      *string `json:"location"`
	RTSPURL       *string `json:"rtsp_url"`
	AutoReconnect *bool   `json:"auto_reconnect"`
}

type StreamStatus struct {
	CameraID  string     `json:"camera_id"`
	Status    string     `json:"status"` // "live" | "offline" | "reconnecting"
	HLSURL    string     `json:"hls_url,omitempty"`
	StartedAt *time.Time `json:"started_at,omitempty"`
	Error     string     `json:"error,omitempty"`
}
