package face

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCreatePerson(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/persons" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "Maria" {
			t.Errorf("name = %q", body["name"])
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{"id": "pid-123", "name": "Maria"})
	}))
	defer srv.Close()

	id, err := NewClient(srv.URL).CreatePerson(context.Background(), "Maria")
	if err != nil {
		t.Fatal(err)
	}
	if id != "pid-123" {
		t.Fatalf("id = %q", id)
	}
}

func TestCreatePersonErrorSurfaced(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"name is required"}`))
	}))
	defer srv.Close()
	if _, err := NewClient(srv.URL).CreatePerson(context.Background(), ""); err == nil {
		t.Fatal("expected error")
	}
}

func TestUploadPhoto(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/persons/pid-123/photos" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("multipart: %v", err)
		}
		f, hdr, err := r.FormFile("photo")
		if err != nil {
			t.Fatalf("no photo field: %v", err)
		}
		defer f.Close()
		if hdr.Filename != "event-1.jpg" {
			t.Errorf("filename = %q", hdr.Filename)
		}
		data, _ := io.ReadAll(f)
		if string(data) != "jpegbytes" {
			t.Errorf("payload = %q", data)
		}
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"added":[{}],"errors":[]}`))
	}))
	defer srv.Close()

	err := NewClient(srv.URL).UploadPhoto(context.Background(), "pid-123", []byte("jpegbytes"), "event-1.jpg")
	if err != nil {
		t.Fatal(err)
	}
}

func TestUploadPhotoNoFaceSurfaced(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"added":[],"errors":[{"error":"no face found"}]}`))
	}))
	defer srv.Close()
	err := NewClient(srv.URL).UploadPhoto(context.Background(), "p", []byte("x"), "f.jpg")
	if err == nil {
		t.Fatal("expected error")
	}
}
