// Package face wraps the Python face-recognition microservice.
//
// The Go backend talks to face-service over plain HTTP for control operations
// (enable/disable cameras, sync state on boot). The frontend reaches the JSON
// person/photo APIs through a reverse proxy mounted under /api, and reaches the
// detection WebSocket through a separate /face mount.
package face

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"time"
)

type Client struct {
	baseURL string
	http    *http.Client
}

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		http: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// BaseURL exposes the configured upstream so the reverse proxy can target it.
func (c *Client) BaseURL() string { return c.baseURL }

// Health returns nil if the face-service is reachable and reports OK.
func (c *Client) Health(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/health", nil)
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("face-service health: status %d", res.StatusCode)
	}
	return nil
}

// EnableCamera starts (or recycles) the face-rec worker for a camera.
// The worker connects to the Go relay via WebSocket; no source URL is needed here.
func (c *Client) EnableCamera(ctx context.Context, cameraID string) error {
	body, _ := json.Marshal(map[string]string{
		"camera_id": cameraID,
	})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/cameras", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		msg, _ := io.ReadAll(res.Body)
		return fmt.Errorf("face-service enable: status %d: %s", res.StatusCode, msg)
	}
	return nil
}

// DisableCamera tells face-service to stop processing for a camera. 404 is fine.
func (c *Client) DisableCamera(ctx context.Context, cameraID string) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodDelete,
		c.baseURL+"/cameras/"+cameraID, nil)
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 && res.StatusCode != http.StatusNotFound {
		msg, _ := io.ReadAll(res.Body)
		return fmt.Errorf("face-service disable: status %d: %s", res.StatusCode, msg)
	}
	return nil
}

// CreatePerson creates a person record in the face-service and returns its id.
func (c *Client) CreatePerson(ctx context.Context, name string) (string, error) {
	body, _ := json.Marshal(map[string]string{"name": name})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/persons", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		msg, _ := io.ReadAll(res.Body)
		return "", fmt.Errorf("face-service create person: status %d: %s", res.StatusCode, msg)
	}
	var person struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&person); err != nil || person.ID == "" {
		return "", fmt.Errorf("face-service create person: bad response (%v)", err)
	}
	return person.ID, nil
}

// UploadPhoto enrolls a JPEG as a recognition photo for an existing person.
// The face-service extracts the embedding, generates augmented variants, and
// rebuilds the match index.
func (c *Client) UploadPhoto(ctx context.Context, personID string, jpeg []byte, filename string) error {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, err := w.CreateFormFile("photo", filename)
	if err != nil {
		return err
	}
	if _, err := fw.Write(jpeg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/persons/"+personID+"/photos", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		msg, _ := io.ReadAll(res.Body)
		return fmt.Errorf("face-service upload photo: status %d: %s", res.StatusCode, msg)
	}
	return nil
}
