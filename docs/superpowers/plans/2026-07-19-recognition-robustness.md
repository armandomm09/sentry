# Recognition Robustness (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop identity wiggle (known ↔ unknown flapping) and far-face false "unknown"s by adding quality-gated voting, sticky-identity hysteresis, and unknown-requires-proof to the face-service tracker.

**Architecture:** The `FaceTrack` majority-vote identity cache is replaced by a per-track state machine (`pending → known | unknown`) with two similarity thresholds (acquire 0.45 / keep 0.35). Only "quality" frames (big, confidently-detected faces) may vote. The worker's match index floor drops to the keep threshold so hysteresis sees sub-0.42 similarities. No schema, API, or Go changes.

**Tech Stack:** Python 3.11+, numpy, pytest (in `face-service/.venv`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-19-face-recognition-reliability-design.md` (Section 1). Best-crop selection from Section 1 is deferred to the Phase 2 plan, where its only consumer (event thumbnails) lands.

## Global Constraints

- New env vars and defaults (exact, from spec): `FACE_SERVICE_ACQUIRE_THRESHOLD=0.45`, `FACE_SERVICE_KEEP_THRESHOLD=0.35`, `FACE_SERVICE_ACQUIRE_VOTES=3`, `FACE_SERVICE_MIN_VOTE_FACE_PX=48`, `FACE_SERVICE_MIN_VOTE_DET_SCORE=0.6`, `FACE_SERVICE_UNKNOWN_MIN_AGE_S=3.0`, `FACE_SERVICE_UNKNOWN_MIN_VOTES=5`.
- `FACE_SERVICE_MATCH_THRESHOLD` (0.42) remains and keeps its meaning for `PersonStore` (enrollment); the per-camera worker no longer uses it.
- `FACE_SERVICE_TRACK_VOTE_WINDOW` / `Config.track_vote_window` are removed (replaced by acquire-vote counting).
- A track that reached `known` never reverts to `unknown`. An `unknown` track may still upgrade to `known`.
- All tests run headless: `cd face-service && .venv/bin/python -m pytest tests -v`. If pytest is missing: `.venv/bin/pip install pytest`.
- The `detections` WebSocket payload keeps all existing fields (`track_id, bbox, score, person_id, name, similarity`); it additionally gains `"state"`. Nothing may break the frontend overlay which reads the existing fields.

---

### Task 1: Config — identity knobs

**Files:**
- Modify: `face-service/face_service/config.py`
- Test: `face-service/tests/test_config.py` (create)

**Interfaces:**
- Produces: `Config` gains float fields `acquire_threshold`, `keep_threshold`, `unknown_min_age_s`, `min_vote_det_score` and int fields `acquire_votes`, `min_vote_face_px`, `unknown_min_votes`; loses `track_vote_window`. Task 3 reads all of these off `config`.

- [ ] **Step 1: Write the failing test**

Create `face-service/tests/test_config.py`:

```python
from face_service.config import Config


def test_identity_defaults(monkeypatch):
    for var in (
        "FACE_SERVICE_ACQUIRE_THRESHOLD",
        "FACE_SERVICE_KEEP_THRESHOLD",
        "FACE_SERVICE_ACQUIRE_VOTES",
        "FACE_SERVICE_MIN_VOTE_FACE_PX",
        "FACE_SERVICE_MIN_VOTE_DET_SCORE",
        "FACE_SERVICE_UNKNOWN_MIN_AGE_S",
        "FACE_SERVICE_UNKNOWN_MIN_VOTES",
    ):
        monkeypatch.delenv(var, raising=False)
    cfg = Config.from_env()
    assert cfg.acquire_threshold == 0.45
    assert cfg.keep_threshold == 0.35
    assert cfg.acquire_votes == 3
    assert cfg.min_vote_face_px == 48
    assert cfg.min_vote_det_score == 0.6
    assert cfg.unknown_min_age_s == 3.0
    assert cfg.unknown_min_votes == 5
    assert not hasattr(cfg, "track_vote_window")


def test_identity_env_overrides(monkeypatch):
    monkeypatch.setenv("FACE_SERVICE_ACQUIRE_THRESHOLD", "0.5")
    monkeypatch.setenv("FACE_SERVICE_KEEP_THRESHOLD", "0.3")
    monkeypatch.setenv("FACE_SERVICE_ACQUIRE_VOTES", "4")
    monkeypatch.setenv("FACE_SERVICE_MIN_VOTE_FACE_PX", "64")
    monkeypatch.setenv("FACE_SERVICE_MIN_VOTE_DET_SCORE", "0.7")
    monkeypatch.setenv("FACE_SERVICE_UNKNOWN_MIN_AGE_S", "5.5")
    monkeypatch.setenv("FACE_SERVICE_UNKNOWN_MIN_VOTES", "8")
    cfg = Config.from_env()
    assert cfg.acquire_threshold == 0.5
    assert cfg.keep_threshold == 0.3
    assert cfg.acquire_votes == 4
    assert cfg.min_vote_face_px == 64
    assert cfg.min_vote_det_score == 0.7
    assert cfg.unknown_min_age_s == 5.5
    assert cfg.unknown_min_votes == 8
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd face-service && .venv/bin/python -m pytest tests/test_config.py -v`
Expected: FAIL — `TypeError`/`AttributeError` (fields don't exist yet).

- [ ] **Step 3: Implement**

In `face-service/face_service/config.py`, inside `class Config`, replace the line `track_vote_window: int` with:

```python
    acquire_threshold: float   # similarity to acquire a track identity
    keep_threshold: float      # similarity to refresh an acquired identity
    acquire_votes: int         # quality votes at acquire level to (re)assign identity
    min_vote_face_px: int      # min bbox height (processing px) for a vote to count
    min_vote_det_score: float  # min detector score for a vote to count
    unknown_min_age_s: float   # track age before "unknown" may be declared
    unknown_min_votes: int     # quality votes before "unknown" may be declared
```

In `from_env()`, replace `track_vote_window=_env_int("FACE_SERVICE_TRACK_VOTE_WINDOW", 10),` with:

```python
            acquire_threshold=_env_float("FACE_SERVICE_ACQUIRE_THRESHOLD", 0.45),
            keep_threshold=_env_float("FACE_SERVICE_KEEP_THRESHOLD", 0.35),
            acquire_votes=_env_int("FACE_SERVICE_ACQUIRE_VOTES", 3),
            min_vote_face_px=_env_int("FACE_SERVICE_MIN_VOTE_FACE_PX", 48),
            min_vote_det_score=_env_float("FACE_SERVICE_MIN_VOTE_DET_SCORE", 0.6),
            unknown_min_age_s=_env_float("FACE_SERVICE_UNKNOWN_MIN_AGE_S", 3.0),
            unknown_min_votes=_env_int("FACE_SERVICE_UNKNOWN_MIN_VOTES", 5),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd face-service && .venv/bin/python -m pytest tests/test_config.py -v`
Expected: 2 PASS. (`tests/test_tracker.py` and worker are now temporarily inconsistent with config — fixed in Tasks 2–3; do not run the full suite yet.)

- [ ] **Step 5: Commit**

```bash
git add face-service/face_service/config.py face-service/tests/test_config.py
git commit -m "feat(face): add identity hysteresis config knobs, drop vote_window"
```

### Task 2: Tracker — sticky-identity state machine

**Files:**
- Modify: `face-service/face_service/tracker.py` (replace `FaceTrack` voting internals; keep IoU association code — `_iou`, `_greedy_match` — unchanged)
- Test: `face-service/tests/test_tracker.py` (rewrite voting tests, keep structural tests)

**Interfaces:**
- Consumes: `Match` dataclass from `recognizer.py` (`person_id: str, name: str, similarity: float`) — unchanged.
- Produces (Task 3 relies on these exact names):
  - `IdentityParams` frozen dataclass: `acquire_threshold: float, keep_threshold: float, acquire_votes: int, min_vote_face_px: int, min_vote_det_score: float, unknown_min_age_s: float, unknown_min_votes: int`
  - `FaceTracker(min_iou, min_hits, max_lost, params: IdentityParams, now_fn=time.monotonic)`
  - `FaceTrack.state: str` ∈ `{"pending", "known", "unknown"}` (module constants `PENDING`, `KNOWN`, `UNKNOWN`)
  - `FaceTrack.push_vote(match: Match | None) -> None` (self-gates on quality)
  - `FaceTrack.identity: Match | None` (attribute; set only in `known` state)
  - `FaceTracker.update(faces)` / `FaceTracker.confirmed_tracks()` — signatures unchanged; `update` also resolves pending→unknown using `now_fn`.

- [ ] **Step 1: Rewrite the test file**

Replace `face-service/tests/test_tracker.py` entirely with:

```python
import numpy as np
import pytest
from face_service.recognizer import DetectedFace, Match
from face_service.tracker import KNOWN, PENDING, UNKNOWN, FaceTracker, IdentityParams

PARAMS = IdentityParams(
    acquire_threshold=0.45,
    keep_threshold=0.35,
    acquire_votes=3,
    min_vote_face_px=48,
    min_vote_det_score=0.6,
    unknown_min_age_s=3.0,
    unknown_min_votes=5,
)


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def _face(x1=10, y1=10, x2=90, y2=90, score=0.99, emb_dim=0):
    emb = np.zeros(512, dtype=np.float32)
    emb[emb_dim] = 1.0
    return DetectedFace(bbox=(x1, y1, x2, y2), score=score, embedding=emb, landmarks=None)


def _match(pid="pid_a", name="Alice", sim=0.9):
    return Match(person_id=pid, name=name, similarity=sim)


def _tracker(clock=None, **overrides):
    params = IdentityParams(**{**PARAMS.__dict__, **overrides})
    return FaceTracker(
        min_iou=0.3, min_hits=1, max_lost=5, params=params,
        now_fn=clock if clock is not None else FakeClock(),
    )


def _confirmed_track(tracker, face=None):
    tracker.update([face if face is not None else _face()])
    return tracker.confirmed_tracks()[0]


# --- structural behavior (unchanged from before) -----------------------------

def test_new_track_is_tentative():
    t = FaceTracker(min_iou=0.3, min_hits=3, max_lost=5, params=PARAMS, now_fn=FakeClock())
    t.update([_face()])
    assert t.confirmed_tracks() == []


def test_track_confirmed_after_min_hits():
    t = FaceTracker(min_iou=0.3, min_hits=3, max_lost=5, params=PARAMS, now_fn=FakeClock())
    for _ in range(3):
        t.update([_face()])
    assert len(t.confirmed_tracks()) == 1


def test_track_dies_after_max_lost():
    t = FaceTracker(min_iou=0.3, min_hits=3, max_lost=2, params=PARAMS, now_fn=FakeClock())
    for _ in range(3):
        t.update([_face()])
    for _ in range(3):
        t.update([])
    assert t.confirmed_tracks() == []


def test_current_embedding_none_when_lost():
    t = _tracker()
    t.update([_face()])
    t.update([])
    assert t.confirmed_tracks()[0].current_embedding is None


# --- quality gating -----------------------------------------------------------

def test_small_face_votes_are_ignored():
    t = _tracker()
    track = _confirmed_track(t, _face(y1=10, y2=40))  # bbox height 30 < 48px
    for _ in range(10):
        track.push_vote(_match(sim=0.9))
    assert track.state == PENDING
    assert track.quality_votes == 0


def test_low_det_score_votes_are_ignored():
    t = _tracker()
    track = _confirmed_track(t, _face(score=0.4))  # det_score < 0.6
    for _ in range(10):
        track.push_vote(_match(sim=0.9))
    assert track.state == PENDING


# --- acquire ------------------------------------------------------------------

def test_acquire_after_enough_strong_votes():
    t = _tracker()
    track = _confirmed_track(t)
    track.push_vote(_match(sim=0.5))
    track.push_vote(_match(sim=0.5))
    assert track.state == PENDING
    track.push_vote(_match(sim=0.5))
    assert track.state == KNOWN
    assert track.identity.person_id == "pid_a"


def test_weak_votes_do_not_acquire():
    t = _tracker()
    track = _confirmed_track(t)
    for _ in range(10):
        track.push_vote(_match(sim=0.40))  # above keep, below acquire
    assert track.state == PENDING


# --- sticky identity / hysteresis ----------------------------------------------

def test_known_survives_none_votes():
    t = _tracker()
    track = _confirmed_track(t)
    for _ in range(3):
        track.push_vote(_match(sim=0.5))
    assert track.state == KNOWN
    for _ in range(50):
        track.push_vote(None)  # far away / no match — the wiggle scenario
    assert track.state == KNOWN
    assert track.identity.person_id == "pid_a"


def test_keep_level_vote_refreshes_similarity_upward():
    t = _tracker()
    track = _confirmed_track(t)
    for _ in range(3):
        track.push_vote(_match(sim=0.46))
    track.push_vote(_match(sim=0.60))
    assert track.identity.similarity == 0.60
    track.push_vote(_match(sim=0.36))  # keep-level, lower — must not downgrade
    assert track.identity.similarity == 0.60


def test_switch_to_other_person_needs_sustained_acquire_evidence():
    t = _tracker()
    track = _confirmed_track(t)
    for _ in range(3):
        track.push_vote(_match("pid_a", "Alice", 0.5))
    track.push_vote(_match("pid_b", "Bob", 0.5))
    track.push_vote(_match("pid_b", "Bob", 0.5))
    assert track.identity.person_id == "pid_a"  # 2 votes not enough
    track.push_vote(_match("pid_b", "Bob", 0.5))
    assert track.identity.person_id == "pid_b"


def test_keep_vote_resets_switch_progress():
    t = _tracker()
    track = _confirmed_track(t)
    for _ in range(3):
        track.push_vote(_match("pid_a", "Alice", 0.5))
    track.push_vote(_match("pid_b", "Bob", 0.5))
    track.push_vote(_match("pid_b", "Bob", 0.5))
    track.push_vote(_match("pid_a", "Alice", 0.4))  # keep-level refresh for Alice
    track.push_vote(_match("pid_b", "Bob", 0.5))
    assert track.identity.person_id == "pid_a"  # Bob's count restarted


# --- unknown requires proof -----------------------------------------------------

def test_unknown_needs_age_and_votes():
    clock = FakeClock()
    t = _tracker(clock=clock)
    face = _face()
    t.update([face])
    track = t.confirmed_tracks()[0]
    for _ in range(5):
        track.push_vote(None)
    t.update([face])  # young track: votes ok, age not reached
    assert track.state == PENDING

    clock.t += 3.5
    t.update([face])  # old enough + enough votes
    assert track.state == UNKNOWN


def test_young_track_with_no_matches_stays_pending():
    clock = FakeClock()
    t = _tracker(clock=clock)
    face = _face()
    t.update([face])
    track = t.confirmed_tracks()[0]
    track.push_vote(None)
    clock.t += 10.0
    t.update([face])  # old, but only 1 quality vote < 5
    assert track.state == PENDING


def test_unknown_can_upgrade_to_known():
    clock = FakeClock()
    t = _tracker(clock=clock)
    face = _face()
    t.update([face])
    track = t.confirmed_tracks()[0]
    for _ in range(5):
        track.push_vote(None)
    clock.t += 3.5
    t.update([face])
    assert track.state == UNKNOWN
    for _ in range(3):
        track.push_vote(_match(sim=0.5))  # person walked closer
    assert track.state == KNOWN


def test_known_never_reverts_to_unknown():
    clock = FakeClock()
    t = _tracker(clock=clock)
    face = _face()
    t.update([face])
    track = t.confirmed_tracks()[0]
    for _ in range(3):
        track.push_vote(_match(sim=0.5))
    for _ in range(50):
        track.push_vote(None)
    clock.t += 100.0
    t.update([face])
    assert track.state == KNOWN
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd face-service && .venv/bin/python -m pytest tests/test_tracker.py -v`
Expected: collection error — `ImportError: cannot import name 'IdentityParams'`.

- [ ] **Step 3: Implement the state machine**

In `face-service/face_service/tracker.py`:

Replace the module docstring and imports at the top with:

```python
"""Lightweight IoU-based face tracker with a sticky-identity state machine.

Identity lifecycle per track:
  pending -> known    after >= acquire_votes quality votes for one person at
                      similarity >= acquire_threshold
  pending -> unknown  once the track is older than unknown_min_age_s with at
                      least unknown_min_votes quality votes and nothing acquired
  unknown -> known    same rule as pending -> known (person came closer)
  known   -> known(Q) only with sustained acquire-level evidence for Q
  known   -> unknown  never

A vote is "quality" only when the face is large and confidently detected;
low-quality frames keep the track alive but cannot influence identity. Matches
at keep_threshold (< acquire_threshold) refresh an already-acquired identity,
giving the acquire/keep hysteresis that stops known<->unknown flapping.

No external dependencies beyond numpy. Uses greedy IoU association (sufficient
for the low track counts typical of a home camera feed).
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Callable

import numpy as np

if TYPE_CHECKING:
    from .recognizer import DetectedFace, Match

PENDING = "pending"
KNOWN = "known"
UNKNOWN = "unknown"


@dataclass(frozen=True)
class IdentityParams:
    acquire_threshold: float
    keep_threshold: float
    acquire_votes: int
    min_vote_face_px: int
    min_vote_det_score: float
    unknown_min_age_s: float
    unknown_min_votes: int
```

Keep `_iou` and `_greedy_match` exactly as they are. Replace the whole `FaceTrack` class with:

```python
class FaceTrack:
    """A single tracked face with a sticky-identity state machine."""

    def __init__(
        self,
        track_id: int,
        bbox: tuple,
        det_score: float,
        embedding,
        params: IdentityParams,
        created_ts: float,
    ):
        self.id = track_id
        self.bbox = bbox
        self.det_score = det_score
        self.hits = 1
        self.lost_count = 0
        self.current_embedding = embedding
        self.created_ts = created_ts
        self.state = PENDING
        self.identity: "Match | None" = None
        self.quality_votes = 0
        self._params = params
        self._acquire_counts: dict[str, int] = {}  # pending/unknown: pid -> votes
        self._switch_counts: dict[str, int] = {}   # known: other pid -> votes

    def _is_quality_frame(self) -> bool:
        face_h = self.bbox[3] - self.bbox[1]
        return (
            face_h >= self._params.min_vote_face_px
            and self.det_score >= self._params.min_vote_det_score
        )

    def push_vote(self, match: "Match | None") -> None:
        """Feed one recognition result. Ignored unless the current frame is quality."""
        if not self._is_quality_frame():
            return
        self.quality_votes += 1
        p = self._params

        if self.state == KNOWN:
            assert self.identity is not None
            if match is not None and match.person_id == self.identity.person_id:
                if match.similarity >= p.keep_threshold:
                    if match.similarity > self.identity.similarity:
                        self.identity = match
                    self._switch_counts.clear()
            elif match is not None and match.similarity >= p.acquire_threshold:
                n = self._switch_counts.get(match.person_id, 0) + 1
                self._switch_counts[match.person_id] = n
                if n >= p.acquire_votes:
                    self.identity = match
                    self._switch_counts.clear()
            # match is None or a weak other-person match: identity is sticky.
            return

        # PENDING or UNKNOWN: accumulate acquire-level evidence.
        if match is not None and match.similarity >= p.acquire_threshold:
            n = self._acquire_counts.get(match.person_id, 0) + 1
            self._acquire_counts[match.person_id] = n
            if n >= p.acquire_votes:
                self.state = KNOWN
                self.identity = match
                self._acquire_counts.clear()

    def resolve_unknown(self, now: float) -> None:
        """Promote pending -> unknown once the track has proven itself unmatched."""
        if self.state != PENDING:
            return
        p = self._params
        if (
            now - self.created_ts >= p.unknown_min_age_s
            and self.quality_votes >= p.unknown_min_votes
        ):
            self.state = UNKNOWN
```

Replace `FaceTracker.__init__` and the track-spawning part of `update` with:

```python
class FaceTracker:
    """Manages active face tracks across frames using greedy IoU association."""

    def __init__(
        self,
        min_iou: float,
        min_hits: int,
        max_lost: int,
        params: IdentityParams,
        now_fn: Callable[[], float] = time.monotonic,
    ):
        self._min_iou = min_iou
        self._min_hits = min_hits
        self._max_lost = max_lost
        self._params = params
        self._now = now_fn
        self._tracks: list[FaceTrack] = []
        self._next_id = 0

    def update(self, faces: list["DetectedFace"]) -> None:
        """Associate detections with existing tracks and advance all track states."""
        now = self._now()
        det_bboxes = [f.bbox for f in faces]
        track_bboxes = [t.bbox for t in self._tracks]

        matches, unmatched_dets, unmatched_tracks = _greedy_match(
            track_bboxes, det_bboxes, self._min_iou
        )

        # Update matched tracks
        for ti, di in matches:
            t = self._tracks[ti]
            t.bbox = faces[di].bbox
            t.det_score = faces[di].score
            t.current_embedding = faces[di].embedding
            t.hits += 1
            t.lost_count = 0

        # Age unmatched tracks
        for ti in unmatched_tracks:
            t = self._tracks[ti]
            t.lost_count += 1
            t.current_embedding = None

        # Spawn new tracks for unmatched detections
        for di in unmatched_dets:
            self._tracks.append(
                FaceTrack(
                    track_id=self._next_id,
                    bbox=faces[di].bbox,
                    det_score=faces[di].score,
                    embedding=faces[di].embedding,
                    params=self._params,
                    created_ts=now,
                )
            )
            self._next_id += 1

        # Remove dead tracks, then resolve pending -> unknown on survivors
        self._tracks = [t for t in self._tracks if t.lost_count <= self._max_lost]
        for t in self._tracks:
            t.resolve_unknown(now)

    def confirmed_tracks(self) -> list[FaceTrack]:
        """Return tracks that have been seen for at least min_hits consecutive frames."""
        return [t for t in self._tracks if t.hits >= self._min_hits]
```

(The old `deque` import, `push_vote` majority logic, and `voted_identity` are gone.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd face-service && .venv/bin/python -m pytest tests/test_tracker.py -v`
Expected: all 16 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add face-service/face_service/tracker.py face-service/tests/test_tracker.py
git commit -m "feat(face): sticky-identity tracker with quality gating and unknown-proof"
```

### Task 3: Worker wiring + testable detection builder

**Files:**
- Modify: `face-service/face_service/worker.py`
- Test: `face-service/tests/test_worker_detections.py` (create)

**Interfaces:**
- Consumes: `FaceTracker(..., params=IdentityParams(...))`, `track.state`, `track.identity`, `KNOWN` from Task 2; `Config` fields from Task 1.
- Produces: module-level `build_detections(tracker, index, frame_w: int, frame_h: int) -> list[dict]` in `worker.py` — pushes one vote per confirmed track with an embedding, then returns the JSON-ready detection dicts (existing keys plus `"state"`).

- [ ] **Step 1: Write the failing test**

Create `face-service/tests/test_worker_detections.py`:

```python
import numpy as np
from face_service.recognizer import DetectedFace, MatchIndex
from face_service.tracker import KNOWN, PENDING, FaceTracker, IdentityParams
from face_service.worker import build_detections

PARAMS = IdentityParams(
    acquire_threshold=0.45,
    keep_threshold=0.35,
    acquire_votes=3,
    min_vote_face_px=48,
    min_vote_det_score=0.6,
    unknown_min_age_s=3.0,
    unknown_min_votes=5,
)


def _unit(dim):
    v = np.zeros(512, dtype=np.float32)
    v[dim] = 1.0
    return v


def _face(emb):
    return DetectedFace(bbox=(100.0, 100.0, 200.0, 200.0), score=0.9, embedding=emb, landmarks=None)


def _setup():
    index = MatchIndex(threshold=0.35)
    index.rebuild([("pid_a", "Alice", _unit(0))])
    tracker = FaceTracker(min_iou=0.3, min_hits=1, max_lost=5, params=PARAMS, now_fn=lambda: 0.0)
    return tracker, index


def test_detection_payload_shape_and_normalized_bbox():
    tracker, index = _setup()
    tracker.update([_face(_unit(0))])
    dets = build_detections(tracker, index, frame_w=1000, frame_h=500)
    assert len(dets) == 1
    d = dets[0]
    assert d["bbox"] == [0.1, 0.2, 0.2, 0.4]
    assert d["score"] == 0.9
    assert d["state"] == PENDING
    assert d["person_id"] is None and d["name"] is None and d["similarity"] is None


def test_identity_appears_after_acquire_votes():
    tracker, index = _setup()
    face = _face(_unit(0))  # exact match: similarity 1.0
    dets = []
    for _ in range(3):
        tracker.update([face])
        dets = build_detections(tracker, index, 1000, 500)
    d = dets[0]
    assert d["state"] == KNOWN
    assert d["person_id"] == "pid_a"
    assert d["name"] == "Alice"
    assert d["similarity"] == 1.0


def test_identity_sticks_when_face_stops_matching():
    tracker, index = _setup()
    for _ in range(3):
        tracker.update([_face(_unit(0))])
        build_detections(tracker, index, 1000, 500)
    # Now the person turns away: orthogonal embedding, similarity 0.
    dets = []
    for _ in range(10):
        tracker.update([_face(_unit(7))])
        dets = build_detections(tracker, index, 1000, 500)
    d = dets[0]
    assert d["state"] == KNOWN
    assert d["person_id"] == "pid_a"  # no wiggle back to unknown


def test_lost_tracks_emit_nothing():
    tracker, index = _setup()
    tracker.update([_face(_unit(0))])
    tracker.update([])  # track lost this frame
    assert build_detections(tracker, index, 1000, 500) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd face-service && .venv/bin/python -m pytest tests/test_worker_detections.py -v`
Expected: collection error — `ImportError: cannot import name 'build_detections'`.

- [ ] **Step 3: Implement**

In `face-service/face_service/worker.py`:

1. Change the import line `from .tracker import FaceTracker` to:

```python
from .tracker import KNOWN, FaceTracker, IdentityParams
```

2. In `_run_async`, replace the `tracker = FaceTracker(...)` construction with:

```python
    tracker = FaceTracker(
        min_iou=config.track_min_iou,
        min_hits=config.track_min_hits,
        max_lost=config.track_max_lost,
        params=IdentityParams(
            acquire_threshold=config.acquire_threshold,
            keep_threshold=config.keep_threshold,
            acquire_votes=config.acquire_votes,
            min_vote_face_px=config.min_vote_face_px,
            min_vote_det_score=config.min_vote_det_score,
            unknown_min_age_s=config.unknown_min_age_s,
            unknown_min_votes=config.unknown_min_votes,
        ),
    )
```

3. In `_run_async`, change the index floor from the enrollment threshold to the keep threshold (hysteresis must see sub-0.42 similarities):

```python
    index_ref = [_load_index(str(config.db_path), config.keep_threshold)]
```

4. In `_process_frames`, the same change inside the hot-reload block:

```python
                index_ref[0] = _load_index(str(config.db_path), config.keep_threshold)
```

5. Add a module-level function (below `_load_index`), and replace the detection-building block inside `_process_frames` (from `detections = []` through the `detections.append({...})` loop) with a call to it:

```python
def build_detections(tracker, index, frame_w: int, frame_h: int) -> list[dict]:
    """Vote + serialize confirmed tracks for one processed frame."""
    detections: list[dict] = []
    for track in tracker.confirmed_tracks():
        if track.current_embedding is not None:
            track.push_vote(index.match(track.current_embedding))

        # Only emit detection for tracks visible in this frame (not lost)
        if track.lost_count > 0:
            continue

        ident = track.identity if track.state == KNOWN else None
        x1, y1, x2, y2 = track.bbox
        detections.append({
            "track_id": track.id,
            "bbox": [
                max(0.0, x1 / frame_w),
                max(0.0, y1 / frame_h),
                min(1.0, x2 / frame_w),
                min(1.0, y2 / frame_h),
            ],
            "score": round(track.det_score, 3),
            "state": track.state,
            "person_id": ident.person_id if ident else None,
            "name": ident.name if ident else None,
            "similarity": round(ident.similarity, 3) if ident else None,
        })
    return detections
```

In `_process_frames` the block becomes:

```python
        tracker.update(faces)
        detections = build_detections(tracker, index_ref[0], frame_w, frame_h)
```

(The old `index = index_ref[0]` line and the inline loop are removed.)

- [ ] **Step 4: Run the full face-service suite**

Run: `cd face-service && .venv/bin/python -m pytest tests -v`
Expected: all tests PASS (config, tracker, worker_detections, recognizer, augmentation).

- [ ] **Step 5: Commit**

```bash
git add face-service/face_service/worker.py face-service/tests/test_worker_detections.py
git commit -m "feat(face): wire sticky-identity tracker into worker, index floor at keep threshold"
```

### Task 4: Docs + end-to-end sanity

**Files:**
- Modify: `CLAUDE.md` (face-service env var line)

**Interfaces:** none (documentation + verification only).

- [ ] **Step 1: Update CLAUDE.md**

In the `## Face Service (Python)` section, replace the **Key env vars** paragraph with:

```markdown
**Key env vars:** `FACE_SERVICE_HOST`, `FACE_SERVICE_PORT` (default `8090`), `FACE_SERVICE_DATA_DIR`, `FACE_SERVICE_MODEL` (default `buffalo_l`), `FACE_SERVICE_MATCH_THRESHOLD` (default `0.42`, enrollment only), `FACE_SERVICE_ACQUIRE_THRESHOLD` (default `0.45`), `FACE_SERVICE_KEEP_THRESHOLD` (default `0.35`), `FACE_SERVICE_PROVIDERS` (comma-separated ORT providers), `FACE_SERVICE_RELAY_URL` (default `ws://127.0.0.1:8080`).
```

And in the face-service **Architecture** section, replace the `tracker.py` bullet with:

```markdown
- `tracker.py` — IoU-based SORT tracker with a sticky-identity state machine (`pending → known | unknown`). Quality gating (face ≥ `FACE_SERVICE_MIN_VOTE_FACE_PX` px tall, det score ≥ `FACE_SERVICE_MIN_VOTE_DET_SCORE`) decides which frames may vote; identities acquire at `FACE_SERVICE_ACQUIRE_THRESHOLD` and are kept at `FACE_SERVICE_KEEP_THRESHOLD` (hysteresis); "unknown" requires `FACE_SERVICE_UNKNOWN_MIN_AGE_S` seconds and `FACE_SERVICE_UNKNOWN_MIN_VOTES` quality votes. A known track never reverts to unknown.
```

- [ ] **Step 2: Byte-compile + full suite as regression gate**

Run: `cd face-service && .venv/bin/python -m py_compile face_service/worker.py face_service/tracker.py face_service/config.py && .venv/bin/python -m pytest tests -v`
Expected: no compile errors; all tests PASS.

- [ ] **Step 3: Manual sanity (requires webcam, optional but recommended)**

Run: `./face-service/.venv/bin/python tests/manual/webcam_recognize.py`
Expected: window opens; enrolled faces label correctly. (This script drives `MatchIndex` directly, not the tracker — it verifies the recognizer path still works.)

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document identity hysteresis env vars and tracker behavior"
```
