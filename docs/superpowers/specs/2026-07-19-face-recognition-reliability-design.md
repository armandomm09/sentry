# Face Recognition Reliability & Sighting Events — Design

**Date:** 2026-07-19
**Status:** Approved

## Problem

Recognition "kind of works" but is unreliable in practice:

1. Faces far from the camera are labeled unknown, or the identity wiggles
   between a known person and unknown from frame to frame.
2. Notifications are noisy: the identity wiggle creates separate cooldown keys
   for "unknown" and the person, so both fire; there is no way to say "only
   notify me if this person hasn't been seen for a while."
3. There is no record of sightings: no clips, no history, no way to review
   past unknowns or use them to improve recognition.

Root causes found in the code:

- `MatchIndex` uses a single fixed threshold (0.42). Far faces produce
  embeddings whose similarity hovers around it, so each frame lands randomly
  above/below and the per-track majority vote in `tracker.py` keeps flipping.
- Every frame's vote counts equally regardless of face size or detector
  confidence; there is no hysteresis once an identity is established.
- `push/listener.go` reacts per-frame with a 60s cooldown keyed by
  `camera:person`; identity flips create two keys and two notifications.
- No event concept exists anywhere — notifications are stateless reactions.

## Decisions (user-confirmed)

- Notification policy: **configurable per device/subscription**, separately
  for known and unknown persons.
- Unknown review: crop can be **assigned to an existing person OR used to
  create a new person**.
- Retention: **clips expire at 72h; event records + thumbnails kept 90 days**
  (both configurable).
- UI: **web and mobile both** in this effort.
- Architecture: **face-service owns tracking, Go owns events** (split), using
  the existing detection WebSocket as the transport.

## Section 1 — Recognition robustness (face-service)

All new knobs are env-configurable via `config.py` with the defaults below.

**Quality gating.** A frame casts an identity vote only if:
- face bbox height ≥ `FACE_SERVICE_MIN_VOTE_FACE_PX` (default 48, at
  processing resolution), and
- detector score ≥ `FACE_SERVICE_MIN_VOTE_DET_SCORE` (default 0.6).

Low-quality frames keep the track alive (IoU association unchanged) but cast
no vote — they cannot push a track toward unknown.

**Sticky identity with hysteresis.** Two thresholds replace the single one:
- *Acquire*: a track acquires identity P when quality votes for P reach
  similarity ≥ `FACE_SERVICE_ACQUIRE_THRESHOLD` (default 0.45), sustained
  over ≥ `FACE_SERVICE_ACQUIRE_VOTES` (default 3) quality votes.
- *Keep*: once acquired, matches for P at ≥ `FACE_SERVICE_KEEP_THRESHOLD`
  (default 0.35) refresh the identity. The track **never reverts to unknown**
  within its lifetime.
- *Switch*: the identity changes to a different person Q only with sustained
  acquire-level evidence for Q (same acquire rule).

**Unknown requires proof.** A track is declared unknown only after all of:
- age ≥ `FACE_SERVICE_UNKNOWN_MIN_AGE_S` (default 3.0 seconds),
- ≥ `FACE_SERVICE_UNKNOWN_MIN_VOTES` (default 5) quality votes cast,
- no identity acquired.

Tracks that die before settling produce no confirmed identity and no event.

**Best-crop selection.** Each track keeps its best face crop (JPEG bytes,
cropped with margin from the full frame) and that crop's embedding, scored by
`bbox_area × det_score × sharpness` (sharpness = Laplacian variance).
Updated whenever a better-scoring quality frame arrives.

## Section 2 — Track lifecycle protocol (face-service → Go)

The per-camera detection WebSocket (`/cameras/{id}/ws`) gains three JSON
message types. Per-frame `detections` messages are unchanged (live overlay
continues to work).

```json
{"type": "track_confirmed", "camera_id": "...", "track_key": "<cam>:<track_id>:<epoch>",
 "ts": 0.0, "person_id": "... | null", "name": "... | null", "similarity": 0.0,
 "crop_jpeg_b64": "..."}

{"type": "track_updated", "camera_id": "...", "track_key": "...",
 "ts": 0.0, "person_id": "...", "name": "...", "similarity": 0.0,
 "crop_jpeg_b64": "..."}

{"type": "track_ended", "camera_id": "...", "track_key": "...",
 "started_ts": 0.0, "ended_ts": 0.0, "person_id": "... | null", "name": "... | null",
 "similarity": 0.0, "crop_jpeg_b64": "...", "embedding_b64": "..."}
```

- `track_confirmed` fires once per track, when identity settles (known
  acquired, or unknown-proof reached). It opens the event and triggers the
  notification.
- `track_updated` fires only on unknown → known upgrade (or person switch);
  Go corrects the open event in place.
- `track_ended` closes the event; carries the final best crop and its
  embedding (embedding stored only for unknowns, for later labeling).
- `track_key` includes a worker-start epoch so worker restarts cannot collide
  with earlier track ids.

## Section 3 — Events, clips, retention (Go)

**Schema** (new table in the existing SQLite DB):

```sql
CREATE TABLE events (
  id            TEXT PRIMARY KEY,       -- uuid
  camera_id     TEXT NOT NULL,
  track_key     TEXT NOT NULL UNIQUE,
  person_id     TEXT,                   -- NULL = unknown
  person_name   TEXT,
  similarity    REAL,
  started_at    INTEGER NOT NULL,       -- unix ms
  ended_at      INTEGER,                -- NULL while open
  thumb_path    TEXT,
  clip_path     TEXT,                   -- NULL if never captured
  clip_expires_at INTEGER,
  clip_expired  INTEGER NOT NULL DEFAULT 0,
  labeled_person_id TEXT,               -- set when an unknown is labeled
  embedding     BLOB                    -- best-crop embedding, unknowns only
);
```

**Clip capture.** HLS segments in `/tmp/sentry/streams/<cam>/` are
short-lived, so capture starts at `track_confirmed`, not at `track_ended`:

1. On confirm: copy existing segments covering the last ~10 s (pre-roll) into
   a per-event staging dir; keep copying new segments as FFmpeg writes them.
2. On `track_ended` + 5 s post-roll (hard cap 2 min per clip): stop, stitch
   segments losslessly with `ffmpeg -c copy` into `data/clips/<event_id>.mp4`,
   delete staging.
3. Failure handling: if segments are missing (stream restarted) the event is
   kept with `clip_path = NULL`; the UI shows "no clip".

**Retention loop** (hourly goroutine):
- clips: delete file when `clip_expires_at` passes (default 72h after
  `ended_at`; env `SENTRY_CLIP_RETENTION_HOURS`), set `clip_expired = 1`.
- events: delete row + thumbnail after `SENTRY_EVENT_RETENTION_DAYS`
  (default 90).

**API** (all under existing JWT auth):

| Route | Purpose |
|---|---|
| `GET /api/events?camera_id&person_id&unknown=1&from&to&limit&cursor` | paginated sighting log |
| `GET /api/events/:id` | event detail |
| `GET /api/events/:id/thumb` | JPEG face crop |
| `GET /api/events/:id/clip` | mp4, playable inline and downloadable |
| `POST /api/events/:id/label` | body `{person_id}` or `{new_person_name}` |

**Labeling flow.** `POST /label` sends the stored best crop to the
face-service's existing photo-enroll endpoint (creating the person first when
`new_person_name` is given). Augmentation and index rebuild happen through the
existing enroll path for free. The event gets `labeled_person_id`; other
unknown events whose stored embedding matches the newly enrolled person above
the acquire threshold are retro-labeled in the same pass.

**Push payload** gains `event_id` so the mobile app deep-links to the clip.

## Section 4 — Notification policy (Go)

Notifications fire **once per event**, on `track_confirmed`. Per-subscription
settings (columns added to `push_subscriptions`, set via the existing
`POST /api/push/register`), independently for known and unknown:

- `every` — every event (default; matches old behavior minus the noise)
- `quiet_period` — notify only if the person was last seen (any camera) more
  than N hours ago (`quiet_hours`, user-set). For unknowns — who have no
  identity to dedupe on — the quiet period applies per camera.
- `first_of_day` — first event per person per local calendar day
  (per camera per day for unknowns).

"Last seen" state is read from the events table itself; no separate tracking.
`track_updated` (unknown → known) does not send a second notification.

## Section 5 — UI (web + mobile)

Shared REST API; two clients.

**Web (React):**
- Events page: reverse-chron list — thumbnail, name or UNKNOWN badge, camera,
  time, clip indicator; filters (person, camera, unknowns-only, date range).
- Event detail: `<video>` clip playback, download button, "clip expired /
  no clip" states, label action for unknowns.
- Unknowns gallery: crop grid → assign-to-person picker or create-new-person.
- Person page: sighting history.

**Mobile (Expo — consult v56 docs before implementation):**
- Events tab mirroring the web list + detail (`expo-video` for playback,
  share/download via native share sheet).
- Unknown gallery + labeling.
- Notification settings screen gains mode picker + quiet-hours per
  known/unknown.
- Notification tap → event detail (deep link on `event_id`).

## Section 6 — Testing

First automated tests in the repo land with this work:
- Python (`tests/ci/`): tracker acquire/keep/switch hysteresis, quality
  gating, unknown-proof, best-crop selection (synthetic bboxes/embeddings,
  no model needed).
- Go: event state machine (confirm/update/end, out-of-order and duplicate
  messages), notification policy matrix, clip cutter against fake segment
  files, retention loop.
- Manual E2E: `scripts/webcam_rtsp.py` as a live camera.

## Section 7 — Build order

1. **Recognition robustness** — tracker/worker changes only, no schema/API
   changes; immediately fixes the wiggle and far-face problems.
2. **Lifecycle protocol + events/clips/retention** backend.
3. **Notification policy** (replaces the 60s cooldown in `push/listener.go`).
4. **Web UI** (events, unknowns, labeling).
5. **Mobile UI** (events, unknowns, settings, deep link).

Each phase ships independently useful.

## Out of scope

- Multi-face re-identification across cameras (person tracking between
  cameras beyond shared identity).
- Motion/object detection for non-face events.
- Cloud storage of clips.
