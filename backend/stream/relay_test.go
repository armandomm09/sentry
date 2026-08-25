package stream

import (
	"context"
	"sync"
	"testing"
	"time"
)

// hangingSource reproduces the production failure: it delivers a few frames and
// then blocks forever, exactly like ffmpeg stuck in poll() on an RTSP socket
// that stays ESTABLISHED after the camera goes silent. It only ever returns
// when its context is cancelled — i.e. when something kills it.
type hangingSource struct {
	framesPerRun int

	mu   sync.Mutex
	runs int
}

func (s *hangingSource) URL() string { return "test://hanging" }

func (s *hangingSource) Run(ctx context.Context, out chan<- []byte) {
	s.mu.Lock()
	s.runs++
	s.mu.Unlock()

	for i := 0; i < s.framesPerRun; i++ {
		select {
		case out <- []byte{0xFF, 0xD8, 0xFF, 0xD9}:
		case <-ctx.Done():
			return
		}
	}
	<-ctx.Done() // hang until killed
}

func (s *hangingSource) runCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs
}

// shrinkWatchdog makes the watchdog fire in milliseconds instead of seconds.
func shrinkWatchdog(t *testing.T) {
	t.Helper()
	origTimeout, origInterval, origRetry := stallTimeout, stallCheckInterval, sourceRetryDelay
	stallTimeout = 150 * time.Millisecond
	stallCheckInterval = 10 * time.Millisecond
	sourceRetryDelay = 10 * time.Millisecond
	t.Cleanup(func() {
		stallTimeout, stallCheckInterval, sourceRetryDelay = origTimeout, origInterval, origRetry
	})
}

func TestSourceLoopRestartsStalledSource(t *testing.T) {
	shrinkWatchdog(t)

	src := &hangingSource{framesPerRun: 2}
	r := newRelay("cam-stall", t.TempDir())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	raw := make(chan []byte, 32)
	go r.sourceLoop(ctx, src, raw)
	go r.pump(ctx, raw, make(chan []byte, 32))

	// A source that hangs forever must be killed and restarted repeatedly.
	deadline := time.After(3 * time.Second)
	for src.runCount() < 3 {
		select {
		case <-deadline:
			t.Fatalf("stalled source was never restarted: got %d runs, want >= 3", src.runCount())
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestStalledSourceIsReportedInStatus(t *testing.T) {
	shrinkWatchdog(t)

	src := &hangingSource{framesPerRun: 1}
	r := newRelay("cam-status", t.TempDir())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	raw := make(chan []byte, 32)
	go r.sourceLoop(ctx, src, raw)
	go r.pump(ctx, raw, make(chan []byte, 32))

	// Wait until a frame has been seen, so LastFrameAt is populated.
	deadline := time.After(2 * time.Second)
	for {
		if st := r.Status(); st.LastFrameAt != nil {
			break
		}
		select {
		case <-deadline:
			t.Fatal("no frame was ever recorded")
		case <-time.After(5 * time.Millisecond):
		}
	}

	// Once the source goes quiet past stallTimeout, Status must say so instead
	// of silently reporting "reconnecting" forever.
	deadline = time.After(2 * time.Second)
	for {
		st := r.Status()
		if st.Stalled && st.Status == "reconnecting" {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("stall never surfaced in status: %+v", r.Status())
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// healthySource keeps delivering frames; the watchdog must leave it alone.
type healthySource struct {
	mu   sync.Mutex
	runs int
}

func (s *healthySource) URL() string { return "test://healthy" }

func (s *healthySource) Run(ctx context.Context, out chan<- []byte) {
	s.mu.Lock()
	s.runs++
	s.mu.Unlock()

	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			select {
			case out <- []byte{0xFF, 0xD8, 0xFF, 0xD9}:
			case <-ctx.Done():
				return
			}
		}
	}
}

func (s *healthySource) runCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runs
}

func TestHealthySourceIsNotRestarted(t *testing.T) {
	shrinkWatchdog(t)

	src := &healthySource{}
	r := newRelay("cam-ok", t.TempDir())

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	raw := make(chan []byte, 32)
	go r.sourceLoop(ctx, src, raw)
	go r.pump(ctx, raw, make(chan []byte, 32))

	time.Sleep(1 * time.Second) // many stallTimeouts' worth of healthy traffic

	if got := src.runCount(); got != 1 {
		t.Fatalf("healthy source was restarted %d times, want exactly 1", got)
	}
	if st := r.Status(); st.Stalled {
		t.Fatalf("healthy source reported as stalled: %+v", st)
	}
}

func TestRedactURLHidesPassword(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"basic", "rtsp://admin:hunter2@10.0.0.5:554/Streaming/Channels/101",
			"rtsp://admin:***@10.0.0.5:554/Streaming/Channels/101"},
		{"no credentials", "rtsp://10.0.0.5:554/Streaming/Channels/101",
			"rtsp://10.0.0.5:554/Streaming/Channels/101"},
		// Real cameras in this deployment use passwords containing "@", which
		// url.Parse cannot handle; the authority must split on the last "@".
		{"at sign in password", "rtsp://admin:HuaweiPass@@172.17.5.200:554/Streaming/Channels/101",
			"rtsp://admin:***@172.17.5.200:554/Streaming/Channels/101"},
		{"user only", "rtsp://admin@10.0.0.5:554/x", "rtsp://admin@10.0.0.5:554/x"},
		{"not a url", "pipe:1", "pipe:1"},
	}
	for _, c := range cases {
		if got := redactURL(c.in); got != c.want {
			t.Errorf("%s: redactURL(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
	if got := redactURL("rtsp://admin:hunter2@10.0.0.5:554/x"); got == "rtsp://admin:hunter2@10.0.0.5:554/x" {
		t.Error("password survived redaction")
	}
}
