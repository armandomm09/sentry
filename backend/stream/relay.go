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

// Tunables for the source watchdog. They are package vars (not consts) so tests
// can shrink them; production code never reassigns them.
var (
	// stallTimeout is how long a source may produce no frames before the relay
	// kills it and starts a fresh one. It must be comfortably larger than the
	// ffmpeg-side socket timeout (rtspSocketTimeout in source.go) so ffmpeg gets
	// the first chance to notice and exit on its own; this watchdog is the
	// backstop for when it does not.
	stallTimeout = 30 * time.Second

	// stallCheckInterval is how often the watchdog samples the stall clock.
	stallCheckInterval = time.Second

	// sourceRetryDelay is the pause between a source exiting and being restarted.
	sourceRetryDelay = 3 * time.Second
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

	stMu         sync.Mutex
	status       string // "live" | "reconnecting" | "offline"
	startedAt    time.Time
	errMsg       string
	lastFrameAt  time.Time // zero until the first frame ever arrives
	srcStartedAt time.Time // when the current source attempt began
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

// start launches the source supervisor and the encoder-restart loop.
func (r *Relay) start(parent context.Context, source FrameSource) error {
	if err := os.MkdirAll(r.outDir, 0755); err != nil {
		return fmt.Errorf("relay mkdir %s: %w", r.outDir, err)
	}

	ctx, cancel := context.WithCancel(parent)
	r.cancel = cancel

	// raw carries frames straight off the source; pump timestamps them (feeding
	// the stall watchdog) and forwards them to the encoder. Keeping the
	// watchdog on this side of the encoder means a broken HLS encoder can never
	// be mistaken for a dead camera.
	raw := make(chan []byte, 32)
	frames := make(chan []byte, 32)

	go r.sourceLoop(ctx, source, raw)
	go r.pump(ctx, raw, frames)
	go r.encoderLoop(ctx, frames)
	return nil
}

func (r *Relay) stop() {
	if r.cancel != nil {
		r.cancel()
	}
}

// sourceLoop keeps exactly one FrameSource running, restarting it whenever it
// exits or goes silent.
//
// A silently dead RTSP session is the failure this exists for: the camera stops
// sending but never closes the TCP connection, so the socket stays ESTABLISHED
// and ffmpeg blocks in poll() forever. Nothing downstream can unstick that —
// only killing the process can, which is what cancelling srcCtx does (the
// source builds its ffmpeg with exec.CommandContext).
func (r *Relay) sourceLoop(ctx context.Context, source FrameSource, out chan<- []byte) {
	for {
		if ctx.Err() != nil {
			return
		}

		srcCtx, srcCancel := context.WithCancel(ctx)
		r.markSourceStart()

		done := make(chan struct{})
		go func() {
			defer close(done)
			source.Run(srcCtx, out)
		}()

		stalled := r.awaitStallOrExit(srcCtx, done)
		srcCancel()
		<-done

		if ctx.Err() != nil {
			r.setStatus("offline", "")
			return
		}

		if stalled {
			log.Printf("[relay] source for %s produced no frames for %s; killed it and restarting",
				r.cameraID, stallTimeout)
			r.setStatus("reconnecting", "source stalled: no frames received")
		} else {
			log.Printf("[relay] source for %s exited, restarting in %s", r.cameraID, sourceRetryDelay)
			r.setStatus("reconnecting", "source exited")
		}

		select {
		case <-ctx.Done():
			r.setStatus("offline", "")
			return
		case <-time.After(sourceRetryDelay):
		}
	}
}

// awaitStallOrExit blocks until the source exits on its own (returns false) or
// goes quiet for longer than stallTimeout (returns true).
func (r *Relay) awaitStallOrExit(ctx context.Context, done <-chan struct{}) bool {
	ticker := time.NewTicker(stallCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return false
		case <-done:
			return false
		case <-ticker.C:
			if time.Since(r.stallClock()) > stallTimeout {
				return true
			}
		}
	}
}

// pump timestamps every frame that leaves the source and forwards it to the
// encoder, dropping frames if the encoder is backed up.
func (r *Relay) pump(ctx context.Context, in <-chan []byte, out chan<- []byte) {
	for {
		select {
		case <-ctx.Done():
			return
		case frame, ok := <-in:
			if !ok {
				return
			}
			r.markFrame()
			select {
			case out <- frame:
			default:
			}
		}
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
	// Without this ffmpeg's diagnostics go to /dev/null, which is why encoder
	// failures used to leave no trace in the logs at all.
	cmd.Stderr = newFFmpegLogWriter("hls "+r.cameraID, "")

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

	for {
		select {
		case <-ctx.Done():
			r.setStatus("offline", "")
			return

		case frame, ok := <-frames:
			if !ok {
				return
			}
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

// markFrame records that a frame just arrived from the source.
func (r *Relay) markFrame() {
	r.stMu.Lock()
	r.lastFrameAt = time.Now()
	r.stMu.Unlock()
}

// markSourceStart resets the stall clock for a freshly launched source, so a
// source gets a full stallTimeout to deliver its first frame.
func (r *Relay) markSourceStart() {
	r.stMu.Lock()
	r.srcStartedAt = time.Now()
	r.stMu.Unlock()
}

// stallClock is the instant the watchdog measures silence from: the later of
// the last frame and the current source's start.
func (r *Relay) stallClock() time.Time {
	r.stMu.Lock()
	defer r.stMu.Unlock()
	if r.lastFrameAt.After(r.srcStartedAt) {
		return r.lastFrameAt
	}
	return r.srcStartedAt
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
	lastFrameAt := r.lastFrameAt
	r.stMu.Unlock()

	hlsURL := ""
	if status == "live" {
		hlsURL = fmt.Sprintf("/hls/%s/stream.m3u8", r.cameraID)
	}

	st := models.StreamStatus{
		CameraID:  r.cameraID,
		Status:    status,
		HLSURL:    hlsURL,
		StartedAt: &startedAt,
		Error:     errMsg,
	}
	if !lastFrameAt.IsZero() {
		st.LastFrameAt = &lastFrameAt
		st.LastFrameAgeSeconds = int64(time.Since(lastFrameAt).Seconds())
	}
	// Stalled means "a relay is running but no frames are arriving" — the
	// condition that used to sit invisible behind a permanent "reconnecting".
	st.Stalled = time.Since(r.stallClock()) > stallTimeout
	return st
}
