package events

import (
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func writeSeg(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("ts-data-"+name), 0644); err != nil {
		t.Fatal(err)
	}
}

func fastCutter(t *testing.T) (*ClipCutter, string, string) {
	t.Helper()
	hlsRoot := t.TempDir()
	clipsDir := t.TempDir()
	c := NewClipCutter(hlsRoot, clipsDir)
	c.Poll = 20 * time.Millisecond
	c.PostRoll = 60 * time.Millisecond
	c.MaxDur = 2 * time.Second
	return c, hlsRoot, clipsDir
}

func TestCaptureCopiesPreRollAndNewSegments(t *testing.T) {
	c, hlsRoot, clipsDir := fastCutter(t)
	camDir := filepath.Join(hlsRoot, "cam1")
	os.MkdirAll(camDir, 0755)
	writeSeg(t, camDir, "seg00001.ts") // pre-roll: exists before Start
	writeSeg(t, camDir, "seg00002.ts")

	var gotList string
	c.Stitch = func(listFile, outPath string) error {
		data, err := os.ReadFile(listFile)
		if err != nil {
			return err
		}
		gotList = string(data)
		return os.WriteFile(outPath, []byte("mp4"), 0644)
	}

	doneCh := make(chan string, 1)
	c.Start("ev1", "cam1", func(clipPath string, err error) {
		if err != nil {
			t.Errorf("done err: %v", err)
		}
		doneCh <- clipPath
	})
	time.Sleep(50 * time.Millisecond)
	writeSeg(t, camDir, "seg00003.ts") // arrives during capture
	time.Sleep(50 * time.Millisecond)
	c.Stop("ev1")

	select {
	case clipPath := <-doneCh:
		if clipPath != filepath.Join(clipsDir, "ev1.mp4") {
			t.Fatalf("clip path: %s", clipPath)
		}
		if _, err := os.Stat(clipPath); err != nil {
			t.Fatalf("clip file: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("done never called")
	}
	for _, seg := range []string{"seg00001.ts", "seg00002.ts", "seg00003.ts"} {
		if !strings.Contains(gotList, seg) {
			t.Fatalf("list missing %s:\n%s", seg, gotList)
		}
	}
	if strings.Index(gotList, "seg00001.ts") > strings.Index(gotList, "seg00003.ts") {
		t.Fatalf("segments out of order:\n%s", gotList)
	}
	if _, err := os.Stat(filepath.Join(clipsDir, "staging", "ev1")); !os.IsNotExist(err) {
		t.Fatal("staging dir not cleaned up")
	}
}

func TestNoSegmentsYieldsError(t *testing.T) {
	c, hlsRoot, _ := fastCutter(t)
	os.MkdirAll(filepath.Join(hlsRoot, "cam1"), 0755)
	errCh := make(chan error, 1)
	c.Start("ev1", "cam1", func(_ string, err error) { errCh <- err })
	c.Stop("ev1")
	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected error for empty capture")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("done never called")
	}
}

func TestMaxDurationFinalizesWithoutStop(t *testing.T) {
	c, hlsRoot, _ := fastCutter(t)
	c.MaxDur = 80 * time.Millisecond
	camDir := filepath.Join(hlsRoot, "cam1")
	os.MkdirAll(camDir, 0755)
	writeSeg(t, camDir, "seg00001.ts")
	c.Stitch = func(listFile, outPath string) error {
		return os.WriteFile(outPath, []byte("mp4"), 0644)
	}
	doneCh := make(chan string, 1)
	c.Start("ev1", "cam1", func(clipPath string, err error) {
		if err != nil {
			t.Errorf("done err: %v", err)
		}
		doneCh <- clipPath
	})
	select {
	case p := <-doneCh:
		if p == "" {
			t.Fatal("expected clip path at max duration")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("done never called at max duration")
	}
	c.Stop("ev1") // late Stop after finalize must be a harmless no-op
}

func TestDuplicateStartIgnored(t *testing.T) {
	c, hlsRoot, _ := fastCutter(t)
	camDir := filepath.Join(hlsRoot, "cam1")
	os.MkdirAll(camDir, 0755)
	writeSeg(t, camDir, "seg00001.ts")
	c.Stitch = func(_, outPath string) error { return os.WriteFile(outPath, []byte("m"), 0644) }
	var calls atomic.Int32
	c.Start("ev1", "cam1", func(string, error) { calls.Add(1) })
	c.Start("ev1", "cam1", func(string, error) { calls.Add(100) }) // ignored
	c.Stop("ev1")
	time.Sleep(300 * time.Millisecond)
	if n := calls.Load(); n != 1 {
		t.Fatalf("done calls = %d, want 1", n)
	}
}
