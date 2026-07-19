# Sighting Events & Clips (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn confirmed face tracks into persisted sighting events with best-face thumbnails, 72-hour downloadable video clips cut from the live HLS stream, retention, a REST API, and an unknown-labeling flow that feeds photos back into recognition.

**Architecture:** The face-service (Python) gains a `LifecycleEmitter` that converts tracker state transitions into three new WebSocket message types (`track_confirmed` / `track_updated` / `track_ended`, carrying the track's best face crop and embedding). The Go backend's existing per-camera push listener dispatches those messages to a new `events` package: a `Recorder` persists events in SQLite and drives a `ClipCutter` that copies live HLS segments into per-event staging and losslessly stitches them into MP4s. A retention loop expires clips at 72h and events at 90d. A new `/api/events` handler serves the log, thumbs, clips, and labeling.

**Tech Stack:** Python 3.11 (numpy, cv2, pytest in `face-service/.venv`), Go 1.25 (Gin, `modernc.org/sqlite`, stdlib testing), ffmpeg (`-f concat -c copy`).

**Spec:** `docs/superpowers/specs/2026-07-19-face-recognition-reliability-design.md`, Sections 2 and 3. Also delivers best-crop selection deferred from Phase 1 (spec Section 1).

## Global Constraints

- Lifecycle WS message shapes exactly as in spec Section 2. `track_key` format: `<camera_id>:<track_id>:<epoch>` where epoch is the worker's start time in whole seconds. `crop_jpeg_b64` = base64 JPEG; `embedding_b64` = base64 of the 512-float32 little-endian embedding bytes; both may be null.
- `track_confirmed` fires exactly once per track (identity settled: known acquired or unknown-proof reached). `track_updated` fires only on identity change after confirmation. `track_ended` fires only for confirmed tracks. Tracks dying while `pending` emit nothing.
- Per-frame `detections` messages are unchanged; web/mobile clients were verified to ignore unknown message types (web filters `data.type === 'detections'`; mobile requires `payload.detections` array) — no client changes in this phase.
- Events table columns per spec Section 3, with Go-idiomatic mapping: empty string `''` instead of NULL for person_id / labeled_person_id / paths; `ended_at = 0` while open; timestamps in unix **milliseconds**; `embedding` BLOB stored **only for unknown events**.
- Clip capture: pre-roll = whatever segments are on disk at confirm time (HLS keeps `hls_list_size 5 × hls_time 2 ≈ 10 s`); post-roll 5 s after `track_ended`; hard cap 2 minutes; lossless stitch via `ffmpeg -f concat -safe 0 -i list.txt -c copy`. Clip expiry is anchored at clip finalization time (≈ ended_at + post-roll), not ended_at — an accepted deviation of seconds.
- Env vars: `SENTRY_CLIP_RETENTION_HOURS` (default `72`), `SENTRY_EVENT_RETENTION_DAYS` (default `90`).
- API routes exactly: `GET /api/events`, `GET /api/events/:id`, `GET /api/events/:id/thumb`, `GET /api/events/:id/clip`, `POST /api/events/:id/label` — all inside the existing JWT-authed group.
- Labeling: body `{"person_id": "..."}` OR `{"new_person_name": "..."}`; enrollment goes through the face-service's existing photo-upload path (augmentation + index rebuild happen there). Retro-labeling: other unknown events whose stored embedding has cosine ≥ **0.45** with the labeled event's embedding get `labeled_person_id` set.
- Push payload `event_id` is **deferred to Phase 3** (notifications still ride the per-frame path until then).
- Test commands: Go — `cd backend && go test ./...` and `go vet ./...`; Python — `cd face-service && .venv/bin/python -m pytest tests -v`. Baseline before this plan: 38 Python tests green, no Go tests.

## File Structure

| File | Responsibility |
|---|---|
| `face-service/face_service/tracker.py` (modify) | `update()` returns removed tracks; `is_quality_frame()` made public |
| `face-service/face_service/lifecycle.py` (create) | `LifecycleEmitter`: transitions → messages; best-crop selection |
| `face-service/face_service/worker.py` (modify) | wire emitter into `_process_frames` |
| `backend/db/events.go` (create) | events table schema + CRUD/filter queries |
| `backend/events/clips.go` (create) | `ClipCutter`: segment capture + ffmpeg stitch |
| `backend/events/recorder.go` (create) | lifecycle messages → DB rows + thumbs + cutter |
| `backend/events/retention.go` (create) | hourly clip/event expiry |
| `backend/push/listener.go` (modify) | parse type, dispatch lifecycle to sink |
| `backend/face/client.go` (modify) | `CreatePerson`, `UploadPhoto` |
| `backend/handlers/events.go` (create) | REST API + labeling + retro-label |
| `backend/main.go` (modify) | wiring, dirs, env, routes |

---

### Task 1: Tracker — expose removed tracks and quality check

**Files:**
- Modify: `face-service/face_service/tracker.py`
- Test: `face-service/tests/test_tracker.py` (append)

**Interfaces:**
- Produces: `FaceTracker.update(faces) -> list[FaceTrack]` now returns the tracks removed this frame (previously `None`; existing callers ignore the return value, so this is non-breaking). `FaceTrack.is_quality_frame() -> bool` (renamed from `_is_quality_frame`; same semantics). Task 2's `LifecycleEmitter` consumes both.

- [ ] **Step 1: Write the failing tests**

Append to `face-service/tests/test_tracker.py`:

```python
# --- removed-track reporting ----------------------------------------------------

def test_update_returns_removed_tracks():
    t = FaceTracker(min_iou=0.3, min_hits=1, max_lost=1, params=PARAMS, now_fn=FakeClock())
    t.update([_face()])
    track = t.confirmed_tracks()[0]
    assert t.update([]) == []          # lost_count 1 == max_lost: still alive
    removed = t.update([])             # lost_count 2 > max_lost: removed
    assert removed == [track]
    assert t.confirmed_tracks() == []


def test_update_returns_empty_when_nothing_removed():
    t = FaceTracker(min_iou=0.3, min_hits=1, max_lost=5, params=PARAMS, now_fn=FakeClock())
    assert t.update([_face()]) == []


def test_is_quality_frame_public():
    t = _tracker()
    good = _confirmed_track(t)                       # 80px tall, score 0.99
    assert good.is_quality_frame() is True
    t2 = _tracker()
    small = _confirmed_track(t2, _face(y1=10, y2=40))  # 30px tall
    assert small.is_quality_frame() is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd face-service && .venv/bin/python -m pytest tests/test_tracker.py -v`
Expected: the three new tests FAIL (`update` returns `None`; no attribute `is_quality_frame`). The 16 existing tests still pass.

- [ ] **Step 3: Implement**

In `face-service/face_service/tracker.py`:

1. Rename `_is_quality_frame` to `is_quality_frame` (definition and its one call site in `push_vote`).
2. Change `update`'s signature and tail. The docstring line becomes:

```python
    def update(self, faces: list["DetectedFace"]) -> list["FaceTrack"]:
        """Associate detections with existing tracks and advance all track states.

        Returns the tracks removed this frame (exceeded max_lost), so callers
        can emit end-of-track lifecycle events.
        """
```

and the final block (currently `self._tracks = [t for t in ...]` + resolve loop) becomes:

```python
        # Remove dead tracks, then resolve pending -> unknown on survivors
        dead = [t for t in self._tracks if t.lost_count > self._max_lost]
        self._tracks = [t for t in self._tracks if t.lost_count <= self._max_lost]
        for t in self._tracks:
            t.resolve_unknown(now)
        return dead
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd face-service && .venv/bin/python -m pytest tests/test_tracker.py -v`
Expected: all 19 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add face-service/face_service/tracker.py face-service/tests/test_tracker.py
git commit -m "feat(face): tracker reports removed tracks, public quality check"
```

### Task 2: LifecycleEmitter — transitions + best-crop selection

**Files:**
- Create: `face-service/face_service/lifecycle.py`
- Test: `face-service/tests/test_lifecycle.py` (create)

**Interfaces:**
- Consumes: `FaceTracker.update() -> list[FaceTrack]`, `FaceTrack.state/.identity/.bbox/.det_score/.current_embedding/.is_quality_frame()/.lost_count`, constants `PENDING`, `KNOWN` from Task 1/Phase 1.
- Produces (Task 3 and the Go Recorder rely on these): `LifecycleEmitter(camera_id: str, epoch: int | None = None)` with `process(tracker: FaceTracker, removed: list[FaceTrack], frame: np.ndarray, ts: float) -> list[dict]`. Returned dicts are JSON-serializable messages of type `track_confirmed` / `track_updated` / `track_ended` with the exact keys from Global Constraints.

- [ ] **Step 1: Write the failing tests**

Create `face-service/tests/test_lifecycle.py`:

```python
import base64
import json

import numpy as np
from face_service.lifecycle import LifecycleEmitter
from face_service.recognizer import DetectedFace, Match
from face_service.tracker import FaceTracker, IdentityParams

PARAMS = IdentityParams(
    acquire_threshold=0.45,
    keep_threshold=0.35,
    acquire_votes=3,
    min_vote_face_px=48,
    min_vote_det_score=0.6,
    unknown_min_age_s=3.0,
    unknown_min_votes=5,
)

FRAME = np.full((400, 400, 3), 128, dtype=np.uint8)


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def _face(x1=100.0, y1=100.0, x2=200.0, y2=200.0, score=0.9, emb_dim=0):
    emb = np.zeros(512, dtype=np.float32)
    emb[emb_dim] = 1.0
    return DetectedFace(bbox=(x1, y1, x2, y2), score=score, embedding=emb, landmarks=None)


def _match(pid="pid_a", name="Alice", sim=0.9):
    return Match(person_id=pid, name=name, similarity=sim)


def _setup(clock=None):
    clock = clock or FakeClock()
    tracker = FaceTracker(min_iou=0.3, min_hits=1, max_lost=1, params=PARAMS, now_fn=clock)
    emitter = LifecycleEmitter("cam1", epoch=42)
    return tracker, emitter, clock


# Sentinel: distinguish "cast no vote this frame" (default) from "cast a None
# vote" (votes=None), which is how unknown-proof accumulates quality votes.
_SKIP = object()


def _step(tracker, emitter, faces, ts, votes=_SKIP):
    removed = tracker.update(faces)
    if votes is not _SKIP:
        for track in tracker.confirmed_tracks():
            track.push_vote(votes)
    return emitter.process(tracker, removed, FRAME, ts)


def test_known_track_emits_confirmed_once():
    tracker, emitter, _ = _setup()
    events = []
    for i in range(5):
        events += _step(tracker, emitter, [_face()], ts=100.0 + i, votes=_match(sim=0.5))
    confirmed = [e for e in events if e["type"] == "track_confirmed"]
    assert len(confirmed) == 1
    e = confirmed[0]
    assert e["camera_id"] == "cam1"
    assert e["track_key"] == "cam1:0:42"
    assert e["person_id"] == "pid_a"
    assert e["name"] == "Alice"
    assert e["similarity"] is not None
    assert e["crop_jpeg_b64"] is not None
    base64.b64decode(e["crop_jpeg_b64"])  # valid base64
    json.dumps(e)  # JSON-serializable


def test_unknown_track_emits_confirmed_with_null_person():
    tracker, emitter, clock = _setup()
    events = []
    for i in range(5):
        events += _step(tracker, emitter, [_face()], ts=100.0 + i, votes=None)
    assert events == []  # young: unknown not yet proven
    clock.t += 3.5
    events = _step(tracker, emitter, [_face()], ts=110.0, votes=None)
    confirmed = [e for e in events if e["type"] == "track_confirmed"]
    assert len(confirmed) == 1
    assert confirmed[0]["person_id"] is None
    assert confirmed[0]["crop_jpeg_b64"] is not None


def test_unknown_to_known_emits_updated():
    tracker, emitter, clock = _setup()
    for i in range(5):
        _step(tracker, emitter, [_face()], ts=100.0 + i, votes=None)
    clock.t += 3.5
    _step(tracker, emitter, [_face()], ts=110.0, votes=None)  # confirmed unknown
    events = []
    for i in range(3):
        events += _step(tracker, emitter, [_face()], ts=111.0 + i, votes=_match(sim=0.5))
    updated = [e for e in events if e["type"] == "track_updated"]
    assert len(updated) == 1
    assert updated[0]["person_id"] == "pid_a"
    assert updated[0]["track_key"] == "cam1:0:42"


def test_ended_carries_times_and_embedding():
    tracker, emitter, _ = _setup()
    for i in range(3):
        _step(tracker, emitter, [_face(emb_dim=7)], ts=100.0 + i, votes=_match(sim=0.5))
    events = _step(tracker, emitter, [], ts=105.0)   # lost 1 (== max_lost)
    assert events == []
    events = _step(tracker, emitter, [], ts=106.0)   # lost 2 -> removed
    ended = [e for e in events if e["type"] == "track_ended"]
    assert len(ended) == 1
    e = ended[0]
    assert e["started_ts"] == 100.0
    assert e["ended_ts"] == 106.0
    assert e["person_id"] == "pid_a"
    emb = np.frombuffer(base64.b64decode(e["embedding_b64"]), dtype=np.float32)
    assert emb.shape == (512,)
    assert emb[7] == 1.0
    json.dumps(e)


def test_pending_track_death_emits_nothing():
    tracker, emitter, _ = _setup()
    _step(tracker, emitter, [_face()], ts=100.0, votes=None)  # 1 vote, young
    events = _step(tracker, emitter, [], ts=101.0)
    events += _step(tracker, emitter, [], ts=102.0)           # removed while pending
    assert events == []


def test_best_crop_improves_with_bigger_face():
    tracker, emitter, _ = _setup()
    _step(tracker, emitter, [_face(100, 100, 160, 160)], ts=100.0, votes=_match(sim=0.5))
    small_crop = emitter._states[0].crop_jpeg
    for i in range(2):
        _step(tracker, emitter, [_face(80, 80, 240, 240)], ts=101.0 + i, votes=_match(sim=0.5))
    big_crop = emitter._states[0].crop_jpeg
    assert big_crop is not None and small_crop is not None
    assert len(big_crop) != len(small_crop)  # crop was replaced

    import cv2
    small = cv2.imdecode(np.frombuffer(small_crop, np.uint8), cv2.IMREAD_COLOR)
    big = cv2.imdecode(np.frombuffer(big_crop, np.uint8), cv2.IMREAD_COLOR)
    assert big.shape[0] > small.shape[0]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd face-service && .venv/bin/python -m pytest tests/test_lifecycle.py -v`
Expected: collection error — `ModuleNotFoundError: No module named 'face_service.lifecycle'`.

- [ ] **Step 3: Implement**

Create `face-service/face_service/lifecycle.py`:

```python
"""Track lifecycle events + best-crop selection.

Bridges the FaceTracker's per-frame state to the discrete lifecycle protocol
consumed by the Go backend (design spec section 2):

  track_confirmed  once per track, when identity settles (known acquired or
                   unknown-proof reached)
  track_updated    when a confirmed track's identity changes (unknown -> known
                   upgrade, or person switch)
  track_ended      when the track dies; carries final best crop + embedding

Tracks that die while still pending emit nothing.

Best crop: among quality frames, keep the crop maximizing
area * det_score * (1 + Laplacian variance). The +1 keeps flat (zero-variance)
images scoring above zero so area/detector confidence still decide.
"""
from __future__ import annotations

import base64
import time

import cv2
import numpy as np

from .tracker import KNOWN, PENDING, FaceTrack, FaceTracker

CROP_MARGIN = 0.25  # fraction of bbox width/height added on each side
JPEG_QUALITY = 90


def crop_face(frame: np.ndarray, bbox: tuple, margin: float = CROP_MARGIN) -> np.ndarray:
    x1, y1, x2, y2 = bbox
    w, h = x2 - x1, y2 - y1
    fh, fw = frame.shape[:2]
    cx1 = max(0, int(x1 - w * margin))
    cy1 = max(0, int(y1 - h * margin))
    cx2 = min(fw, int(x2 + w * margin))
    cy2 = min(fh, int(y2 + h * margin))
    return frame[cy1:cy2, cx1:cx2]


def crop_quality_score(crop: np.ndarray, det_score: float) -> float:
    if crop.size == 0:
        return 0.0
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    area = float(crop.shape[0] * crop.shape[1])
    return area * det_score * (1.0 + sharpness)


class _TrackState:
    __slots__ = ("confirmed", "person_id", "started_ts", "crop_jpeg", "crop_embedding", "crop_score")

    def __init__(self, started_ts: float):
        self.confirmed = False
        self.person_id: str | None = None
        self.started_ts = started_ts
        self.crop_jpeg: bytes | None = None
        self.crop_embedding: np.ndarray | None = None
        self.crop_score = 0.0


class LifecycleEmitter:
    """Stateful per-camera translator from tracker frames to lifecycle messages."""

    def __init__(self, camera_id: str, epoch: int | None = None):
        self._camera_id = camera_id
        self._epoch = int(time.time()) if epoch is None else epoch
        self._states: dict[int, _TrackState] = {}

    def _key(self, track_id: int) -> str:
        return f"{self._camera_id}:{track_id}:{self._epoch}"

    def process(
        self,
        tracker: FaceTracker,
        removed: list[FaceTrack],
        frame: np.ndarray,
        ts: float,
    ) -> list[dict]:
        """Call once per processed frame, right after tracker.update()."""
        events: list[dict] = []

        for track in tracker.confirmed_tracks():
            st = self._states.get(track.id)
            if st is None:
                st = _TrackState(started_ts=ts)
                self._states[track.id] = st

            if track.lost_count == 0 and track.is_quality_frame():
                self._consider_crop(st, track, frame)

            if not st.confirmed:
                if track.state != PENDING:
                    st.confirmed = True
                    st.person_id = track.identity.person_id if track.state == KNOWN else None
                    events.append(self._msg("track_confirmed", track, st, ts))
            else:
                pid = track.identity.person_id if track.state == KNOWN else None
                if pid is not None and pid != st.person_id:
                    st.person_id = pid
                    events.append(self._msg("track_updated", track, st, ts))

        for track in removed:
            st = self._states.pop(track.id, None)
            if st is None or not st.confirmed:
                continue
            msg = self._msg("track_ended", track, st, ts)
            msg["started_ts"] = st.started_ts
            msg["ended_ts"] = ts
            if st.crop_embedding is not None:
                emb = np.asarray(st.crop_embedding, dtype=np.float32)
                msg["embedding_b64"] = base64.b64encode(emb.tobytes()).decode("ascii")
            else:
                msg["embedding_b64"] = None
            events.append(msg)

        return events

    def _consider_crop(self, st: _TrackState, track: FaceTrack, frame: np.ndarray) -> None:
        crop = crop_face(frame, track.bbox)
        score = crop_quality_score(crop, track.det_score)
        if score <= st.crop_score:
            return
        ok, buf = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
        if not ok:
            return
        st.crop_jpeg = buf.tobytes()
        st.crop_embedding = track.current_embedding
        st.crop_score = score

    def _msg(self, mtype: str, track: FaceTrack, st: _TrackState, ts: float) -> dict:
        ident = track.identity if track.state == KNOWN else None
        return {
            "type": mtype,
            "camera_id": self._camera_id,
            "track_key": self._key(track.id),
            "ts": ts,
            "person_id": ident.person_id if ident else None,
            "name": ident.name if ident else None,
            "similarity": round(ident.similarity, 3) if ident else None,
            "crop_jpeg_b64": base64.b64encode(st.crop_jpeg).decode("ascii") if st.crop_jpeg else None,
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd face-service && .venv/bin/python -m pytest tests/test_lifecycle.py tests/test_tracker.py -v`
Expected: all PASS (6 new + 19 tracker).

- [ ] **Step 5: Commit**

```bash
git add face-service/face_service/lifecycle.py face-service/tests/test_lifecycle.py
git commit -m "feat(face): lifecycle emitter with best-crop selection"
```

### Task 3: Worker wiring — emit lifecycle messages

**Files:**
- Modify: `face-service/face_service/worker.py`
- Test: `face-service/tests/test_worker_detections.py` (append)

**Interfaces:**
- Consumes: `LifecycleEmitter` from Task 2, `tracker.update() -> removed` from Task 1.
- Produces: lifecycle messages flow through the existing `out_queue` → supervisor pubsub → per-camera WS, interleaved with `detections` messages. No new function signatures for later tasks.

- [ ] **Step 1: Write the failing test**

Append to `face-service/tests/test_worker_detections.py`:

```python
def test_process_tick_emits_lifecycle_and_detections():
    """Simulates worker's per-frame sequence: update -> lifecycle -> detections."""
    import json

    import numpy as np
    from face_service.lifecycle import LifecycleEmitter

    tracker, index = _setup()
    emitter = LifecycleEmitter("cam1", epoch=1)
    frame = np.full((300, 300, 3), 128, dtype=np.uint8)
    face = _face(_unit(0))

    all_lifecycle = []
    for i in range(3):
        removed = tracker.update([face])
        dets = build_detections(tracker, index, 1000, 500)
        all_lifecycle += emitter.process(tracker, removed, frame, ts=100.0 + i)

    confirmed = [e for e in all_lifecycle if e["type"] == "track_confirmed"]
    assert len(confirmed) == 1
    assert confirmed[0]["person_id"] == "pid_a"
    for e in all_lifecycle:
        json.dumps(e)  # everything the worker will queue must serialize
    assert dets[0]["person_id"] == "pid_a"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd face-service && .venv/bin/python -m pytest tests/test_worker_detections.py -v`
Expected: the new test FAILS — `build_detections` casts the votes but the sequence above never calls `push_vote` before `emitter.process`... it actually passes the confirmed check via `build_detections`'s internal voting, so expected result here is PASS if lifecycle.py exists and worker is untouched. **This test validates the sequence contract, not new worker code** — if it passes immediately, that is acceptable; proceed. (The real worker change below is verified by py_compile plus the full suite because `_process_frames` needs a live WebSocket.)

- [ ] **Step 3: Implement worker changes**

In `face-service/face_service/worker.py`:

1. Add to the tracker import line:

```python
from .lifecycle import LifecycleEmitter
from .tracker import KNOWN, FaceTracker, IdentityParams
```

2. In `_run_async`, right after the `tracker = FaceTracker(...)` construction, add:

```python
    emitter = LifecycleEmitter(camera_id)
```

and pass it through to `_process_frames` (add `emitter=emitter,` to the call, and `emitter,` to `_process_frames`'s keyword-only parameters, after `tracker`).

3. In `_process_frames`, replace:

```python
        tracker.update(faces)
        detections = build_detections(tracker, index_ref[0], frame_w, frame_h)
```

with:

```python
        removed = tracker.update(faces)
        detections = build_detections(tracker, index_ref[0], frame_w, frame_h)
        for lifecycle_event in emitter.process(tracker, removed, frame, frame_ts):
            try:
                out_queue.put_nowait(json.dumps(lifecycle_event))
            except Exception:
                pass  # queue full — drop
```

Order matters: `build_detections` casts this frame's votes **before** `emitter.process` reads track state, so a track that acquires identity on this frame confirms on this frame.

- [ ] **Step 4: Regression gate**

Run: `cd face-service && .venv/bin/python -m py_compile face_service/worker.py && .venv/bin/python -m pytest tests -v`
Expected: no compile error; all tests PASS (38 baseline + 3 tracker + 6 lifecycle + 1 sequence = 48).

- [ ] **Step 5: Commit**

```bash
git add face-service/face_service/worker.py face-service/tests/test_worker_detections.py
git commit -m "feat(face): emit track lifecycle events from worker"
```

### Task 4: Go DB layer — events table + queries

**Files:**
- Create: `backend/db/events.go`
- Modify: `backend/db/db.go` (execute the new schema in `Open`)
- Test: `backend/db/events_test.go` (create)

**Interfaces:**
- Produces (Tasks 6, 8, 10 rely on these exact signatures):

```go
type Event struct {
    ID, CameraID, TrackKey, PersonID, PersonName string
    Similarity                                   float64
    StartedAt, EndedAt                           int64 // unix ms; EndedAt 0 while open
    ThumbPath, ClipPath                          string
    ClipExpiresAt                                int64
    ClipExpired                                  bool
    LabeledPersonID                              string
    Embedding                                    []byte
}
type EventFilter struct {
    CameraID, PersonID string
    UnknownOnly        bool
    From, To, Before   int64
    Limit              int
}
func (d *DB) CreateEvent(e *Event) (bool, error)              // false = duplicate track_key ignored
func (d *DB) GetEvent(id string) (*Event, bool, error)
func (d *DB) GetEventByTrackKey(key string) (*Event, bool, error)
func (d *DB) UpdateEventIdentity(id, personID, name string, similarity float64) error
func (d *DB) CloseEvent(id string, endedAt int64, thumbPath string, embedding []byte) error
func (d *DB) SetEventClip(id, clipPath string, expiresAt int64) error
func (d *DB) LabelEvent(id, personID string) error
func (d *DB) ListEvents(f EventFilter) ([]*Event, error)      // started_at DESC
func (d *DB) ListUnknownWithEmbeddings() ([]*Event, error)
func (d *DB) ListExpiredClips(nowMs int64) ([]*Event, error)
func (d *DB) MarkClipExpired(id string) error
func (d *DB) ListEventsBefore(cutoffMs int64) ([]*Event, error)
func (d *DB) DeleteEvent(id string) error
```

- [ ] **Step 1: Write the failing tests**

Create `backend/db/events_test.go`:

```go
package db

import (
	"path/filepath"
	"testing"
)

func testDB(t *testing.T) *DB {
	t.Helper()
	d, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func mkEvent(track string, startedAt int64) *Event {
	return &Event{CameraID: "cam1", TrackKey: track, StartedAt: startedAt}
}

func TestCreateAndGetEvent(t *testing.T) {
	d := testDB(t)
	e := &Event{CameraID: "cam1", TrackKey: "cam1:0:1", PersonID: "p1",
		PersonName: "Alice", Similarity: 0.5, StartedAt: 1000, ThumbPath: "/t/x.jpg"}
	created, err := d.CreateEvent(e)
	if err != nil || !created {
		t.Fatalf("create: created=%v err=%v", created, err)
	}
	if e.ID == "" {
		t.Fatal("expected generated ID")
	}
	got, ok, err := d.GetEvent(e.ID)
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.PersonName != "Alice" || got.StartedAt != 1000 || got.ThumbPath != "/t/x.jpg" {
		t.Fatalf("roundtrip mismatch: %+v", got)
	}
	byKey, ok, _ := d.GetEventByTrackKey("cam1:0:1")
	if !ok || byKey.ID != e.ID {
		t.Fatalf("by track key: ok=%v", ok)
	}
}

func TestDuplicateTrackKeyIgnored(t *testing.T) {
	d := testDB(t)
	if created, _ := d.CreateEvent(mkEvent("k1", 1)); !created {
		t.Fatal("first insert should create")
	}
	created, err := d.CreateEvent(mkEvent("k1", 2))
	if err != nil {
		t.Fatalf("dup err: %v", err)
	}
	if created {
		t.Fatal("duplicate track_key must be ignored")
	}
}

func TestIdentityCloseClipLabel(t *testing.T) {
	d := testDB(t)
	e := mkEvent("k1", 1000)
	d.CreateEvent(e)
	if err := d.UpdateEventIdentity(e.ID, "p9", "Bob", 0.61); err != nil {
		t.Fatal(err)
	}
	emb := []byte{1, 2, 3, 4}
	if err := d.CloseEvent(e.ID, 2000, "/t/new.jpg", emb); err != nil {
		t.Fatal(err)
	}
	if err := d.SetEventClip(e.ID, "/c/e.mp4", 999999); err != nil {
		t.Fatal(err)
	}
	if err := d.LabelEvent(e.ID, "p9"); err != nil {
		t.Fatal(err)
	}
	got, _, _ := d.GetEvent(e.ID)
	if got.PersonID != "p9" || got.PersonName != "Bob" || got.Similarity != 0.61 {
		t.Fatalf("identity: %+v", got)
	}
	if got.EndedAt != 2000 || got.ThumbPath != "/t/new.jpg" || string(got.Embedding) != string(emb) {
		t.Fatalf("close: %+v", got)
	}
	if got.ClipPath != "/c/e.mp4" || got.ClipExpiresAt != 999999 || got.ClipExpired {
		t.Fatalf("clip: %+v", got)
	}
	if got.LabeledPersonID != "p9" {
		t.Fatalf("label: %+v", got)
	}
}

func TestCloseEventPreservesThumbAndEmbeddingWhenEmpty(t *testing.T) {
	d := testDB(t)
	e := &Event{CameraID: "c", TrackKey: "k", StartedAt: 1, ThumbPath: "/t/orig.jpg"}
	d.CreateEvent(e)
	if err := d.CloseEvent(e.ID, 5, "", nil); err != nil {
		t.Fatal(err)
	}
	got, _, _ := d.GetEvent(e.ID)
	if got.ThumbPath != "/t/orig.jpg" {
		t.Fatalf("thumb clobbered: %+v", got)
	}
}

func TestListEventsFilters(t *testing.T) {
	d := testDB(t)
	a := &Event{CameraID: "cam1", TrackKey: "k1", PersonID: "p1", StartedAt: 100}
	b := &Event{CameraID: "cam2", TrackKey: "k2", StartedAt: 200} // unknown
	c := &Event{CameraID: "cam1", TrackKey: "k3", StartedAt: 300} // unknown
	for _, e := range []*Event{a, b, c} {
		d.CreateEvent(e)
	}
	d.LabelEvent(c.ID, "p1")

	all, err := d.ListEvents(EventFilter{})
	if err != nil || len(all) != 3 {
		t.Fatalf("all: %d %v", len(all), err)
	}
	if all[0].StartedAt != 300 { // DESC order
		t.Fatalf("order: %+v", all[0])
	}
	cam1, _ := d.ListEvents(EventFilter{CameraID: "cam1"})
	if len(cam1) != 2 {
		t.Fatalf("cam1: %d", len(cam1))
	}
	p1, _ := d.ListEvents(EventFilter{PersonID: "p1"})
	if len(p1) != 2 { // person_id match + labeled match
		t.Fatalf("p1: %d", len(p1))
	}
	unk, _ := d.ListEvents(EventFilter{UnknownOnly: true})
	if len(unk) != 1 || unk[0].ID != b.ID {
		t.Fatalf("unknown: %d", len(unk))
	}
	page, _ := d.ListEvents(EventFilter{Before: 300, Limit: 1})
	if len(page) != 1 || page[0].StartedAt != 200 {
		t.Fatalf("pagination: %+v", page)
	}
	ranged, _ := d.ListEvents(EventFilter{From: 150, To: 250})
	if len(ranged) != 1 || ranged[0].StartedAt != 200 {
		t.Fatalf("range: %d", len(ranged))
	}
}

func TestRetentionQueries(t *testing.T) {
	d := testDB(t)
	old := &Event{CameraID: "c", TrackKey: "k1", StartedAt: 100}
	fresh := &Event{CameraID: "c", TrackKey: "k2", StartedAt: 5000}
	d.CreateEvent(old)
	d.CreateEvent(fresh)
	d.SetEventClip(old.ID, "/c/old.mp4", 150)
	d.SetEventClip(fresh.ID, "/c/new.mp4", 9000)

	expired, err := d.ListExpiredClips(151)
	if err != nil || len(expired) != 1 || expired[0].ID != old.ID {
		t.Fatalf("expired: %d %v", len(expired), err)
	}
	if err := d.MarkClipExpired(old.ID); err != nil {
		t.Fatal(err)
	}
	expired, _ = d.ListExpiredClips(151)
	if len(expired) != 0 {
		t.Fatal("marked clip should not reappear")
	}
	got, _, _ := d.GetEvent(old.ID)
	if !got.ClipExpired {
		t.Fatal("clip_expired not set")
	}

	before, _ := d.ListEventsBefore(1000)
	if len(before) != 1 || before[0].ID != old.ID {
		t.Fatalf("before: %d", len(before))
	}
	if err := d.DeleteEvent(old.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := d.GetEvent(old.ID); ok {
		t.Fatal("event not deleted")
	}
}

func TestListUnknownWithEmbeddings(t *testing.T) {
	d := testDB(t)
	u1 := &Event{CameraID: "c", TrackKey: "k1", StartedAt: 1, Embedding: []byte{1, 2, 3, 4}}
	u2 := &Event{CameraID: "c", TrackKey: "k2", StartedAt: 2}                          // no embedding
	k := &Event{CameraID: "c", TrackKey: "k3", StartedAt: 3, PersonID: "p1", Embedding: []byte{5, 6, 7, 8}} // known
	for _, e := range []*Event{u1, u2, k} {
		d.CreateEvent(e)
	}
	got, err := d.ListUnknownWithEmbeddings()
	if err != nil || len(got) != 1 || got[0].ID != u1.ID {
		t.Fatalf("unknown w/ emb: %d %v", len(got), err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./db/`
Expected: compile FAIL — `undefined: Event` etc.

- [ ] **Step 3: Implement**

Create `backend/db/events.go`:

```go
package db

import (
	"database/sql"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// Event is one sighting: a confirmed track's lifetime on one camera.
// PersonID "" means unknown at close time; LabeledPersonID is set when a user
// later assigns the unknown to a person. Timestamps are unix milliseconds.
type Event struct {
	ID              string
	CameraID        string
	TrackKey        string
	PersonID        string
	PersonName      string
	Similarity      float64
	StartedAt       int64
	EndedAt         int64 // 0 while open
	ThumbPath       string
	ClipPath        string
	ClipExpiresAt   int64
	ClipExpired     bool
	LabeledPersonID string
	Embedding       []byte // best-crop embedding; stored for unknown events only
}

type EventFilter struct {
	CameraID    string
	PersonID    string // matches person_id OR labeled_person_id
	UnknownOnly bool   // person_id='' AND labeled_person_id=''
	From, To    int64  // started_at range; 0 = unbounded
	Before      int64  // pagination cursor: started_at < Before
	Limit       int    // default 50, max 200
}

const eventsSchema = `
CREATE TABLE IF NOT EXISTS events (
	id                TEXT PRIMARY KEY,
	camera_id         TEXT NOT NULL,
	track_key         TEXT NOT NULL UNIQUE,
	person_id         TEXT NOT NULL DEFAULT '',
	person_name       TEXT NOT NULL DEFAULT '',
	similarity        REAL NOT NULL DEFAULT 0,
	started_at        INTEGER NOT NULL,
	ended_at          INTEGER NOT NULL DEFAULT 0,
	thumb_path        TEXT NOT NULL DEFAULT '',
	clip_path         TEXT NOT NULL DEFAULT '',
	clip_expires_at   INTEGER NOT NULL DEFAULT 0,
	clip_expired      INTEGER NOT NULL DEFAULT 0,
	labeled_person_id TEXT NOT NULL DEFAULT '',
	embedding         BLOB
);
CREATE INDEX IF NOT EXISTS idx_events_started ON events(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_person ON events(person_id);
`

const eventCols = `id, camera_id, track_key, person_id, person_name, similarity,
	started_at, ended_at, thumb_path, clip_path, clip_expires_at, clip_expired,
	labeled_person_id, embedding`

func scanEvent(row interface{ Scan(...any) error }) (*Event, error) {
	e := &Event{}
	var expired int
	err := row.Scan(&e.ID, &e.CameraID, &e.TrackKey, &e.PersonID, &e.PersonName,
		&e.Similarity, &e.StartedAt, &e.EndedAt, &e.ThumbPath, &e.ClipPath,
		&e.ClipExpiresAt, &expired, &e.LabeledPersonID, &e.Embedding)
	if err != nil {
		return nil, err
	}
	e.ClipExpired = expired != 0
	return e, nil
}

// CreateEvent inserts the event, generating an ID if empty. Returns false when
// an event with the same track_key already exists (duplicate delivery).
func (d *DB) CreateEvent(e *Event) (bool, error) {
	if e.ID == "" {
		e.ID = uuid.New().String()
	}
	expired := 0
	if e.ClipExpired {
		expired = 1
	}
	res, err := d.q.Exec(`INSERT OR IGNORE INTO events (`+eventCols+`)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		e.ID, e.CameraID, e.TrackKey, e.PersonID, e.PersonName, e.Similarity,
		e.StartedAt, e.EndedAt, e.ThumbPath, e.ClipPath, e.ClipExpiresAt,
		expired, e.LabeledPersonID, e.Embedding)
	if err != nil {
		return false, fmt.Errorf("create event: %w", err)
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func (d *DB) GetEvent(id string) (*Event, bool, error) {
	e, err := scanEvent(d.q.QueryRow(`SELECT `+eventCols+` FROM events WHERE id=?`, id))
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return e, true, nil
}

func (d *DB) GetEventByTrackKey(key string) (*Event, bool, error) {
	e, err := scanEvent(d.q.QueryRow(`SELECT `+eventCols+` FROM events WHERE track_key=?`, key))
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return e, true, nil
}

func (d *DB) UpdateEventIdentity(id, personID, name string, similarity float64) error {
	_, err := d.q.Exec(`UPDATE events SET person_id=?, person_name=?, similarity=? WHERE id=?`,
		personID, name, similarity, id)
	return err
}

// CloseEvent sets ended_at; thumbPath/embedding update only when non-empty/non-nil.
func (d *DB) CloseEvent(id string, endedAt int64, thumbPath string, embedding []byte) error {
	_, err := d.q.Exec(`UPDATE events SET ended_at=?,
		thumb_path = CASE WHEN ?<>'' THEN ? ELSE thumb_path END,
		embedding  = CASE WHEN ? IS NOT NULL THEN ? ELSE embedding END
		WHERE id=?`,
		endedAt, thumbPath, thumbPath, embedding, embedding, id)
	return err
}

func (d *DB) SetEventClip(id, clipPath string, expiresAt int64) error {
	_, err := d.q.Exec(`UPDATE events SET clip_path=?, clip_expires_at=?, clip_expired=0 WHERE id=?`,
		clipPath, expiresAt, id)
	return err
}

func (d *DB) LabelEvent(id, personID string) error {
	_, err := d.q.Exec(`UPDATE events SET labeled_person_id=? WHERE id=?`, personID, id)
	return err
}

func (d *DB) ListEvents(f EventFilter) ([]*Event, error) {
	where := []string{"1=1"}
	args := []any{}
	if f.CameraID != "" {
		where = append(where, "camera_id=?")
		args = append(args, f.CameraID)
	}
	if f.PersonID != "" {
		where = append(where, "(person_id=? OR labeled_person_id=?)")
		args = append(args, f.PersonID, f.PersonID)
	}
	if f.UnknownOnly {
		where = append(where, "person_id='' AND labeled_person_id=''")
	}
	if f.From > 0 {
		where = append(where, "started_at>=?")
		args = append(args, f.From)
	}
	if f.To > 0 {
		where = append(where, "started_at<=?")
		args = append(args, f.To)
	}
	if f.Before > 0 {
		where = append(where, "started_at<?")
		args = append(args, f.Before)
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	args = append(args, limit)
	return d.queryEvents(`SELECT `+eventCols+` FROM events WHERE `+
		strings.Join(where, " AND ")+` ORDER BY started_at DESC LIMIT ?`, args...)
}

func (d *DB) ListUnknownWithEmbeddings() ([]*Event, error) {
	return d.queryEvents(`SELECT ` + eventCols + ` FROM events
		WHERE person_id='' AND labeled_person_id='' AND embedding IS NOT NULL`)
}

func (d *DB) ListExpiredClips(nowMs int64) ([]*Event, error) {
	return d.queryEvents(`SELECT `+eventCols+` FROM events
		WHERE clip_path<>'' AND clip_expired=0 AND clip_expires_at<=?`, nowMs)
}

func (d *DB) MarkClipExpired(id string) error {
	_, err := d.q.Exec(`UPDATE events SET clip_expired=1 WHERE id=?`, id)
	return err
}

func (d *DB) ListEventsBefore(cutoffMs int64) ([]*Event, error) {
	return d.queryEvents(`SELECT `+eventCols+` FROM events WHERE started_at<?`, cutoffMs)
}

func (d *DB) DeleteEvent(id string) error {
	_, err := d.q.Exec(`DELETE FROM events WHERE id=?`, id)
	return err
}

func (d *DB) queryEvents(query string, args ...any) ([]*Event, error) {
	rows, err := d.q.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Event
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
```

In `backend/db/db.go`, inside `Open`, after the existing `q.Exec(schema)` block, add:

```go
	if _, err := q.Exec(eventsSchema); err != nil {
		return nil, fmt.Errorf("db migrate events: %w", err)
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./db/ -v && go vet ./db/`
Expected: all 7 tests PASS, vet clean.

- [ ] **Step 5: Commit**

```bash
git add backend/db/events.go backend/db/events_test.go backend/db/db.go
git commit -m "feat(backend): events table with CRUD, filters, retention queries"
```

### Task 5: ClipCutter — HLS segment capture + lossless stitch

**Files:**
- Create: `backend/events/clips.go`
- Test: `backend/events/clips_test.go` (create)

**Interfaces:**
- Produces (Task 6 relies on these):

```go
func NewClipCutter(hlsRoot, clipsDir string) *ClipCutter
func (c *ClipCutter) Start(eventID, cameraID string, done func(clipPath string, err error))
func (c *ClipCutter) Stop(eventID string)
```

`done` is invoked exactly once per Start — after Stop + post-roll, or at the 2-minute cap — with the final MP4 path or an error. Exported struct fields for tests/tuning: `Poll`, `PostRoll`, `MaxDur time.Duration` and `Stitch func(listFile, outPath string) error` (defaults: 1s / 5s / 2min / ffmpeg concat).

- [ ] **Step 1: Write the failing tests**

Create `backend/events/clips_test.go`:

```go
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./events/`
Expected: compile FAIL — package/types don't exist.

- [ ] **Step 3: Implement**

Create `backend/events/clips.go`:

```go
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
	defer os.RemoveAll(cap.staging)
	if len(cap.order) == 0 {
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
		cap.done("", fmt.Errorf("clip list: %w", err))
		return
	}
	outPath := filepath.Join(c.clipsDir, eventID+".mp4")
	if err := c.Stitch(listFile, outPath); err != nil {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./events/ -v -race && go vet ./events/`
Expected: 4 tests PASS with race detector clean.

- [ ] **Step 5: Commit**

```bash
git add backend/events/clips.go backend/events/clips_test.go
git commit -m "feat(backend): HLS clip cutter with pre/post-roll and lossless stitch"
```

### Task 6: Recorder — lifecycle messages → events + thumbs + clips

**Files:**
- Create: `backend/events/recorder.go`
- Test: `backend/events/recorder_test.go` (create)

**Interfaces:**
- Consumes: `db.Event`/`db.DB` methods from Task 4; `ClipCutter` signature from Task 5.
- Produces (Tasks 7 and 11 rely on these):

```go
type Cutter interface {
	Start(eventID, cameraID string, done func(clipPath string, err error))
	Stop(eventID string)
}
func NewRecorder(database *db.DB, thumbsDir string, cutter Cutter, clipRetention time.Duration) *Recorder
func (r *Recorder) OnLifecycle(raw []byte)   // safe to call from any goroutine
```

- [ ] **Step 1: Write the failing tests**

Create `backend/events/recorder_test.go`:

```go
package events

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/dim/sentry/backend/db"
)

type fakeCutter struct {
	mu     sync.Mutex
	starts []string // eventIDs
	stops  []string
	dones  map[string]func(string, error)
}

func newFakeCutter() *fakeCutter { return &fakeCutter{dones: map[string]func(string, error){}} }

func (f *fakeCutter) Start(eventID, cameraID string, done func(string, error)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts = append(f.starts, eventID)
	f.dones[eventID] = done
}

func (f *fakeCutter) Stop(eventID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stops = append(f.stops, eventID)
}

func testRecorder(t *testing.T) (*Recorder, *db.DB, *fakeCutter, string) {
	t.Helper()
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	thumbs := t.TempDir()
	fc := newFakeCutter()
	r := NewRecorder(d, thumbs, fc, 72*time.Hour)
	return r, d, fc, thumbs
}

var testJPEG = base64.StdEncoding.EncodeToString([]byte{0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3})

func confirmedMsg(trackKey, personID string) []byte {
	pid := "null"
	name := "null"
	if personID != "" {
		pid = fmt.Sprintf("%q", personID)
		name = `"Alice"`
	}
	return []byte(fmt.Sprintf(`{"type":"track_confirmed","camera_id":"cam1","track_key":%q,
		"ts":100.5,"person_id":%s,"name":%s,"similarity":0.5,"crop_jpeg_b64":%q}`,
		trackKey, pid, name, testJPEG))
}

func TestConfirmedCreatesEventThumbAndStartsClip(t *testing.T) {
	r, d, fc, thumbs := testRecorder(t)
	r.OnLifecycle(confirmedMsg("cam1:0:1", "p1"))

	ev, ok, err := d.GetEventByTrackKey("cam1:0:1")
	if err != nil || !ok {
		t.Fatalf("event not created: %v", err)
	}
	if ev.PersonID != "p1" || ev.PersonName != "Alice" || ev.StartedAt != 100500 {
		t.Fatalf("event: %+v", ev)
	}
	wantThumb := filepath.Join(thumbs, ev.ID+".jpg")
	if ev.ThumbPath != wantThumb {
		t.Fatalf("thumb path: %s", ev.ThumbPath)
	}
	if _, err := os.Stat(wantThumb); err != nil {
		t.Fatalf("thumb file: %v", err)
	}
	if len(fc.starts) != 1 || fc.starts[0] != ev.ID {
		t.Fatalf("cutter starts: %v", fc.starts)
	}

	// clip done callback persists path + expiry
	fc.dones[ev.ID]("/clips/x.mp4", nil)
	ev, _, _ = d.GetEvent(ev.ID)
	if ev.ClipPath != "/clips/x.mp4" || ev.ClipExpiresAt == 0 {
		t.Fatalf("clip not persisted: %+v", ev)
	}
}

func TestDuplicateConfirmedIgnored(t *testing.T) {
	r, d, fc, _ := testRecorder(t)
	r.OnLifecycle(confirmedMsg("k1", ""))
	r.OnLifecycle(confirmedMsg("k1", ""))
	all, _ := d.ListEvents(db.EventFilter{})
	if len(all) != 1 {
		t.Fatalf("events: %d", len(all))
	}
	if len(fc.starts) != 1 {
		t.Fatalf("cutter started %d times", len(fc.starts))
	}
}

func TestUpdatedUpgradesIdentity(t *testing.T) {
	r, d, _, _ := testRecorder(t)
	r.OnLifecycle(confirmedMsg("k1", "")) // unknown
	r.OnLifecycle([]byte(`{"type":"track_updated","camera_id":"cam1","track_key":"k1",
		"ts":105,"person_id":"p2","name":"Bob","similarity":0.6}`))
	ev, _, _ := d.GetEventByTrackKey("k1")
	if ev.PersonID != "p2" || ev.PersonName != "Bob" || ev.Similarity != 0.6 {
		t.Fatalf("identity not upgraded: %+v", ev)
	}
}

func TestEndedClosesStoresEmbeddingAndStopsClip(t *testing.T) {
	r, d, fc, _ := testRecorder(t)
	r.OnLifecycle(confirmedMsg("k1", "")) // unknown -> embedding must be stored
	emb := make([]byte, 8)
	embB64 := base64.StdEncoding.EncodeToString(emb)
	r.OnLifecycle([]byte(fmt.Sprintf(`{"type":"track_ended","camera_id":"cam1","track_key":"k1",
		"ts":110,"started_ts":100.5,"ended_ts":110,"person_id":null,"name":null,
		"similarity":null,"crop_jpeg_b64":%q,"embedding_b64":%q}`, testJPEG, embB64)))

	ev, _, _ := d.GetEventByTrackKey("k1")
	if ev.EndedAt != 110000 {
		t.Fatalf("ended_at: %d", ev.EndedAt)
	}
	if len(ev.Embedding) != 8 {
		t.Fatalf("embedding not stored: %d bytes", len(ev.Embedding))
	}
	if len(fc.stops) != 1 || fc.stops[0] != ev.ID {
		t.Fatalf("cutter stops: %v", fc.stops)
	}
}

func TestEndedKnownDoesNotStoreEmbedding(t *testing.T) {
	r, d, _, _ := testRecorder(t)
	r.OnLifecycle(confirmedMsg("k1", "p1"))
	embB64 := base64.StdEncoding.EncodeToString(make([]byte, 8))
	r.OnLifecycle([]byte(fmt.Sprintf(`{"type":"track_ended","camera_id":"cam1","track_key":"k1",
		"ts":110,"started_ts":100.5,"ended_ts":110,"person_id":"p1","name":"Alice",
		"similarity":0.5,"crop_jpeg_b64":null,"embedding_b64":%q}`, embB64)))
	ev, _, _ := d.GetEventByTrackKey("k1")
	if len(ev.Embedding) != 0 {
		t.Fatal("known event must not store embedding")
	}
}

func TestEndedWithoutConfirmedIsIgnored(t *testing.T) {
	r, d, fc, _ := testRecorder(t)
	r.OnLifecycle([]byte(`{"type":"track_ended","camera_id":"cam1","track_key":"never-seen",
		"ts":110,"started_ts":100,"ended_ts":110,"person_id":null,"name":null,
		"similarity":null,"crop_jpeg_b64":null,"embedding_b64":null}`))
	all, _ := d.ListEvents(db.EventFilter{})
	if len(all) != 0 || len(fc.stops) != 0 {
		t.Fatal("orphan ended must be ignored")
	}
}

func TestGarbageInputIgnored(t *testing.T) {
	r, d, _, _ := testRecorder(t)
	r.OnLifecycle([]byte(`not json`))
	r.OnLifecycle([]byte(`{"type":"detections"}`))
	all, _ := d.ListEvents(db.EventFilter{})
	if len(all) != 0 {
		t.Fatal("garbage created events")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./events/`
Expected: compile FAIL — `undefined: Recorder`.

- [ ] **Step 3: Implement**

Create `backend/events/recorder.go`:

```go
package events

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/dim/sentry/backend/db"
	"github.com/google/uuid"
)

// Cutter abstracts the ClipCutter so the recorder is testable without ffmpeg.
type Cutter interface {
	Start(eventID, cameraID string, done func(clipPath string, err error))
	Stop(eventID string)
}

// Recorder persists face-service track lifecycle messages as sighting events.
type Recorder struct {
	db            *db.DB
	thumbsDir     string
	cutter        Cutter
	clipRetention time.Duration
	nowFn         func() time.Time
}

func NewRecorder(database *db.DB, thumbsDir string, cutter Cutter, clipRetention time.Duration) *Recorder {
	return &Recorder{
		db:            database,
		thumbsDir:     thumbsDir,
		cutter:        cutter,
		clipRetention: clipRetention,
		nowFn:         time.Now,
	}
}

type lifecycleMsg struct {
	Type        string   `json:"type"`
	CameraID    string   `json:"camera_id"`
	TrackKey    string   `json:"track_key"`
	TS          float64  `json:"ts"`
	StartedTS   float64  `json:"started_ts"`
	EndedTS     float64  `json:"ended_ts"`
	PersonID    *string  `json:"person_id"`
	Name        *string  `json:"name"`
	Similarity  *float64 `json:"similarity"`
	CropJPEG    *string  `json:"crop_jpeg_b64"`
	EmbeddingB4 *string  `json:"embedding_b64"`
}

// OnLifecycle handles one raw WS message. Non-lifecycle and malformed messages
// are ignored. Safe for concurrent use (SQLite serializes writes).
func (r *Recorder) OnLifecycle(raw []byte) {
	var m lifecycleMsg
	if err := json.Unmarshal(raw, &m); err != nil || m.TrackKey == "" {
		return
	}
	switch m.Type {
	case "track_confirmed":
		r.onConfirmed(&m)
	case "track_updated":
		r.onUpdated(&m)
	case "track_ended":
		r.onEnded(&m)
	}
}

func (r *Recorder) onConfirmed(m *lifecycleMsg) {
	e := &db.Event{
		ID:         uuid.New().String(),
		CameraID:   m.CameraID,
		TrackKey:   m.TrackKey,
		PersonID:   deref(m.PersonID),
		PersonName: deref(m.Name),
		Similarity: derefF(m.Similarity),
		StartedAt:  toMs(m.TS),
	}
	e.ThumbPath = r.writeThumb(e.ID, m.CropJPEG)
	created, err := r.db.CreateEvent(e)
	if err != nil {
		log.Printf("[events] create %s: %v", m.TrackKey, err)
		return
	}
	if !created {
		// Duplicate delivery (reconnect replay): drop the thumb we just wrote
		// for the discarded uuid so it doesn't sit orphaned on disk.
		if e.ThumbPath != "" {
			os.Remove(e.ThumbPath)
		}
		return
	}
	eventID := e.ID
	r.cutter.Start(eventID, e.CameraID, func(clipPath string, err error) {
		if err != nil {
			log.Printf("[events] clip for %s: %v", eventID, err)
			return
		}
		expires := r.nowFn().Add(r.clipRetention).UnixMilli()
		if err := r.db.SetEventClip(eventID, clipPath, expires); err != nil {
			log.Printf("[events] persist clip for %s: %v", eventID, err)
		}
	})
}

func (r *Recorder) onUpdated(m *lifecycleMsg) {
	ev, ok, err := r.db.GetEventByTrackKey(m.TrackKey)
	if err != nil || !ok || m.PersonID == nil {
		return
	}
	if err := r.db.UpdateEventIdentity(ev.ID, *m.PersonID, deref(m.Name), derefF(m.Similarity)); err != nil {
		log.Printf("[events] update identity %s: %v", ev.ID, err)
	}
}

func (r *Recorder) onEnded(m *lifecycleMsg) {
	ev, ok, err := r.db.GetEventByTrackKey(m.TrackKey)
	if err != nil || !ok {
		return // track never confirmed — nothing to close
	}
	thumb := r.writeThumb(ev.ID, m.CropJPEG) // final best crop may be better
	var embedding []byte
	if deref(m.PersonID) == "" && m.EmbeddingB4 != nil {
		if b, err := base64.StdEncoding.DecodeString(*m.EmbeddingB4); err == nil {
			embedding = b
		}
	}
	if err := r.db.CloseEvent(ev.ID, toMs(m.EndedTS), thumb, embedding); err != nil {
		log.Printf("[events] close %s: %v", ev.ID, err)
	}
	r.cutter.Stop(ev.ID)
}

// writeThumb decodes and stores the crop; returns the path or "".
func (r *Recorder) writeThumb(eventID string, cropB64 *string) string {
	if cropB64 == nil || *cropB64 == "" {
		return ""
	}
	data, err := base64.StdEncoding.DecodeString(*cropB64)
	if err != nil {
		return ""
	}
	path := filepath.Join(r.thumbsDir, eventID+".jpg")
	if err := os.WriteFile(path, data, 0644); err != nil {
		log.Printf("[events] thumb %s: %v", eventID, err)
		return ""
	}
	return path
}

func toMs(ts float64) int64 { return int64(ts * 1000) }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefF(f *float64) float64 {
	if f == nil {
		return 0
	}
	return *f
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./events/ -v -race && go vet ./events/`
Expected: all tests PASS (7 recorder + 4 clips).

- [ ] **Step 5: Commit**

```bash
git add backend/events/recorder.go backend/events/recorder_test.go
git commit -m "feat(backend): event recorder persisting lifecycle messages with thumbs and clips"
```

### Task 7: Push listener — dispatch lifecycle messages

**Files:**
- Modify: `backend/push/listener.go`
- Test: `backend/push/listener_test.go` (create)

**Interfaces:**
- Consumes: nothing new (Recorder's `OnLifecycle` matches the sink signature).
- Produces (Task 11 relies on these): `push.NewListener(faceBaseURL string, notifier Sender, store CameraNameStore) *Listener` — the second parameter becomes the new interface `type Sender interface { Send(Message) }` (satisfied by `*Notifier`; `main.go` compiles unchanged). New method `func (l *Listener) SetLifecycleSink(fn func(raw []byte))`. Notification behavior for `detections` messages is byte-for-byte unchanged (per-frame + 60s cooldown until Phase 3).

- [ ] **Step 1: Write the failing tests**

Create `backend/push/listener_test.go`:

```go
package push

import (
	"sync"
	"testing"
)

type fakeSender struct {
	mu   sync.Mutex
	msgs []Message
}

func (f *fakeSender) Send(m Message) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgs = append(f.msgs, m)
}

type fakeStore struct{}

func (fakeStore) GetCameraName(id string) string { return "Front Door" }

func TestDetectionsStillNotify(t *testing.T) {
	sender := &fakeSender{}
	l := NewListener("http://x", sender, fakeStore{})
	l.handleMessage("cam1", []byte(`{"type":"detections","camera_id":"cam1",
		"detections":[{"person_id":"p1","name":"Alice","score":0.9}]}`))
	if len(sender.msgs) != 1 || !sender.msgs[0].IsKnown || sender.msgs[0].PersonName != "Alice" {
		t.Fatalf("msgs: %+v", sender.msgs)
	}
	// cooldown: identical detection within 60s must not notify again
	l.handleMessage("cam1", []byte(`{"type":"detections","camera_id":"cam1",
		"detections":[{"person_id":"p1","name":"Alice","score":0.9}]}`))
	if len(sender.msgs) != 1 {
		t.Fatalf("cooldown broken: %d msgs", len(sender.msgs))
	}
}

func TestLifecycleGoesToSinkNotNotifier(t *testing.T) {
	sender := &fakeSender{}
	l := NewListener("http://x", sender, fakeStore{})
	var got [][]byte
	l.SetLifecycleSink(func(raw []byte) { got = append(got, raw) })
	for _, typ := range []string{"track_confirmed", "track_updated", "track_ended"} {
		l.handleMessage("cam1", []byte(`{"type":"`+typ+`","camera_id":"cam1","track_key":"k"}`))
	}
	if len(got) != 3 {
		t.Fatalf("sink calls: %d", len(got))
	}
	if len(sender.msgs) != 0 {
		t.Fatalf("lifecycle must not notify: %+v", sender.msgs)
	}
}

func TestNilSinkAndGarbageAreSafe(t *testing.T) {
	l := NewListener("http://x", &fakeSender{}, fakeStore{})
	l.handleMessage("cam1", []byte(`{"type":"track_confirmed","track_key":"k"}`)) // no sink set
	l.handleMessage("cam1", []byte(`garbage`))
	l.handleMessage("cam1", []byte(`{"type":"hello"}`))
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./push/`
Expected: compile FAIL — `handleMessage`/`SetLifecycleSink`/`Sender` undefined (NewListener takes `*Notifier`).

- [ ] **Step 3: Implement**

In `backend/push/listener.go`:

1. Add above `type Listener`:

```go
// Sender is the notification outlet. *Notifier satisfies it.
type Sender interface {
	Send(Message)
}
```

2. Change the `Listener` struct field `notifier *Notifier` to `notifier Sender`, and add a `sink func(raw []byte)` field plus `sinkMu sync.RWMutex`. Change `NewListener`'s parameter from `notifier *Notifier` to `notifier Sender`.

3. Add:

```go
// SetLifecycleSink registers a consumer for track lifecycle messages
// (track_confirmed / track_updated / track_ended). Call before WatchCamera.
func (l *Listener) SetLifecycleSink(fn func(raw []byte)) {
	l.sinkMu.Lock()
	l.sink = fn
	l.sinkMu.Unlock()
}
```

4. Replace the body of the read loop in `connectAndRead` — everything after `ReadMessage` — with a call to the new method, so `connectAndRead` becomes:

```go
func (l *Listener) connectAndRead(wsURL, cameraID string) error {
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	log.Printf("[push-listener] connected to face-service for camera %s", cameraID)
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		l.handleMessage(cameraID, msg)
	}
}

// handleMessage routes one raw WS message: per-frame detections drive push
// notifications (unchanged behavior); track lifecycle messages go to the sink.
func (l *Listener) handleMessage(cameraID string, msg []byte) {
	var frame detectionFrame
	if err := json.Unmarshal(msg, &frame); err != nil {
		return
	}
	switch frame.Type {
	case "detections":
		l.handleDetections(cameraID, &frame)
	case "track_confirmed", "track_updated", "track_ended":
		l.sinkMu.RLock()
		sink := l.sink
		l.sinkMu.RUnlock()
		if sink != nil {
			sink(msg)
		}
	}
}

func (l *Listener) handleDetections(cameraID string, frame *detectionFrame) {
	if len(frame.Detections) == 0 {
		return
	}
	cameraName := l.store.GetCameraName(cameraID)
	for _, det := range frame.Detections {
		isKnown := det.PersonID != ""
		name := det.Name
		if !isKnown {
			name = ""
		}

		personKey := det.PersonID
		if personKey == "" {
			personKey = "unknown"
		}
		cooldownKey := cameraID + ":" + personKey

		l.mu.Lock()
		lastTime, exists := l.lastSent[cooldownKey]
		shouldSend := !exists || time.Since(lastTime) >= 60*time.Second
		if shouldSend {
			l.lastSent[cooldownKey] = time.Now()
		}
		l.mu.Unlock()

		if !shouldSend {
			continue
		}

		l.notifier.Send(Message{
			CameraID:   cameraID,
			CameraName: cameraName,
			PersonName: name,
			IsKnown:    isKnown,
		})
	}
}
```

(The detection-loop body is moved verbatim from the old `connectAndRead`; only the wrapping changed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./push/ -v -race && go build ./... && go vet ./push/`
Expected: 3 tests PASS; whole module still builds (main.go passes `*Notifier` where `Sender` is now expected — satisfied implicitly).

- [ ] **Step 5: Commit**

```bash
git add backend/push/listener.go backend/push/listener_test.go
git commit -m "feat(backend): push listener dispatches track lifecycle messages to sink"
```

### Task 8: Retention loop

**Files:**
- Create: `backend/events/retention.go`
- Test: `backend/events/retention_test.go` (create)

**Interfaces:**
- Consumes: `db.ListExpiredClips/MarkClipExpired/ListEventsBefore/DeleteEvent` from Task 4.
- Produces (Task 11 relies on these):

```go
func NewRetention(database *db.DB, eventRetention time.Duration) *Retention
func (r *Retention) RunOnce() (clipsDeleted, eventsDeleted int)
func (r *Retention) Start(ctx context.Context)   // hourly loop, blocks; run in a goroutine
```

Exported for tests: `NowFn func() time.Time`, `Interval time.Duration`.

- [ ] **Step 1: Write the failing tests**

Create `backend/events/retention_test.go`:

```go
package events

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dim/sentry/backend/db"
)

func TestRunOnceExpiresClipsAndDeletesOldEvents(t *testing.T) {
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	files := t.TempDir()

	now := time.UnixMilli(10_000_000)

	// Event with an expired clip (fresh enough to keep the row)
	expiredClip := &db.Event{CameraID: "c", TrackKey: "k1", StartedAt: now.UnixMilli() - 1000}
	d.CreateEvent(expiredClip)
	clipPath := filepath.Join(files, "k1.mp4")
	os.WriteFile(clipPath, []byte("mp4"), 0644)
	d.SetEventClip(expiredClip.ID, clipPath, now.UnixMilli()-1) // already past expiry

	// Event with a live clip
	liveClip := &db.Event{CameraID: "c", TrackKey: "k2", StartedAt: now.UnixMilli() - 1000}
	d.CreateEvent(liveClip)
	livePath := filepath.Join(files, "k2.mp4")
	os.WriteFile(livePath, []byte("mp4"), 0644)
	d.SetEventClip(liveClip.ID, livePath, now.UnixMilli()+1_000_000)

	// Ancient event past event-retention with a thumb file
	ancient := &db.Event{CameraID: "c", TrackKey: "k3",
		StartedAt: now.Add(-91 * 24 * time.Hour).UnixMilli()}
	d.CreateEvent(ancient)
	thumbPath := filepath.Join(files, "k3.jpg")
	os.WriteFile(thumbPath, []byte("jpg"), 0644)
	d.CloseEvent(ancient.ID, ancient.StartedAt+1, thumbPath, nil)

	r := NewRetention(d, 90*24*time.Hour)
	r.NowFn = func() time.Time { return now }

	clips, events := r.RunOnce()
	if clips != 1 || events != 1 {
		t.Fatalf("clips=%d events=%d", clips, events)
	}
	if _, err := os.Stat(clipPath); !os.IsNotExist(err) {
		t.Fatal("expired clip file not deleted")
	}
	if _, err := os.Stat(livePath); err != nil {
		t.Fatal("live clip file must remain")
	}
	if _, err := os.Stat(thumbPath); !os.IsNotExist(err) {
		t.Fatal("ancient event thumb not deleted")
	}
	got, _, _ := d.GetEvent(expiredClip.ID)
	if !got.ClipExpired {
		t.Fatal("clip_expired not set")
	}
	if _, ok, _ := d.GetEvent(ancient.ID); ok {
		t.Fatal("ancient event row not deleted")
	}
	if _, ok, _ := d.GetEvent(liveClip.ID); !ok {
		t.Fatal("fresh event must remain")
	}

	// idempotent
	clips, events = r.RunOnce()
	if clips != 0 || events != 0 {
		t.Fatalf("second run: clips=%d events=%d", clips, events)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./events/ -run TestRunOnce`
Expected: compile FAIL — `undefined: NewRetention`.

- [ ] **Step 3: Implement**

Create `backend/events/retention.go`:

```go
package events

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/dim/sentry/backend/db"
)

// Retention deletes clip files past their expiry (marking the event row) and
// removes whole event rows + their files once past the event retention window.
type Retention struct {
	db             *db.DB
	eventRetention time.Duration

	Interval time.Duration
	NowFn    func() time.Time
}

func NewRetention(database *db.DB, eventRetention time.Duration) *Retention {
	return &Retention{
		db:             database,
		eventRetention: eventRetention,
		Interval:       time.Hour,
		NowFn:          time.Now,
	}
}

// Start runs RunOnce immediately and then on every Interval tick until ctx ends.
func (r *Retention) Start(ctx context.Context) {
	r.RunOnce()
	ticker := time.NewTicker(r.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.RunOnce()
		}
	}
}

func (r *Retention) RunOnce() (clipsDeleted, eventsDeleted int) {
	now := r.NowFn()

	expired, err := r.db.ListExpiredClips(now.UnixMilli())
	if err != nil {
		log.Printf("[retention] list expired clips: %v", err)
	}
	for _, e := range expired {
		if err := os.Remove(e.ClipPath); err != nil && !os.IsNotExist(err) {
			log.Printf("[retention] delete clip %s: %v", e.ClipPath, err)
			continue
		}
		if err := r.db.MarkClipExpired(e.ID); err != nil {
			log.Printf("[retention] mark expired %s: %v", e.ID, err)
			continue
		}
		clipsDeleted++
	}

	cutoff := now.Add(-r.eventRetention).UnixMilli()
	old, err := r.db.ListEventsBefore(cutoff)
	if err != nil {
		log.Printf("[retention] list old events: %v", err)
	}
	for _, e := range old {
		for _, p := range []string{e.ThumbPath, e.ClipPath} {
			if p == "" {
				continue
			}
			if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
				log.Printf("[retention] delete %s: %v", p, err)
			}
		}
		if err := r.db.DeleteEvent(e.ID); err != nil {
			log.Printf("[retention] delete event %s: %v", e.ID, err)
			continue
		}
		eventsDeleted++
	}

	if clipsDeleted > 0 || eventsDeleted > 0 {
		log.Printf("[retention] deleted %d expired clips, %d old events", clipsDeleted, eventsDeleted)
	}
	return clipsDeleted, eventsDeleted
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./events/ -v -race && go vet ./events/`
Expected: all events-package tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/events/retention.go backend/events/retention_test.go
git commit -m "feat(backend): retention loop for clips (72h) and events (90d)"
```

### Task 9: Face client — CreatePerson + UploadPhoto

**Files:**
- Modify: `backend/face/client.go`
- Test: `backend/face/client_test.go` (create)

**Interfaces:**
- Produces (Task 10 relies on these):

```go
func (c *Client) CreatePerson(ctx context.Context, name string) (string, error)  // returns new person id
func (c *Client) UploadPhoto(ctx context.Context, personID string, jpeg []byte, filename string) error
```

Face-service contract (verified in `face_service/server.py` / `db.py`): `POST /persons` with `{"name": ...}` returns 201 `{"id": "...", "name": ..., ...}`; `POST /persons/{pid}/photos` accepts multipart field `photo`, returns 201 on success, 400 with `{"added":[],"errors":[...]}` when no face is found in the image.

- [ ] **Step 1: Write the failing tests**

Create `backend/face/client_test.go`:

```go
package face

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCreatePerson(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/persons" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		if body["name"] != "Maria" {
			t.Errorf("name = %q", body["name"])
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{"id": "pid-123", "name": "Maria"})
	}))
	defer srv.Close()

	id, err := NewClient(srv.URL).CreatePerson(context.Background(), "Maria")
	if err != nil {
		t.Fatal(err)
	}
	if id != "pid-123" {
		t.Fatalf("id = %q", id)
	}
}

func TestCreatePersonErrorSurfaced(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"name is required"}`))
	}))
	defer srv.Close()
	if _, err := NewClient(srv.URL).CreatePerson(context.Background(), ""); err == nil {
		t.Fatal("expected error")
	}
}

func TestUploadPhoto(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/persons/pid-123/photos" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Errorf("multipart: %v", err)
		}
		f, hdr, err := r.FormFile("photo")
		if err != nil {
			t.Fatalf("no photo field: %v", err)
		}
		defer f.Close()
		if hdr.Filename != "event-1.jpg" {
			t.Errorf("filename = %q", hdr.Filename)
		}
		data, _ := io.ReadAll(f)
		if string(data) != "jpegbytes" {
			t.Errorf("payload = %q", data)
		}
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{"added":[{}],"errors":[]}`))
	}))
	defer srv.Close()

	err := NewClient(srv.URL).UploadPhoto(context.Background(), "pid-123", []byte("jpegbytes"), "event-1.jpg")
	if err != nil {
		t.Fatal(err)
	}
}

func TestUploadPhotoNoFaceSurfaced(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"added":[],"errors":[{"error":"no face found"}]}`))
	}))
	defer srv.Close()
	err := NewClient(srv.URL).UploadPhoto(context.Background(), "p", []byte("x"), "f.jpg")
	if err == nil {
		t.Fatal("expected error")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./face/`
Expected: compile FAIL — methods undefined.

- [ ] **Step 3: Implement**

Append to `backend/face/client.go` (add `"mime/multipart"` to imports):

```go
// CreatePerson creates a person record in the face-service and returns its id.
func (c *Client) CreatePerson(ctx context.Context, name string) (string, error) {
	body, _ := json.Marshal(map[string]string{"name": name})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/persons", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		msg, _ := io.ReadAll(res.Body)
		return "", fmt.Errorf("face-service create person: status %d: %s", res.StatusCode, msg)
	}
	var person struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(res.Body).Decode(&person); err != nil || person.ID == "" {
		return "", fmt.Errorf("face-service create person: bad response (%v)", err)
	}
	return person.ID, nil
}

// UploadPhoto enrolls a JPEG as a recognition photo for an existing person.
// The face-service extracts the embedding, generates augmented variants, and
// rebuilds the match index.
func (c *Client) UploadPhoto(ctx context.Context, personID string, jpeg []byte, filename string) error {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fw, err := w.CreateFormFile("photo", filename)
	if err != nil {
		return err
	}
	if _, err := fw.Write(jpeg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		c.baseURL+"/persons/"+personID+"/photos", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		msg, _ := io.ReadAll(res.Body)
		return fmt.Errorf("face-service upload photo: status %d: %s", res.StatusCode, msg)
	}
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./face/ -v && go vet ./face/`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/face/client.go backend/face/client_test.go
git commit -m "feat(backend): face client person creation and photo enrollment"
```

### Task 10: Events REST API + labeling

**Files:**
- Create: `backend/handlers/events.go`
- Test: `backend/handlers/events_test.go` (create)

**Interfaces:**
- Consumes: `db` event methods (Task 4), face client methods (Task 9).
- Produces (Task 11 wires these routes):

```go
type FaceEnroller interface {
	CreatePerson(ctx context.Context, name string) (string, error)
	UploadPhoto(ctx context.Context, personID string, jpeg []byte, filename string) error
}
func NewEventsHandler(database *db.DB, face FaceEnroller) *EventsHandler
func (h *EventsHandler) List(c *gin.Context)   // GET  /api/events
func (h *EventsHandler) Get(c *gin.Context)    // GET  /api/events/:id
func (h *EventsHandler) Thumb(c *gin.Context)  // GET  /api/events/:id/thumb
func (h *EventsHandler) Clip(c *gin.Context)   // GET  /api/events/:id/clip
func (h *EventsHandler) Label(c *gin.Context)  // POST /api/events/:id/label
```

Event JSON shape (all list/get responses):

```json
{"id":"...","camera_id":"...","person_id":"p1"|null,"person_name":"Alice",
 "similarity":0.5,"started_at":1721400000000,"ended_at":0,
 "labeled_person_id":"..."|null,"has_thumb":true,"has_clip":true,
 "clip_expired":false,"thumb_url":"/api/events/<id>/thumb","clip_url":"/api/events/<id>/clip"}
```

`thumb_url`/`clip_url` are null when unavailable. `List` responds `{"events":[...],"next_before":<started_at of last row>|null}`.

- [ ] **Step 1: Write the failing tests**

Create `backend/handlers/events_test.go`:

```go
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./handlers/ -run 'TestList|TestThumb|TestLabel|TestCosine'`
Expected: compile FAIL — `NewEventsHandler` undefined.

- [ ] **Step 3: Implement**

Create `backend/handlers/events.go`:

```go
package handlers

import (
	"context"
	"encoding/binary"
	"math"
	"net/http"
	"os"
	"strconv"

	"github.com/dim/sentry/backend/db"
	"github.com/gin-gonic/gin"
)

// retroLabelThreshold: unknown events whose embedding cosine-matches the newly
// labeled event at or above this are auto-labeled too (spec: acquire threshold).
const retroLabelThreshold = 0.45

// FaceEnroller is the slice of the face-service client the labeling flow needs.
type FaceEnroller interface {
	CreatePerson(ctx context.Context, name string) (string, error)
	UploadPhoto(ctx context.Context, personID string, jpeg []byte, filename string) error
}

type EventsHandler struct {
	db   *db.DB
	face FaceEnroller
}

func NewEventsHandler(database *db.DB, face FaceEnroller) *EventsHandler {
	return &EventsHandler{db: database, face: face}
}

func eventJSON(e *db.Event) gin.H {
	h := gin.H{
		"id":                e.ID,
		"camera_id":         e.CameraID,
		"person_id":         nilIfEmpty(e.PersonID),
		"person_name":       e.PersonName,
		"similarity":        e.Similarity,
		"started_at":        e.StartedAt,
		"ended_at":          e.EndedAt,
		"labeled_person_id": nilIfEmpty(e.LabeledPersonID),
		"has_thumb":         e.ThumbPath != "",
		"has_clip":          e.ClipPath != "" && !e.ClipExpired,
		"clip_expired":      e.ClipExpired,
		"thumb_url":         nil,
		"clip_url":          nil,
	}
	if e.ThumbPath != "" {
		h["thumb_url"] = "/api/events/" + e.ID + "/thumb"
	}
	if e.ClipPath != "" && !e.ClipExpired {
		h["clip_url"] = "/api/events/" + e.ID + "/clip"
	}
	return h
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// List handles GET /api/events?camera_id&person_id&unknown=1&from&to&limit&before
func (h *EventsHandler) List(c *gin.Context) {
	f := db.EventFilter{
		CameraID: c.Query("camera_id"),
		PersonID: c.Query("person_id"),
	}
	f.UnknownOnly = c.Query("unknown") == "1" || c.Query("unknown") == "true"
	f.From, _ = strconv.ParseInt(c.Query("from"), 10, 64)
	f.To, _ = strconv.ParseInt(c.Query("to"), 10, 64)
	f.Before, _ = strconv.ParseInt(c.Query("before"), 10, 64)
	limit, _ := strconv.Atoi(c.Query("limit"))
	f.Limit = limit

	events, err := h.db.ListEvents(f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(events))
	for _, e := range events {
		out = append(out, eventJSON(e))
	}
	// A full page means there may be more: hand back a cursor. Mirrors the
	// clamping ListEvents applies (default 50, max 200).
	pageSize := f.Limit
	if pageSize <= 0 {
		pageSize = 50
	}
	if pageSize > 200 {
		pageSize = 200
	}
	var nextBefore any
	if len(events) == pageSize {
		nextBefore = events[len(events)-1].StartedAt
	}
	c.JSON(http.StatusOK, gin.H{"events": out, "next_before": nextBefore})
}

func (h *EventsHandler) Get(c *gin.Context) {
	ev, ok, err := h.db.GetEvent(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "event not found"})
		return
	}
	c.JSON(http.StatusOK, eventJSON(ev))
}

func (h *EventsHandler) Thumb(c *gin.Context) {
	ev, ok, err := h.db.GetEvent(c.Param("id"))
	if err != nil || !ok || ev.ThumbPath == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "no thumbnail"})
		return
	}
	if _, err := os.Stat(ev.ThumbPath); err != nil {
		c.JSON(http.StatusGone, gin.H{"error": "thumbnail file missing"})
		return
	}
	c.Header("Content-Type", "image/jpeg")
	c.File(ev.ThumbPath)
}

func (h *EventsHandler) Clip(c *gin.Context) {
	ev, ok, err := h.db.GetEvent(c.Param("id"))
	if err != nil || !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "event not found"})
		return
	}
	if ev.ClipExpired {
		c.JSON(http.StatusGone, gin.H{"error": "clip expired (retention window passed)"})
		return
	}
	if ev.ClipPath == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "no clip for this event"})
		return
	}
	if _, err := os.Stat(ev.ClipPath); err != nil {
		c.JSON(http.StatusGone, gin.H{"error": "clip file missing"})
		return
	}
	c.Header("Content-Type", "video/mp4")
	c.File(ev.ClipPath)
}

// Label handles POST /api/events/:id/label with {"person_id"} or {"new_person_name"}.
// The event's best face crop is enrolled as a recognition photo for the person,
// and other unknown events with a matching embedding are retro-labeled.
func (h *EventsHandler) Label(c *gin.Context) {
	ev, ok, err := h.db.GetEvent(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "event not found"})
		return
	}
	if ev.PersonID != "" || ev.LabeledPersonID != "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "event is not unknown"})
		return
	}
	if ev.ThumbPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "event has no face crop to enroll"})
		return
	}

	var req struct {
		PersonID      string `json:"person_id"`
		NewPersonName string `json:"new_person_name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || (req.PersonID == "" && req.NewPersonName == "") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "person_id or new_person_name required"})
		return
	}

	jpeg, err := os.ReadFile(ev.ThumbPath)
	if err != nil {
		c.JSON(http.StatusGone, gin.H{"error": "face crop file missing"})
		return
	}

	pid := req.PersonID
	if pid == "" {
		pid, err = h.face.CreatePerson(c.Request.Context(), req.NewPersonName)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
	}
	if err := h.face.UploadPhoto(c.Request.Context(), pid, jpeg, "event-"+ev.ID+".jpg"); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if err := h.db.LabelEvent(ev.ID, pid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	retro := 0
	if len(ev.Embedding) > 0 {
		unknowns, err := h.db.ListUnknownWithEmbeddings()
		if err == nil {
			for _, u := range unknowns {
				if u.ID == ev.ID {
					continue
				}
				if cosineSim(ev.Embedding, u.Embedding) >= retroLabelThreshold {
					if h.db.LabelEvent(u.ID, pid) == nil {
						retro++
					}
				}
			}
		}
	}
	c.JSON(http.StatusOK, gin.H{"labeled_person_id": pid, "retro_labeled": retro})
}

// cosineSim computes cosine similarity between two little-endian float32 blobs.
// Returns -1 for malformed/mismatched inputs.
func cosineSim(a, b []byte) float64 {
	if len(a) == 0 || len(a) != len(b) || len(a)%4 != 0 {
		return -1
	}
	var dot, na, nb float64
	for i := 0; i < len(a); i += 4 {
		x := float64(math.Float32frombits(binary.LittleEndian.Uint32(a[i:])))
		y := float64(math.Float32frombits(binary.LittleEndian.Uint32(b[i:])))
		dot += x * y
		na += x * x
		nb += y * y
	}
	if na == 0 || nb == 0 {
		return -1
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}
```

Note on `List` pagination: `next_before` is set when the page is full (`len == limit`, or `len == 50` when no explicit limit). Clients pass it back as `?before=`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./handlers/ -v -race && go vet ./handlers/`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/handlers/events.go backend/handlers/events_test.go
git commit -m "feat(backend): events REST API with clips, thumbs, and unknown labeling"
```

### Task 11: Wiring, env, docs, full gates

**Files:**
- Modify: `backend/main.go`
- Modify: `.env.example`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above. Produces the running system; no new interfaces.

- [ ] **Step 1: Wire main.go**

In `backend/main.go`:

1. Add imports: `"path/filepath"`, `"strconv"`, and `"github.com/dim/sentry/backend/events"`.
2. After the `listener := push.NewListener(...)` line (and BEFORE the `for _, cam := range store.List()` loop that calls `WatchCamera`), insert:

```go
	// Sighting events: lifecycle messages -> SQLite events + thumbs + clips
	clipsDir := filepath.Join(dataDir, "clips")
	thumbsDir := filepath.Join(dataDir, "thumbs")
	for _, dir := range []string{clipsDir, thumbsDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	clipRetention := time.Duration(envIntOr("SENTRY_CLIP_RETENTION_HOURS", 72)) * time.Hour
	eventRetention := time.Duration(envIntOr("SENTRY_EVENT_RETENTION_DAYS", 90)) * 24 * time.Hour
	cutter := events.NewClipCutter(stream.HLSDir(), clipsDir)
	recorder := events.NewRecorder(database, thumbsDir, cutter, clipRetention)
	listener.SetLifecycleSink(recorder.OnLifecycle)
	retention := events.NewRetention(database, eventRetention)
	go retention.Start(context.Background())
```

3. Inside the `authed` route group, after the `cameras` group, add:

```go
			// Sighting events (log, thumbs, clips, unknown labeling)
			eventsH := handlers.NewEventsHandler(database, faceClient)
			eventsGroup := authed.Group("/events")
			{
				eventsGroup.GET("", eventsH.List)
				eventsGroup.GET("/:id", eventsH.Get)
				eventsGroup.GET("/:id/thumb", eventsH.Thumb)
				eventsGroup.GET("/:id/clip", eventsH.Clip)
				eventsGroup.POST("/:id/label", eventsH.Label)
			}
```

4. Add next to `envOr` at the bottom of the file:

```go
func envIntOr(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
```

- [ ] **Step 2: Update .env.example**

Append to `.env.example`:

```
# Sighting events retention
# SENTRY_CLIP_RETENTION_HOURS=72    # video clips deleted after this
# SENTRY_EVENT_RETENTION_DAYS=90    # event history + thumbnails deleted after this
```

- [ ] **Step 3: Update CLAUDE.md**

In the **Backend (Go)** section:

1. Extend the **Key env vars** line with: `` `SENTRY_CLIP_RETENTION_HOURS` (default `72`), `SENTRY_EVENT_RETENTION_DAYS` (default `90`) ``.
2. Add an architecture bullet after the `push/` bullet:

```markdown
- `events/` — sighting events. `recorder.go` consumes track lifecycle messages (`track_confirmed`/`track_updated`/`track_ended`) dispatched by `push/listener.go`, persisting one event per confirmed track with a best-face thumbnail (`data/thumbs/`). `clips.go` copies live HLS segments from confirm time (pre-roll ≈ 10s) until track end + 5s and stitches them losslessly into `data/clips/<event_id>.mp4` (cap 2 min). `retention.go` expires clips after `SENTRY_CLIP_RETENTION_HOURS` and deletes event rows + thumbs after `SENTRY_EVENT_RETENTION_DAYS`. REST surface: `/api/events` (list/detail/thumb/clip/label — labeling enrolls the crop via the face-service and retro-labels matching unknowns).
```

In the **Face Service (Python)** architecture section, add after the `tracker.py` bullet:

```markdown
- `lifecycle.py` — `LifecycleEmitter` turns tracker state transitions into `track_confirmed`/`track_updated`/`track_ended` WS messages carrying the track's best face crop (JPEG, chosen by area × det score × sharpness) and its embedding. Consumed by the Go backend's event recorder.
```

- [ ] **Step 4: Full gates**

Run:

```bash
cd backend && go build ./... && go test ./... && go vet ./...
cd ../face-service && .venv/bin/python -m pytest tests -q
```

Expected: everything green (Go: db, events, push, face, handlers packages; Python: 48 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/main.go .env.example CLAUDE.md
git commit -m "feat(backend): wire sighting events, clips, retention, and events API"
```

## Manual end-to-end verification (after all tasks)

With a webcam as camera (`python3 scripts/webcam_rtsp.py`, add `rtsp://localhost:8554/cam` in the UI, enable face recognition):

1. Walk into frame → `data/thumbs/<id>.jpg` appears, `data/clips/staging/<id>/` fills with segments.
2. Leave frame → after ~10s staging disappears and `data/clips/<id>.mp4` exists and plays (VLC).
3. `curl -H "Authorization: Bearer $TOKEN" localhost:8080/api/events` shows the event with `thumb_url`/`clip_url`.
4. `curl -X POST -H ... -d '{"new_person_name":"Test"}' localhost:8080/api/events/<id>/label` → person appears in `/api/persons` with one photo; the worker log shows an index reload.
