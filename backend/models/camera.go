package models

import "time"

type Camera struct {
	ID                     string    `json:"id"`
	Name                   string    `json:"name"`
	Location               string    `json:"location"`
	RTSPURL                string    `json:"rtsp_url"`
	SnapshotURL            string    `json:"snapshot_url"`
	AutoReconnect          bool      `json:"auto_reconnect"`
	FaceRecognitionEnabled bool      `json:"face_recognition_enabled"`
	CreatedAt              time.Time `json:"created_at"`
}

type CreateCameraRequest struct {
	Name                   string `json:"name"          binding:"required"`
	Location               string `json:"location"`
	RTSPURL                string `json:"rtsp_url"      binding:"required"`
	SnapshotURL            string `json:"snapshot_url"`
	AutoReconnect          bool   `json:"auto_reconnect"`
	FaceRecognitionEnabled bool   `json:"face_recognition_enabled"`
}

type UpdateCameraRequest struct {
	Name                   *string `json:"name"`
	Location               *string `json:"location"`
	RTSPURL                *string `json:"rtsp_url"`
	SnapshotURL            *string `json:"snapshot_url"`
	AutoReconnect          *bool   `json:"auto_reconnect"`
	FaceRecognitionEnabled *bool   `json:"face_recognition_enabled"`
}

type StreamStatus struct {
	CameraID  string     `json:"camera_id"`
	Status    string     `json:"status"` // "live" | "offline" | "reconnecting"
	HLSURL    string     `json:"hls_url,omitempty"`
	StartedAt *time.Time `json:"started_at,omitempty"`
	Error     string     `json:"error,omitempty"`

	// LastFrameAt is when a frame last arrived from the camera, and Stalled
	// reports that a relay is running but no frames are arriving. Without these
	// a wedged stream is indistinguishable from one that is merely still
	// connecting: both read "reconnecting" forever.
	LastFrameAt         *time.Time `json:"last_frame_at,omitempty"`
	LastFrameAgeSeconds int64      `json:"last_frame_age_seconds,omitempty"`
	Stalled             bool       `json:"stalled,omitempty"`
}
