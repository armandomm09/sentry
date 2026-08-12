package handlers

import (
	"crypto/md5"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// snapshotTimeout bounds a single upstream camera fetch. Cameras on a flaky
// LAN can hang the connection open, and the client is refreshing on an
// interval — a slow snapshot is worth less than a fast failure.
const snapshotTimeout = 5 * time.Second

// snapshotMaxBytes caps what we relay from the camera. A JPEG still from a 4K
// sensor is well under this; anything larger is a misconfigured URL pointing at
// something that is not a snapshot endpoint.
const snapshotMaxBytes = 8 << 20 // 8 MiB

// snapshotClient is the HTTP client used to reach cameras. It is a package
// variable so tests can swap in an httptest-backed transport.
var snapshotClient = &http.Client{Timeout: snapshotTimeout}

// Snapshot proxies the camera's still-image endpoint through the API.
//
// Cameras live on a private network the mobile app cannot reach, so clients
// must not fetch snapshot_url directly. This handler runs inside that network,
// fetches the JPEG, and relays it over the authenticated API connection the
// client already has.
func (h *CameraHandler) Snapshot(c *gin.Context) {
	cam, ok := h.store.Get(c.Param("id"))
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "camera not found"})
		return
	}

	raw := strings.TrimSpace(cam.SnapshotURL)
	if raw == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "camera has no snapshot url"})
		return
	}

	target, err := url.Parse(raw)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "camera snapshot url is not a valid http(s) url"})
		return
	}

	// Credentials travel out-of-band via digest auth (or a plain Basic
	// header) — never on the request line, and never as Go's automatic
	// Basic-from-URL-userinfo, which Hikvision-style cameras reject outright.
	user := target.User
	target.User = nil

	req, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "camera snapshot url is not a valid http(s) url"})
		return
	}

	resp, err := snapshotClient.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "camera snapshot unreachable"})
		return
	}

	// Many IP cameras (Hikvision ISAPI, etc.) require HTTP Digest auth on
	// their snapshot endpoint and reject Basic auth outright. net/http has
	// no built-in digest support, so on a digest challenge we complete the
	// handshake ourselves and retry once.
	if resp.StatusCode == http.StatusUnauthorized && user != nil {
		if challenge := resp.Header.Get("WWW-Authenticate"); strings.HasPrefix(challenge, "Digest ") {
			resp.Body.Close()
			retryReq, err := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, target.String(), nil)
			if err == nil {
				if header, err := digestAuthHeader(challenge, user, http.MethodGet, target.RequestURI()); err == nil {
					retryReq.Header.Set("Authorization", header)
					resp, err = snapshotClient.Do(retryReq)
					if err != nil {
						c.JSON(http.StatusBadGateway, gin.H{"error": "camera snapshot unreachable"})
						return
					}
				}
			}
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		c.JSON(http.StatusBadGateway, gin.H{"error": "camera snapshot returned " + resp.Status})
		return
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "image/jpeg"
	}

	// Stills change every refresh; caching them would defeat the client's
	// interval and can serve a stale frame after the camera goes offline.
	c.Header("Cache-Control", "no-store")
	c.DataFromReader(http.StatusOK, -1, contentType, io.LimitReader(resp.Body, snapshotMaxBytes), nil)
}

var digestParamRe = regexp.MustCompile(`(\w+)=(?:"([^"]*)"|([^\s,]+))`)

// digestAuthHeader completes an RFC 2617 "qop=auth" digest handshake and
// returns the Authorization header value for the retried request. Only
// qop=auth is supported — that covers every camera we've seen in the field
// (Hikvision ISAPI); auth-int is not implemented.
func digestAuthHeader(challenge string, user *url.Userinfo, method, uri string) (string, error) {
	params := map[string]string{}
	for _, m := range digestParamRe.FindAllStringSubmatch(challenge, -1) {
		val := m[2]
		if val == "" {
			val = m[3]
		}
		params[m[1]] = val
	}

	realm, nonce := params["realm"], params["nonce"]
	if realm == "" || nonce == "" {
		return "", fmt.Errorf("digest challenge missing realm/nonce")
	}
	qop := params["qop"]
	if qop != "" && !strings.Contains(qop, "auth") {
		return "", fmt.Errorf("unsupported digest qop %q", qop)
	}

	password, _ := user.Password()
	cnonce, err := randomHex(8)
	if err != nil {
		return "", err
	}
	const nc = "00000001"

	ha1 := md5Hex(user.Username() + ":" + realm + ":" + password)
	ha2 := md5Hex(method + ":" + uri)

	var response string
	if qop != "" {
		response = md5Hex(strings.Join([]string{ha1, nonce, nc, cnonce, "auth", ha2}, ":"))
	} else {
		response = md5Hex(strings.Join([]string{ha1, nonce, ha2}, ":"))
	}

	header := fmt.Sprintf(`Digest username=%q, realm=%q, nonce=%q, uri=%q, response=%q`,
		user.Username(), realm, nonce, uri, response)
	if qop != "" {
		header += fmt.Sprintf(`, qop=auth, nc=%s, cnonce=%q`, nc, cnonce)
	}
	if opaque := params["opaque"]; opaque != "" {
		header += fmt.Sprintf(`, opaque=%q`, opaque)
	}
	return header, nil
}

func md5Hex(s string) string {
	sum := md5.Sum([]byte(s))
	return hex.EncodeToString(sum[:])
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
