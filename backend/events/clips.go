// Package events turns face-service track lifecycle messages into persisted
// sighting events with thumbnails and HLS-derived video clips.
package events

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ClipCutter captures live HLS segments into per-event staging directories and
// losslessly stitches them into MP4 clips. HLS segments are short-lived
// (~10s window, ffmpeg delete_segments), so capture must begin the moment an
// event is confirmed — the segments on disk at Start time ARE the pre-roll.
type ClipCutter struct {
	hlsRoot  string // e.g. /tmp/sentry/streams
	clipsDir string // e.g. data/clips

	Poll     time.Duration
	PostRoll time.Duration
	MaxDur   time.Duration
	Stitch   func(listFile, outPath string) error

	mu     sync.Mutex
	active map[string]*capture
}

type capture struct {
	cameraID string
	staging  string
	copied   map[string]bool
	order    []string
	stopCh   chan struct{}
	stopped  bool
	done     func(clipPath string, err error)
}

func NewClipCutter(hlsRoot, clipsDir string) *ClipCutter {
	// Sweep orphaned staging directories left behind by an unclean shutdown
	// (process killed mid-capture); they're never referenced again.
	os.RemoveAll(filepath.Join(clipsDir, "staging"))
	return &ClipCutter{
		hlsRoot:  hlsRoot,
		clipsDir: clipsDir,
		Poll:     time.Second,
		PostRoll: 5 * time.Second,
		MaxDur:   2 * time.Minute,
		Stitch:   ffmpegStitch,
		active:   make(map[string]*capture),
	}
}

// Start begins capturing segments for an event. done is invoked exactly once —
// after Stop + PostRoll, or at MaxDur — with the final clip path or an error.
// A second Start for the same event is ignored.
func (c *ClipCutter) Start(eventID, cameraID string, done func(clipPath string, err error)) {
	c.mu.Lock()
	if _, exists := c.active[eventID]; exists {
		c.mu.Unlock()
		return
	}
	cap := &capture{
		cameraID: cameraID,
		staging:  filepath.Join(c.clipsDir, "staging", eventID),
		copied:   make(map[string]bool),
		stopCh:   make(chan struct{}),
		done:     done,
	}
	c.active[eventID] = cap
	c.mu.Unlock()
	go c.run(eventID, cap)
}

// Stop signals end-of-event; the capture continues for PostRoll then stitches.
// Stopping an unknown/finished event is a no-op.
func (c *ClipCutter) Stop(eventID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cap, ok := c.active[eventID]
	if !ok || cap.stopped {
		return
	}
	cap.stopped = true
	close(cap.stopCh)
}

func (c *ClipCutter) run(eventID string, cap *capture) {
	defer func() {
		c.mu.Lock()
		delete(c.active, eventID)
		c.mu.Unlock()
	}()

	if err := os.MkdirAll(cap.staging, 0755); err != nil {
		cap.done("", fmt.Errorf("clip staging: %w", err))
		return
	}

	c.copyNew(cap) // pre-roll: whatever is on disk right now

	deadline := time.NewTimer(c.MaxDur)
	defer deadline.Stop()
	ticker := time.NewTicker(c.Poll)
	defer ticker.Stop()

	stopCh := cap.stopCh
	var postRoll <-chan time.Time
	for {
		select {
		case <-ticker.C:
			c.copyNew(cap)
		case <-stopCh:
			stopCh = nil // nil channel blocks; select stops picking this case
			postRoll = time.After(c.PostRoll)
		case <-postRoll:
			c.copyNew(cap)
			c.stitchAndFinish(eventID, cap)
			return
		case <-deadline.C:
			c.copyNew(cap)
			c.stitchAndFinish(eventID, cap)
			return
		}
	}
}

func (c *ClipCutter) copyNew(cap *capture) {
	srcDir := filepath.Join(c.hlsRoot, cap.cameraID)
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return // stream not live yet / already gone
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || cap.copied[name] ||
			!strings.HasPrefix(name, "seg") || !strings.HasSuffix(name, ".ts") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(srcDir, name))
		if err != nil {
			continue // segment deleted between listing and read
		}
		if err := os.WriteFile(filepath.Join(cap.staging, name), data, 0644); err != nil {
			log.Printf("[clips] stage %s: %v", name, err)
			continue
		}
		cap.copied[name] = true
		cap.order = append(cap.order, name)
	}
}

func (c *ClipCutter) stitchAndFinish(eventID string, cap *capture) {
	// Staging must be gone BEFORE done fires: done is the completion signal,
	// and callers (and tests) may observe the filesystem the moment it runs.
	if len(cap.order) == 0 {
		os.RemoveAll(cap.staging)
		cap.done("", fmt.Errorf("no segments captured for event %s", eventID))
		return
	}
	// Sort by name: segment numbers increase monotonically within one encoder
	// run. If the encoder restarted mid-event the numbering resets and ordering
	// may be imperfect — the concat still produces a playable file.
	sort.Strings(cap.order)
	var b strings.Builder
	for _, name := range cap.order {
		fmt.Fprintf(&b, "file '%s'\n", filepath.Join(cap.staging, name))
	}
	listFile := filepath.Join(cap.staging, "list.txt")
	if err := os.WriteFile(listFile, []byte(b.String()), 0644); err != nil {
		os.RemoveAll(cap.staging)
		cap.done("", fmt.Errorf("clip list: %w", err))
		return
	}
	outPath := filepath.Join(c.clipsDir, eventID+".mp4")
	err := c.Stitch(listFile, outPath)
	os.RemoveAll(cap.staging)
	if err != nil {
		cap.done("", err)
		return
	}
	cap.done(outPath, nil)
}

func ffmpegStitch(listFile, outPath string) error {
	cmd := exec.Command("ffmpeg", "-loglevel", "error", "-y",
		"-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg concat: %v: %s", err, out)
	}
	return nil
}
