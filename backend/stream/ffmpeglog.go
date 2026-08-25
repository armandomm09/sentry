package stream

import (
	"bytes"
	"log"
	"strings"
	"sync"
)

// ffmpegLogWriter forwards an ffmpeg process's stderr into the service log,
// line by line and with a hard cap on how much is kept in memory.
//
// ffmpeg's stderr used to be discarded (exec leaves Stderr nil => /dev/null),
// which is why a camera could sit broken for days without producing a single
// diagnostic line. Everything written here is redacted first: RTSP URLs carry
// camera credentials and these lines end up in `docker logs` / the Coolify UI.
type ffmpegLogWriter struct {
	tag    string
	secret string // a URL whose credentials must never reach the log

	mu  sync.Mutex
	buf bytes.Buffer
}

const ffmpegLogMaxLine = 8 << 10 // drop absurdly long lines rather than grow forever

func newFFmpegLogWriter(tag, secret string) *ffmpegLogWriter {
	return &ffmpegLogWriter{tag: tag, secret: secret}
}

func (w *ffmpegLogWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.buf.Write(p)
	for {
		line, err := w.buf.ReadString('\n')
		if err != nil {
			// No complete line yet; keep the remainder unless it is runaway.
			if w.buf.Len() > ffmpegLogMaxLine {
				w.buf.Reset()
			} else {
				w.buf.WriteString(line)
			}
			break
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			continue
		}
		log.Printf("[ffmpeg %s] %s", w.tag, w.redact(line))
	}
	return len(p), nil
}

func (w *ffmpegLogWriter) redact(line string) string {
	if w.secret != "" {
		line = strings.ReplaceAll(line, w.secret, redactURL(w.secret))
	}
	return line
}

// redactURL replaces the password in a URL's userinfo with "***" so stream URLs
// can be logged safely.
//
// This is deliberately textual rather than url.Parse-based: camera passwords in
// this deployment contain unescaped "@" (e.g. "rtsp://admin:Pass@@10.0.0.5/..."),
// which url.Parse rejects or mangles, and url.String() would re-encode the "***"
// into "%2A%2A%2A". Splitting on the last "@" of the authority matches how
// ffmpeg and most RTSP stacks read these URLs.
func redactURL(raw string) string {
	schemeEnd := strings.Index(raw, "://")
	if schemeEnd < 0 {
		return raw
	}
	authStart := schemeEnd + 3

	authEnd := len(raw)
	if i := strings.IndexAny(raw[authStart:], "/?#"); i >= 0 {
		authEnd = authStart + i
	}
	authority := raw[authStart:authEnd]

	at := strings.LastIndex(authority, "@")
	if at < 0 {
		return raw
	}
	userinfo := authority[:at]

	colon := strings.Index(userinfo, ":")
	if colon < 0 {
		return raw // user only, no password to hide
	}

	return raw[:authStart] + userinfo[:colon] + ":***" + raw[authStart+at:]
}
