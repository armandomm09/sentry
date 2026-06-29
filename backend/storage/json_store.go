package storage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/dim/sentry/backend/models"
)

type JSONStore struct {
	mu       sync.RWMutex
	filePath string
	cameras  map[string]*models.Camera
}

func NewJSONStore(dir string) (*JSONStore, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create storage dir: %w", err)
	}
	s := &JSONStore{
		filePath: filepath.Join(dir, "cameras.json"),
		cameras:  make(map[string]*models.Camera),
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *JSONStore) load() error {
	data, err := os.ReadFile(s.filePath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read storage file: %w", err)
	}
	var cameras []*models.Camera
	if err := json.Unmarshal(data, &cameras); err != nil {
		return fmt.Errorf("parse storage file: %w", err)
	}
	for _, c := range cameras {
		s.cameras[c.ID] = c
	}
	return nil
}

func (s *JSONStore) save() error {
	list := make([]*models.Camera, 0, len(s.cameras))
	for _, c := range s.cameras {
		list = append(list, c)
	}
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal cameras: %w", err)
	}
	return os.WriteFile(s.filePath, data, 0644)
}

func (s *JSONStore) List() []*models.Camera {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := make([]*models.Camera, 0, len(s.cameras))
	for _, c := range s.cameras {
		list = append(list, c)
	}
	return list
}

func (s *JSONStore) Get(id string) (*models.Camera, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.cameras[id]
	return c, ok
}

func (s *JSONStore) Create(c *models.Camera) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cameras[c.ID] = c
	return s.save()
}

func (s *JSONStore) Update(c *models.Camera) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cameras[c.ID] = c
	return s.save()
}

func (s *JSONStore) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.cameras, id)
	return s.save()
}

// GetCameraName returns the camera name for a given ID, or the ID itself if not found.
func (s *JSONStore) GetCameraName(id string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if c, ok := s.cameras[id]; ok {
		return c.Name
	}
	return id
}
