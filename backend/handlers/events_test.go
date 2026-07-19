package handlers

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/dim/sentry/backend/db"
	"github.com/gin-gonic/gin"
)

type fakeEnroller struct {
	created  []string
	uploads  []string // personIDs
	createID string
	fail     bool
}

func (f *fakeEnroller) CreatePerson(_ context.Context, name string) (string, error) {
	if f.fail {
		return "", fmt.Errorf("face-service down")
	}
	f.created = append(f.created, name)
	return f.createID, nil
}

func (f *fakeEnroller) UploadPhoto(_ context.Context, personID string, _ []byte, _ string) error {
	if f.fail {
		return fmt.Errorf("face-service down")
	}
	f.uploads = append(f.uploads, personID)
	return nil
}

func embBytes(dim int) []byte {
	b := make([]byte, 512*4)
	binary.LittleEndian.PutUint32(b[dim*4:], math.Float32bits(1.0))
	return b
}

func setupEvents(t *testing.T) (*gin.Engine, *db.DB, *fakeEnroller, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	enroller := &fakeEnroller{createID: "new-pid"}
	h := NewEventsHandler(d, enroller)
	r := gin.New()
	r.GET("/api/events", h.List)
	r.GET("/api/events/:id", h.Get)
	r.GET("/api/events/:id/thumb", h.Thumb)
	r.GET("/api/events/:id/clip", h.Clip)
	r.POST("/api/events/:id/label", h.Label)
	return r, d, enroller, t.TempDir()
}

func doReq(t *testing.T, r *gin.Engine, method, url string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		rd = bytes.NewReader(data)
	} else {
		rd = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, url, rd)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestListAndGet(t *testing.T) {
	r, d, _, files := setupEvents(t)
	thumb := filepath.Join(files, "e1.jpg")
	os.WriteFile(thumb, []byte("jpg"), 0644)
	e1 := &db.Event{CameraID: "cam1", TrackKey: "k1", PersonID: "p1",
		PersonName: "Alice", StartedAt: 100, ThumbPath: thumb}
	e2 := &db.Event{CameraID: "cam2", TrackKey: "k2", StartedAt: 200}
	d.CreateEvent(e1)
	d.CreateEvent(e2)

	w := doReq(t, r, "GET", "/api/events", nil)
	if w.Code != 200 {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		Events []map[string]any `json:"events"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Events) != 2 {
		t.Fatalf("events: %d", len(resp.Events))
	}
	if resp.Events[0]["camera_id"] != "cam2" { // DESC
		t.Fatalf("order: %+v", resp.Events[0])
	}
	if resp.Events[1]["thumb_url"] != "/api/events/"+e1.ID+"/thumb" {
		t.Fatalf("thumb_url: %+v", resp.Events[1])
	}
	if resp.Events[0]["person_id"] != nil {
		t.Fatalf("unknown person_id must be null: %+v", resp.Events[0])
	}

	w = doReq(t, r, "GET", "/api/events?unknown=1", nil)
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Events) != 1 {
		t.Fatalf("unknown filter: %d", len(resp.Events))
	}

	w = doReq(t, r, "GET", "/api/events/"+e1.ID, nil)
	if w.Code != 200 {
		t.Fatalf("get: %d", w.Code)
	}
	w = doReq(t, r, "GET", "/api/events/nope", nil)
	if w.Code != 404 {
		t.Fatalf("get missing: %d", w.Code)
	}
}

func TestThumbAndClipServing(t *testing.T) {
	r, d, _, files := setupEvents(t)
	thumb := filepath.Join(files, "t.jpg")
	clip := filepath.Join(files, "c.mp4")
	os.WriteFile(thumb, []byte("jpgdata"), 0644)
	os.WriteFile(clip, []byte("mp4data"), 0644)
	e := &db.Event{CameraID: "c", TrackKey: "k", StartedAt: 1, ThumbPath: thumb}
	d.CreateEvent(e)
	d.SetEventClip(e.ID, clip, 9_999_999_999_999)

	if w := doReq(t, r, "GET", "/api/events/"+e.ID+"/thumb", nil); w.Code != 200 || w.Body.String() != "jpgdata" {
		t.Fatalf("thumb: %d", w.Code)
	}
	if w := doReq(t, r, "GET", "/api/events/"+e.ID+"/clip", nil); w.Code != 200 || w.Body.String() != "mp4data" {
		t.Fatalf("clip: %d", w.Code)
	}

	d.MarkClipExpired(e.ID)
	if w := doReq(t, r, "GET", "/api/events/"+e.ID+"/clip", nil); w.Code != 410 {
		t.Fatalf("expired clip: %d", w.Code)
	}

	noClip := &db.Event{CameraID: "c", TrackKey: "k2", StartedAt: 2}
	d.CreateEvent(noClip)
	if w := doReq(t, r, "GET", "/api/events/"+noClip.ID+"/clip", nil); w.Code != 404 {
		t.Fatalf("missing clip: %d", w.Code)
	}
	if w := doReq(t, r, "GET", "/api/events/"+noClip.ID+"/thumb", nil); w.Code != 404 {
		t.Fatalf("missing thumb: %d", w.Code)
	}
}

func TestLabelExistingPersonWithRetroLabel(t *testing.T) {
	r, d, enroller, files := setupEvents(t)
	thumb := filepath.Join(files, "u1.jpg")
	os.WriteFile(thumb, []byte("jpegbytes"), 0644)

	target := &db.Event{CameraID: "c", TrackKey: "k1", StartedAt: 1,
		ThumbPath: thumb, Embedding: embBytes(0)}
	similar := &db.Event{CameraID: "c", TrackKey: "k2", StartedAt: 2, Embedding: embBytes(0)}   // cos=1.0
	different := &db.Event{CameraID: "c", TrackKey: "k3", StartedAt: 3, Embedding: embBytes(9)} // cos=0
	for _, e := range []*db.Event{target, similar, different} {
		d.CreateEvent(e)
	}

	w := doReq(t, r, "POST", "/api/events/"+target.ID+"/label", map[string]string{"person_id": "p7"})
	if w.Code != 200 {
		t.Fatalf("label: %d %s", w.Code, w.Body.String())
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["labeled_person_id"] != "p7" || resp["retro_labeled"] != float64(1) {
		t.Fatalf("resp: %+v", resp)
	}
	if len(enroller.uploads) != 1 || enroller.uploads[0] != "p7" {
		t.Fatalf("uploads: %v", enroller.uploads)
	}
	if len(enroller.created) != 0 {
		t.Fatalf("no person should be created: %v", enroller.created)
	}
	got, _, _ := d.GetEvent(similar.ID)
	if got.LabeledPersonID != "p7" {
		t.Fatal("similar unknown not retro-labeled")
	}
	got, _, _ = d.GetEvent(different.ID)
	if got.LabeledPersonID != "" {
		t.Fatal("dissimilar unknown wrongly retro-labeled")
	}
}

func TestLabelNewPerson(t *testing.T) {
	r, d, enroller, files := setupEvents(t)
	thumb := filepath.Join(files, "u1.jpg")
	os.WriteFile(thumb, []byte("jpegbytes"), 0644)
	e := &db.Event{CameraID: "c", TrackKey: "k1", StartedAt: 1, ThumbPath: thumb}
	d.CreateEvent(e)

	w := doReq(t, r, "POST", "/api/events/"+e.ID+"/label", map[string]string{"new_person_name": "Maria"})
	if w.Code != 200 {
		t.Fatalf("label: %d %s", w.Code, w.Body.String())
	}
	if len(enroller.created) != 1 || enroller.created[0] != "Maria" {
		t.Fatalf("created: %v", enroller.created)
	}
	got, _, _ := d.GetEvent(e.ID)
	if got.LabeledPersonID != "new-pid" {
		t.Fatalf("labeled: %+v", got)
	}
}

func TestLabelValidation(t *testing.T) {
	r, d, enroller, files := setupEvents(t)
	thumb := filepath.Join(files, "t.jpg")
	os.WriteFile(thumb, []byte("j"), 0644)

	known := &db.Event{CameraID: "c", TrackKey: "k1", PersonID: "p1", StartedAt: 1, ThumbPath: thumb}
	noThumb := &db.Event{CameraID: "c", TrackKey: "k2", StartedAt: 2}
	unknown := &db.Event{CameraID: "c", TrackKey: "k3", StartedAt: 3, ThumbPath: thumb}
	for _, e := range []*db.Event{known, noThumb, unknown} {
		d.CreateEvent(e)
	}

	if w := doReq(t, r, "POST", "/api/events/"+known.ID+"/label", map[string]string{"person_id": "p2"}); w.Code != 400 {
		t.Fatalf("known event labelable: %d", w.Code)
	}
	if w := doReq(t, r, "POST", "/api/events/"+noThumb.ID+"/label", map[string]string{"person_id": "p2"}); w.Code != 400 {
		t.Fatalf("no-thumb labelable: %d", w.Code)
	}
	if w := doReq(t, r, "POST", "/api/events/"+unknown.ID+"/label", map[string]string{}); w.Code != 400 {
		t.Fatalf("empty body accepted: %d", w.Code)
	}
	if w := doReq(t, r, "POST", "/api/events/nope/label", map[string]string{"person_id": "p"}); w.Code != 404 {
		t.Fatalf("missing event: %d", w.Code)
	}
	enroller.fail = true
	if w := doReq(t, r, "POST", "/api/events/"+unknown.ID+"/label", map[string]string{"person_id": "p2"}); w.Code != 502 {
		t.Fatalf("enroller failure: %d", w.Code)
	}
	got, _, _ := d.GetEvent(unknown.ID)
	if got.LabeledPersonID != "" {
		t.Fatal("label persisted despite enroll failure")
	}
}

func TestCosine(t *testing.T) {
	if c := cosineSim(embBytes(0), embBytes(0)); c < 0.999 {
		t.Fatalf("identical: %f", c)
	}
	if c := cosineSim(embBytes(0), embBytes(5)); c > 0.001 {
		t.Fatalf("orthogonal: %f", c)
	}
	if c := cosineSim([]byte{1, 2}, embBytes(0)); c != -1 {
		t.Fatalf("mismatched lengths: %f", c)
	}
}
