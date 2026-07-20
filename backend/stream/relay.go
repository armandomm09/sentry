package stream

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/dim/sentry/backend/models"
)

// Relay centralises frame delivery for one camera.
//
// It runs a FrameSource (RTSP or WS) and fans the incoming JPEG frames out to:
//   - an HLS encoder (ffmpeg reading MJPEG from stdin)
//   - any number of WebSocket subscribers (e.g. the face-service)
//
// The relay owns its own context so it can be stopped independently.
type Relay struct {
	cameraID string
	outDir   string

	cancel context.CancelFunc

	mu   sync.RWMutex
	subs map[chan []byte]struct{}

	stMu      sync.Mutex
	status    string // "live" | "reconnecting" | "offline"
	startedAt time.Time
	errMsg    string
}

func newRelay(cameraID, outDir string) *Relay {
	return &Relay{
		cameraID:  cameraID,
		outDir:    outDir,
		subs:      make(map[chan []byte]struct{}),
		status:    "reconnecting",
		startedAt: time.Now(),
	}
}

// start launches the source goroutine and the encoder-restart loop.
func (r *Relay) start(parent context.Context, source FrameSource) error {
	if err := os.MkdirAll(r.outDir, 0755); err != nil {
		return fmt.Errorf("relay mkdir %s: %w", r.outDir, err)
	}

	ctx, cancel := context.WithCancel(parent)
	r.cancel = cancel

	frames := make(chan []byte, 32)
	go source.Run(ctx, frames)
	go r.encoderLoop(ctx, frames)
	return nil
}

func (r *Relay) stop() {
	if r.cancel != nil {
		r.cancel()
	}
}

// encoderLoop starts the HLS encoder and runs distribute; on failure it restarts
// the encoder while keeping the source goroutine alive.
func (r *Relay) encoderLoop(ctx context.Context, frames <-chan []byte) {
	for {
		if ctx.Err() != nil {
			r.setStatus("offline", "")
			return
		}

		hlsIn, err := r.startHLSEncoder(ctx)
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("[relay] hls encoder start failed for %s: %v", r.cameraID, err)
			}
			select {
			case <-ctx.Done():
				r.setStatus("offline", "")
				return
			case <-time.After(3 * time.Second):
			}
			continue
		}

		r.distribute(ctx, frames, hlsIn)

		if ctx.Err() != nil {
			r.setStatus("offline", "")
			return
		}
		log.Printf("[relay] hls encoder for %s stopped, restarting in 3s", r.cameraID)
		select {
		case <-ctx.Done():
			r.setStatus("offline", "")
			return
		case <-time.After(3 * time.Second):
		}
	}
}

// startHLSEncoder launches ffmpeg reading MJPEG from stdin and emitting HLS.
// Uses os.Pipe() instead of cmd.StdinPipe() so we can set write deadlines and
// avoid blocking forever if the encoder process stops consuming input.
func (r *Relay) startHLSEncoder(ctx context.Context) (*os.File, error) {
	playlist := filepath.Join(r.outDir, "stream.m3u8")
	cmd := exec.CommandContext(ctx, "ffmpeg",
		"-loglevel", "error",
		"-f", "mjpeg",
		"-i", "pipe:0",
		"-c:v", "libx264",
		"-preset", "ultrafast",
		"-tune", "zerolatency",
		"-profile:v", "main",
		"-pix_fmt", "yuv420p",
		"-r", "10",
		"-g", "20",
		"-keyint_min", "20",
		"-sc_threshold", "0",
		"-an",
		"-f", "hls",
		"-hls_time", "2",
		"-hls_list_size", "5",
		// temp_file: ffmpeg writes segNNNNN.ts.tmp and renames atomically on
		// completion. Without it, the ClipCutter in backend/events/clips.go
		// (which copies live segments off disk while an event is recording)
		// can read a segment mid-write and produce a truncated clip.
		"-hls_flags", "delete_segments+independent_segments+program_date_time+temp_file",
		"-hls_segment_type", "mpegts",
		"-hls_segment_filename", filepath.Join(r.outDir, "seg%05d.ts"),
		playlist,
	)

	// os.Pipe gives us an *os.File write end that supports SetWriteDeadline,
	// preventing the relay from blocking if the encoder stops reading its stdin.
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd.Stdin = pr

	if err := cmd.Start(); err != nil {
		pr.Close()
		pw.Close()
		return nil, err
	}
	pr.Close() // child holds the read end; parent only needs the write end

	go func() {
		if err := cmd.Wait(); err != nil && ctx.Err() == nil {
			log.Printf("[relay] hls encoder for %s exited: %v", r.cameraID, err)
		}
	}()
	return pw, nil
}

func (r *Relay) distribute(ctx context.Context, frames <-chan []byte, hlsIn *os.File) {
	defer hlsIn.Close()
	r.setStatus("reconnecting", "")

	noFrameTicker := time.NewTicker(10 * time.Second)
	defer noFrameTicker.Stop()
	lastFrame := time.Time{}

	for {
		select {
		case <-ctx.Done():
			r.setStatus("offline", "")
			return

		case <-noFrameTicker.C:
			if !lastFrame.IsZero() && time.Since(lastFrame) > 15*time.Second {
				r.setStatus("reconnecting", "no frames received")
			}

		case frame, ok := <-frames:
			if !ok {
				return
			}
			lastFrame = time.Now()
			r.setStatus("live", "")

			// Write to HLS encoder with a deadline so a stuck encoder
			// (not reading stdin) causes distribute to return and encoderLoop
			// to restart the encoder instead of blocking forever.
			_ = hlsIn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if _, err := hlsIn.Write(frame); err != nil {
				if ctx.Err() == nil {
					log.Printf("[relay] hls write error for %s: %v; restarting encoder", r.cameraID, err)
					r.setStatus("reconnecting", "hls encoder error")
				}
				return
			}
			_ = hlsIn.SetWriteDeadline(time.Time{}) // clear deadline after successful write

			// Fan out to WebSocket subscribers (drop if slow).
			r.mu.RLock()
			for ch := range r.subs {
				select {
				case ch <- frame:
				default:
				}
			}
			r.mu.RUnlock()
		}
	}
}

func (r *Relay) setStatus(status, errMsg string) {
	r.stMu.Lock()
	defer r.stMu.Unlock()
	r.status = status
	r.errMsg = errMsg
}

// subscribe returns a channel that will receive JPEG frames while connected.
func (r *Relay) subscribe() chan []byte {
	ch := make(chan []byte, 16)
	r.mu.Lock()
	r.subs[ch] = struct{}{}
	r.mu.Unlock()
	return ch
}

// unsubscribe removes the channel from the fan-out list.
func (r *Relay) unsubscribe(ch chan []byte) {
	r.mu.Lock()
	delete(r.subs, ch)
	r.mu.Unlock()
}

// Status returns the current stream status, matching the models type used elsewhere.
func (r *Relay) Status() models.StreamStatus {
	r.stMu.Lock()
	status := r.status
	errMsg := r.errMsg
	startedAt := r.startedAt
	r.stMu.Unlock()

	hlsURL := ""
	if status == "live" {
		hlsURL = fmt.Sprintf("/hls/%s/stream.m3u8", r.cameraID)
	}
	return models.StreamStatus{
		CameraID:  r.cameraID,
		Status:    status,
		HLSURL:    hlsURL,
		StartedAt: &startedAt,
		Error:     errMsg,
	}
}
