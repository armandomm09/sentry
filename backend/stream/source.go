package stream

import (
	"bytes"
	"context"
	"io"
	"log"
	"os/exec"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

// FrameSource streams JPEG frames to the provided channel until ctx is cancelled.
// Implementations are responsible for reconnecting on transient failures.
type FrameSource interface {
	Run(ctx context.Context, out chan<- []byte)
	URL() string
}

// NewSource picks the right FrameSource based on the URL scheme.
func NewSource(url string) FrameSource {
	if strings.HasPrefix(url, "ws://") || strings.HasPrefix(url, "wss://") {
		return &WSSource{url: url}
	}
	return &RTSPSource{url: url}
}

// ─── RTSP source ────────────────────────────────────────────────────────────

// RTSPSource pulls JPEG frames from an RTSP stream using a local ffmpeg process.
type RTSPSource struct{ url string }

func (s *RTSPSource) URL() string { return s.url }

func (s *RTSPSource) Run(ctx context.Context, out chan<- []byte) {
	for {
		if ctx.Err() != nil {
			return
		}
		cmd := exec.CommandContext(ctx, "ffmpeg",
			"-loglevel", "error",
			"-rtsp_transport", "tcp",
			"-fflags", "nobuffer",
			"-i", s.url,
			"-map", "0:v:0",
			"-vf", "fps=10",
			"-f", "mjpeg",
			"-q:v", "5",
			"pipe:1",
		)
		r, err := cmd.StdoutPipe()
		if err != nil {
			log.Printf("[source] rtsp pipe error %s: %v", s.url, err)
			sleepCtx(ctx, 3*time.Second)
			continue
		}
		if err := cmd.Start(); err != nil {
			log.Printf("[source] rtsp ffmpeg start %s: %v", s.url, err)
			sleepCtx(ctx, 3*time.Second)
			continue
		}
		log.Printf("[source] rtsp started for %s", s.url)
		scanJPEGs(ctx, r, out)
		cmd.Wait()
		if ctx.Err() != nil {
			return
		}
		log.Printf("[source] rtsp lost %s, reconnecting in 3s", s.url)
		sleepCtx(ctx, 3*time.Second)
	}
}

// ─── WebSocket source ────────────────────────────────────────────────────────

// WSSource receives JPEG frames from an external WebSocket server.
// Sentry acts as the WebSocket CLIENT; the remote is a server (e.g. webcam_ws.py).
type WSSource struct{ url string }

func (s *WSSource) URL() string { return s.url }

var wsDialer = websocket.Dialer{HandshakeTimeout: 10 * time.Second}

func (s *WSSource) Run(ctx context.Context, out chan<- []byte) {
	for {
		if ctx.Err() != nil {
			return
		}
		conn, _, err := wsDialer.DialContext(ctx, s.url, nil)
		if err != nil {
			log.Printf("[source] ws connect %s: %v; retry in 3s", s.url, err)
			sleepCtx(ctx, 3*time.Second)
			continue
		}
		log.Printf("[source] ws connected to %s", s.url)
		for {
			if ctx.Err() != nil {
				conn.Close()
				return
			}
			mt, data, err := conn.ReadMessage()
			if err != nil {
				log.Printf("[source] ws read from %s: %v", s.url, err)
				break
			}
			if mt == websocket.BinaryMessage && len(data) > 0 {
				frame := make([]byte, len(data))
				copy(frame, data)
				select {
				case out <- frame:
				default: // drop if relay is backed up
				}
			}
		}
		conn.Close()
		if ctx.Err() != nil {
			return
		}
		log.Printf("[source] ws lost %s, reconnecting in 3s", s.url)
		sleepCtx(ctx, 3*time.Second)
	}
}

// ─── JPEG scanner ────────────────────────────────────────────────────────────

// scanJPEGs reads a raw MJPEG byte stream and sends complete JPEG frames to out.
// Uses FF D8 (SOI) and FF D9 (EOI) markers as frame boundaries. Inside JPEG
// scan data, FF bytes are byte-stuffed (FF 00), so FF D9 only appears as EOI.
func scanJPEGs(ctx context.Context, r io.Reader, out chan<- []byte) {
	var buf []byte
	tmp := make([]byte, 65536)
	soi := []byte{0xFF, 0xD8}
	eoi := []byte{0xFF, 0xD9}
	for {
		if ctx.Err() != nil {
			return
		}
		n, err := r.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			for {
				start := bytes.Index(buf, soi)
				if start < 0 {
					buf = buf[:0]
					break
				}
				end := bytes.Index(buf[start+2:], eoi)
				if end < 0 {
					if start > 0 {
						buf = buf[start:]
					}
					break
				}
				end = start + 2 + end + 2 // include FF D9
				frame := make([]byte, end-start)
				copy(frame, buf[start:end])
				select {
				case out <- frame:
				default:
				}
				buf = buf[end:]
			}
		}
		if err != nil {
			return
		}
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
