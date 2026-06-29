# Face Recognition Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve face recognition at 3–5 m distance on 1280×720 cameras via gallery matching, enrollment augmentation with dashboard config, and per-track majority-vote identity.

**Architecture:** Three independent layers applied in sequence — (A) `MatchIndex` stores individual embeddings and matches per-person max-similarity, (B) enrollment generates augmented variants via OpenCV transforms configurable through a dashboard panel, (C) an IoU SORT tracker accumulates per-frame match votes and emits stable majority-voted identities.

**Tech Stack:** Python 3.11, InsightFace `buffalo_l`, OpenCV (`cv2`), NumPy, aiohttp, SQLite (`sqlite3`), React + TanStack Query + Tailwind, Go (Gin) for proxy route.

## Global Constraints

- `buffalo_l` model pack stays — do not change the InsightFace model.
- No new pip dependencies for tracker (pure numpy/stdlib).
- Augmented embedding rows use `photo_path` values prefixed with `<augmented:` — this prefix is the sentinel used everywhere to distinguish real vs. synthetic rows.
- `photo_count` on Person must count only real photos (non-`<augmented:` rows).
- `list_photos` API response must omit augmented rows — they are internal.
- Tracker env vars: `FACE_SERVICE_TRACK_MAX_LOST=5`, `FACE_SERVICE_TRACK_MIN_HITS=3`, `FACE_SERVICE_TRACK_VOTE_WINDOW=10`, `FACE_SERVICE_TRACK_MIN_IOU=0.3`.
- det_size default: `1024`.
- Augmentation default config: flip=true, brightness 2 steps ±20%, contrast 2 steps ±20%, rotation 4 steps ±20°, pixel_quality 3 steps min_scale=0.4.
- Run tests from face-service root: `cd face-service && .venv/bin/python -m pytest tests/ -v`

---

## Task 1: Layer A — Gallery Matching + det_size

**Files:**
- Modify: `face-service/face_service/config.py` (line 72 — `det_size` default)
- Modify: `face-service/face_service/recognizer.py` (lines 145–202 — `MatchIndex`)
- Create: `face-service/tests/__init__.py`
- Create: `face-service/tests/test_recognizer.py`

**Interfaces:**
- Produces: `MatchIndex.rebuild(embeddings: list[tuple[str, str, np.ndarray]]) -> None` (unchanged signature)
- Produces: `MatchIndex.match(embedding: np.ndarray) -> Match | None` (unchanged signature)
- Produces: `MatchIndex.size -> int` (now returns unique person count, not row count)

- [ ] **Step 1: Create tests directory and write failing tests**

```python
# face-service/tests/__init__.py
# (empty)
```

```python
# face-service/tests/test_recognizer.py
import numpy as np
import pytest
from face_service.recognizer import MatchIndex, Match


def _e(dim: int) -> np.ndarray:
    """Unit vector with 1.0 at dimension `dim`, rest zeros. L2-norm = 1."""
    v = np.zeros(512, dtype=np.float32)
    v[dim] = 1.0
    return v


def test_gallery_match_beats_mean_prototype():
    """Key invariant: gallery matching finds the best individual embedding.
    With mean prototype, enrolling e[0] and e[1] gives prototype at 45° (sim=0.707).
    Gallery matching returns sim=1.0 because it picks the closest individual row."""
    idx = MatchIndex(threshold=0.5)
    idx.rebuild([
        ("pid_a", "Alice", _e(0)),
        ("pid_a", "Alice", _e(1)),
    ])
    result = idx.match(_e(0))
    assert result is not None
    assert result.person_id == "pid_a"
    assert result.name == "Alice"
    assert result.similarity == pytest.approx(1.0, abs=0.01)


def test_gallery_picks_correct_person_over_two():
    idx = MatchIndex(threshold=0.5)
    idx.rebuild([
        ("pid_a", "Alice", _e(0)),
        ("pid_b", "Bob", _e(1)),
    ])
    result = idx.match(_e(0))
    assert result is not None
    assert result.person_id == "pid_a"


def test_gallery_returns_none_below_threshold():
    idx = MatchIndex(threshold=0.9)
    idx.rebuild([("pid_a", "Alice", _e(0))])
    # Query orthogonal to enrolled → sim = 0.0
    assert idx.match(_e(1)) is None


def test_gallery_empty_returns_none():
    idx = MatchIndex(threshold=0.5)
    idx.rebuild([])
    assert idx.match(_e(0)) is None


def test_size_returns_unique_person_count():
    idx = MatchIndex(threshold=0.5)
    idx.rebuild([
        ("pid_a", "Alice", _e(0)),
        ("pid_a", "Alice", _e(1)),  # second embedding for same person
        ("pid_b", "Bob", _e(2)),
    ])
    assert idx.size == 2  # 2 unique persons, not 3 rows
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd face-service && .venv/bin/python -m pytest tests/test_recognizer.py -v
```

Expected: FAIL — `AssertionError` on `test_gallery_beats_mean_prototype` (current code returns 0.707 not 1.0) and `test_size_returns_unique_person_count` (current `size` returns row count).

- [ ] **Step 3: Replace MatchIndex in recognizer.py**

Replace the entire `MatchIndex` class (lines 145–202) with:

```python
class MatchIndex:
    """In-memory cosine gallery matcher.

    Stores every individual embedding as a row (rather than a mean prototype),
    groups rows by person_id at match time, and returns the person whose best
    individual embedding is closest to the query. This means any one good photo
    out of many augmented variants is sufficient for a match.
    """

    def __init__(self, threshold: float):
        self._threshold = threshold
        self._row_pids: list[str] = []          # person_id per matrix row
        self._pid_names: dict[str, str] = {}     # person_id -> display name
        self._matrix: np.ndarray | None = None   # shape (N_rows, 512), L2-norm

    def rebuild(self, embeddings: list[tuple[str, str, np.ndarray]]) -> None:
        """embeddings: iterable of (person_id, name, embedding)."""
        rows: list[np.ndarray] = []
        row_pids: list[str] = []
        pid_names: dict[str, str] = {}

        for pid, name, emb in embeddings:
            pid_names[pid] = name
            n = np.linalg.norm(emb)
            if n == 0:
                continue
            rows.append((emb / n).astype(np.float32))
            row_pids.append(pid)

        if not rows:
            self._row_pids = []
            self._pid_names = {}
            self._matrix = None
            return

        self._row_pids = row_pids
        self._pid_names = pid_names
        self._matrix = np.stack(rows, axis=0)

    def match(self, embedding: np.ndarray) -> Match | None:
        if self._matrix is None or embedding is None:
            return None
        sims = self._matrix @ embedding.astype(np.float32)

        # Take max similarity per person across all their enrolled embeddings.
        best_sim_by_pid: dict[str, float] = {}
        for i, pid in enumerate(self._row_pids):
            s = float(sims[i])
            if s > best_sim_by_pid.get(pid, -1.0):
                best_sim_by_pid[pid] = s

        best_pid = max(best_sim_by_pid, key=best_sim_by_pid.__getitem__)
        best_sim = best_sim_by_pid[best_pid]

        if best_sim < self._threshold:
            return None
        return Match(
            person_id=best_pid,
            name=self._pid_names[best_pid],
            similarity=best_sim,
        )

    @property
    def size(self) -> int:
        return len(self._pid_names)  # unique persons enrolled
```

- [ ] **Step 4: Bump det_size default in config.py**

In `face-service/face_service/config.py`, change line 72:
```python
# Before:
det_size=_env_int("FACE_SERVICE_DET_SIZE", 640),
# After:
det_size=_env_int("FACE_SERVICE_DET_SIZE", 1024),
```

- [ ] **Step 5: Run tests — expect pass**

```bash
cd face-service && .venv/bin/python -m pytest tests/test_recognizer.py -v
```

Expected: 5 PASSED.

- [ ] **Step 6: Commit**

```bash
git add face-service/face_service/config.py face-service/face_service/recognizer.py \
        face-service/tests/__init__.py face-service/tests/test_recognizer.py
git commit -m "feat(face): gallery matching + det_size=1024 (Layer A)"
```

---

## Task 2: Layer B Core — Augmentation Engine

**Files:**
- Create: `face-service/face_service/augmentation.py`
- Create: `face-service/tests/test_augmentation.py`

**Interfaces:**
- Produces: `AugConfig` dataclass — fields listed below; `AugConfig.from_dict(d: dict) -> AugConfig`; `AugConfig.to_dict() -> dict`; `AugConfig.default() -> AugConfig`
- Produces: `augment_and_embed(bgr: np.ndarray, recognizer: Recognizer, config: AugConfig) -> list[tuple[np.ndarray, str]]`
  — returns list of `(L2-normalized 512-d embedding, label_string)`; label format: `<augmented:flip>`, `<augmented:brightness:-20>`, `<augmented:contrast:+20>`, `<augmented:rotation:-10>`, `<augmented:pixel_quality:0.40>`

- [ ] **Step 1: Write failing tests**

```python
# face-service/tests/test_augmentation.py
from unittest.mock import MagicMock
import numpy as np
import pytest

from face_service.augmentation import AugConfig, augment_and_embed
from face_service.recognizer import DetectedFace


def _make_recognizer(embedding: np.ndarray | None = None):
    """Mock recognizer that returns a single face with the given embedding."""
    rec = MagicMock()
    if embedding is None:
        rec.detect.return_value = []
    else:
        emb = embedding.copy()
        face = DetectedFace(bbox=(10.0, 10.0, 90.0, 90.0), score=0.99, embedding=emb, landmarks=None)
        rec.detect.return_value = [face]
    return rec


def _unit_emb(dim: int = 0) -> np.ndarray:
    v = np.zeros(512, dtype=np.float32)
    v[dim] = 1.0
    return v


def test_flip_generates_one_embedding():
    cfg = AugConfig(
        flip_enabled=True,
        brightness_enabled=False,
        contrast_enabled=False,
        rotation_enabled=False,
        pixel_quality_enabled=False,
    )
    rec = _make_recognizer(_unit_emb())
    bgr = np.zeros((100, 100, 3), dtype=np.uint8)
    results = augment_and_embed(bgr, rec, cfg)
    assert len(results) == 1
    label = results[0][1]
    assert label == "<augmented:flip>"
    np.testing.assert_array_almost_equal(results[0][0], _unit_emb())


def test_brightness_generates_steps_embeddings():
    cfg = AugConfig(
        flip_enabled=False,
        brightness_enabled=True,
        brightness_steps=2,
        brightness_magnitude_pct=20.0,
        contrast_enabled=False,
        rotation_enabled=False,
        pixel_quality_enabled=False,
    )
    rec = _make_recognizer(_unit_emb())
    bgr = np.zeros((100, 100, 3), dtype=np.uint8)
    results = augment_and_embed(bgr, rec, cfg)
    assert len(results) == 2
    labels = [r[1] for r in results]
    assert all(l.startswith("<augmented:brightness:") for l in labels)


def test_rotation_skips_when_detect_returns_empty():
    cfg = AugConfig(
        flip_enabled=False,
        brightness_enabled=False,
        contrast_enabled=False,
        rotation_enabled=True,
        rotation_steps=2,
        rotation_max_angle_deg=20.0,
        pixel_quality_enabled=False,
    )
    rec = _make_recognizer(None)  # detect returns []
    bgr = np.zeros((100, 100, 3), dtype=np.uint8)
    results = augment_and_embed(bgr, rec, cfg)
    assert results == []


def test_pixel_quality_generates_steps_embeddings():
    cfg = AugConfig(
        flip_enabled=False,
        brightness_enabled=False,
        contrast_enabled=False,
        rotation_enabled=False,
        pixel_quality_enabled=True,
        pixel_quality_steps=3,
        pixel_quality_min_scale=0.4,
    )
    rec = _make_recognizer(_unit_emb())
    bgr = np.zeros((100, 100, 3), dtype=np.uint8)
    results = augment_and_embed(bgr, rec, cfg)
    assert len(results) == 3
    labels = [r[1] for r in results]
    assert all(l.startswith("<augmented:pixel_quality:") for l in labels)


def test_aug_config_roundtrip():
    cfg = AugConfig.default()
    d = cfg.to_dict()
    cfg2 = AugConfig.from_dict(d)
    assert cfg == cfg2


def test_all_disabled_returns_empty():
    cfg = AugConfig(
        flip_enabled=False,
        brightness_enabled=False,
        contrast_enabled=False,
        rotation_enabled=False,
        pixel_quality_enabled=False,
    )
    rec = _make_recognizer(_unit_emb())
    bgr = np.zeros((100, 100, 3), dtype=np.uint8)
    assert augment_and_embed(bgr, rec, cfg) == []
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd face-service && .venv/bin/python -m pytest tests/test_augmentation.py -v
```

Expected: FAIL — `ModuleNotFoundError: face_service.augmentation`.

- [ ] **Step 3: Create augmentation.py**

```python
# face-service/face_service/augmentation.py
"""Enrollment augmentation: generate embedding variants from a single image.

Each augmentation type applies an OpenCV transform, re-runs face detection,
and returns the embedding if InsightFace found a face. Failed detections are
silently skipped — some extreme rotations may lose the face.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import cv2
import numpy as np

if TYPE_CHECKING:
    from .recognizer import Recognizer


@dataclass
class AugConfig:
    flip_enabled: bool = True

    brightness_enabled: bool = True
    brightness_steps: int = 2
    brightness_magnitude_pct: float = 20.0

    contrast_enabled: bool = True
    contrast_steps: int = 2
    contrast_magnitude_pct: float = 20.0

    rotation_enabled: bool = True
    rotation_steps: int = 4
    rotation_max_angle_deg: float = 20.0

    pixel_quality_enabled: bool = True
    pixel_quality_steps: int = 3
    pixel_quality_min_scale: float = 0.4

    @staticmethod
    def default() -> "AugConfig":
        return AugConfig()

    def to_dict(self) -> dict:
        return {
            "flip_enabled": self.flip_enabled,
            "brightness_enabled": self.brightness_enabled,
            "brightness_steps": self.brightness_steps,
            "brightness_magnitude_pct": self.brightness_magnitude_pct,
            "contrast_enabled": self.contrast_enabled,
            "contrast_steps": self.contrast_steps,
            "contrast_magnitude_pct": self.contrast_magnitude_pct,
            "rotation_enabled": self.rotation_enabled,
            "rotation_steps": self.rotation_steps,
            "rotation_max_angle_deg": self.rotation_max_angle_deg,
            "pixel_quality_enabled": self.pixel_quality_enabled,
            "pixel_quality_steps": self.pixel_quality_steps,
            "pixel_quality_min_scale": self.pixel_quality_min_scale,
        }

    @staticmethod
    def from_dict(d: dict) -> "AugConfig":
        cfg = AugConfig()
        for f_name in cfg.to_dict():
            if f_name in d:
                setattr(cfg, f_name, d[f_name])
        return cfg


def _embed_or_none(bgr: np.ndarray, recognizer: "Recognizer") -> np.ndarray | None:
    """Run detect on bgr, return embedding of largest face or None."""
    from .recognizer import DetectedFace
    faces = recognizer.detect(bgr)
    if not faces:
        return None
    best = max(
        faces,
        key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
    )
    return best.embedding


def augment_and_embed(
    bgr: np.ndarray,
    recognizer: "Recognizer",
    config: AugConfig,
) -> list[tuple[np.ndarray, str]]:
    """Apply configured augmentations to bgr, return (embedding, label) pairs.

    Only augmentation variants where InsightFace detects a face are included.
    The original image is NOT included — caller handles the real embedding separately.
    """
    results: list[tuple[np.ndarray, str]] = []

    # Horizontal flip
    if config.flip_enabled:
        aug = cv2.flip(bgr, 1)
        emb = _embed_or_none(aug, recognizer)
        if emb is not None:
            results.append((emb, "<augmented:flip>"))

    # Brightness: `steps` linearly spaced deltas from -magnitude to +magnitude
    if config.brightness_enabled and config.brightness_steps > 0:
        for delta in np.linspace(
            -config.brightness_magnitude_pct,
            config.brightness_magnitude_pct,
            config.brightness_steps,
        ):
            if abs(delta) < 1e-3:
                continue
            factor = 1.0 + delta / 100.0
            aug = np.clip(bgr.astype(np.float32) * factor, 0, 255).astype(np.uint8)
            emb = _embed_or_none(aug, recognizer)
            if emb is not None:
                results.append((emb, f"<augmented:brightness:{delta:+.0f}>"))

    # Contrast: scale deviation from mean pixel value
    if config.contrast_enabled and config.contrast_steps > 0:
        mean_val = float(bgr.mean())
        for delta in np.linspace(
            -config.contrast_magnitude_pct,
            config.contrast_magnitude_pct,
            config.contrast_steps,
        ):
            if abs(delta) < 1e-3:
                continue
            factor = 1.0 + delta / 100.0
            aug = np.clip(
                mean_val + (bgr.astype(np.float32) - mean_val) * factor, 0, 255
            ).astype(np.uint8)
            emb = _embed_or_none(aug, recognizer)
            if emb is not None:
                results.append((emb, f"<augmented:contrast:{delta:+.0f}>"))

    # Rotation: angles from -max_angle to +max_angle
    if config.rotation_enabled and config.rotation_steps > 0:
        h, w = bgr.shape[:2]
        cx, cy = w / 2.0, h / 2.0
        for angle in np.linspace(
            -config.rotation_max_angle_deg,
            config.rotation_max_angle_deg,
            config.rotation_steps,
        ):
            if abs(angle) < 1e-3:
                continue
            M = cv2.getRotationMatrix2D((cx, cy), float(angle), 1.0)
            aug = cv2.warpAffine(
                bgr, M, (w, h),
                flags=cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_REPLICATE,
            )
            emb = _embed_or_none(aug, recognizer)
            if emb is not None:
                results.append((emb, f"<augmented:rotation:{angle:+.0f}>"))

    # Pixel quality: downsample + upsample to simulate distance
    # scales go from min_scale to just below 1.0 (steps intervals, excluding 1.0)
    if config.pixel_quality_enabled and config.pixel_quality_steps > 0:
        h, w = bgr.shape[:2]
        scales = np.linspace(
            config.pixel_quality_min_scale, 1.0, config.pixel_quality_steps + 1
        )[:-1]  # exclude 1.0 (original resolution)
        for scale in scales:
            sw = max(1, int(w * scale))
            sh = max(1, int(h * scale))
            small = cv2.resize(bgr, (sw, sh), interpolation=cv2.INTER_AREA)
            aug = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
            emb = _embed_or_none(aug, recognizer)
            if emb is not None:
                results.append((emb, f"<augmented:pixel_quality:{scale:.2f}>"))

    return results
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd face-service && .venv/bin/python -m pytest tests/test_augmentation.py -v
```

Expected: 6 PASSED.

- [ ] **Step 5: Commit**

```bash
git add face-service/face_service/augmentation.py face-service/tests/test_augmentation.py
git commit -m "feat(face): enrollment augmentation engine (Layer B)"
```

---

## Task 3: Layer B Integration — Config Storage, Persons, API + Go Proxy Route

**Files:**
- Modify: `face-service/face_service/db.py` (add `settings` table + 3 methods + fix photo_count/list_photos)
- Modify: `face-service/face_service/persons.py` (augmentation in add_photo_bytes, regenerate, delete cleanup)
- Modify: `face-service/face_service/server.py` (expose CTX_DB, 3 new routes)
- Modify: `backend/main.go` (proxy `/api/augmentation/*` to face-service)
- Create: `face-service/tests/test_augmentation_integration.py`

**Interfaces:**
- Consumes: `AugConfig`, `augment_and_embed` from `face_service.augmentation` (Task 2)
- Produces: `Database.get_setting(key: str) -> str | None`
- Produces: `Database.set_setting(key: str, value: str) -> None`
- Produces: `Database.delete_augmented_photos(person_id: str | None = None) -> int`
- Produces: `PersonStore.regenerate_augmented() -> int` (returns total augmented embeddings created)
- Produces REST API: `GET /augmentation/config`, `PUT /augmentation/config`, `POST /augmentation/regenerate`

- [ ] **Step 1: Write failing tests**

```python
# face-service/tests/test_augmentation_integration.py
import json
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch
import numpy as np
import pytest

from face_service.db import Database
from face_service.augmentation import AugConfig


@pytest.fixture
def tmp_db(tmp_path):
    return Database(tmp_path / "face.db")


def test_settings_roundtrip(tmp_db):
    assert tmp_db.get_setting("augmentation_config") is None
    tmp_db.set_setting("augmentation_config", '{"flip_enabled": false}')
    val = tmp_db.get_setting("augmentation_config")
    assert val is not None
    assert json.loads(val)["flip_enabled"] is False


def test_delete_augmented_photos_removes_only_augmented(tmp_db):
    pid = tmp_db.create_person("Alice").id
    real_emb = np.zeros(512, dtype=np.float32); real_emb[0] = 1.0
    tmp_db.add_photo(pid, "real/photo.jpg", real_emb)
    tmp_db.add_photo(pid, "<augmented:flip>", real_emb)
    tmp_db.add_photo(pid, "<augmented:brightness:+20>", real_emb)

    deleted = tmp_db.delete_augmented_photos(pid)
    assert deleted == 2

    photos = tmp_db.list_photos(pid)
    assert len(photos) == 1
    assert photos[0].photo_path == "real/photo.jpg"


def test_delete_augmented_photos_all_persons(tmp_db):
    pid_a = tmp_db.create_person("Alice").id
    pid_b = tmp_db.create_person("Bob").id
    emb = np.zeros(512, dtype=np.float32); emb[0] = 1.0
    tmp_db.add_photo(pid_a, "<augmented:flip>", emb)
    tmp_db.add_photo(pid_b, "<augmented:flip>", emb)

    deleted = tmp_db.delete_augmented_photos()
    assert deleted == 2


def test_photo_count_excludes_augmented(tmp_db):
    pid = tmp_db.create_person("Alice").id
    emb = np.zeros(512, dtype=np.float32); emb[0] = 1.0
    tmp_db.add_photo(pid, "photo.jpg", emb)
    tmp_db.add_photo(pid, "<augmented:flip>", emb)

    person = tmp_db.get_person(pid)
    assert person is not None
    assert person.photo_count == 1  # only real photo


def test_list_photos_excludes_augmented(tmp_db):
    pid = tmp_db.create_person("Alice").id
    emb = np.zeros(512, dtype=np.float32); emb[0] = 1.0
    tmp_db.add_photo(pid, "real.jpg", emb)
    tmp_db.add_photo(pid, "<augmented:flip>", emb)

    photos = tmp_db.list_photos(pid)
    assert len(photos) == 1
    assert photos[0].photo_path == "real.jpg"
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd face-service && .venv/bin/python -m pytest tests/test_augmentation_integration.py -v
```

Expected: FAIL — missing `get_setting`, `set_setting`, `delete_augmented_photos`; `photo_count` and `list_photos` include augmented rows.

- [ ] **Step 3: Update db.py — add settings table + 3 methods + fix photo_count/list_photos**

Add `CREATE TABLE IF NOT EXISTS settings` to the existing `SCHEMA` string. Find `SCHEMA = """` and append before the closing `"""`:

```python
SCHEMA = """
CREATE TABLE IF NOT EXISTS persons (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS face_photos (
    id          TEXT PRIMARY KEY,
    person_id   TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    photo_path  TEXT NOT NULL,
    embedding   BLOB NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_person ON face_photos(person_id);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""
```

Add these three methods to the `Database` class after `all_embeddings`:

```python
    # ---- settings ---------------------------------------------------------

    def get_setting(self, key: str) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM settings WHERE key = ?", (key,)
            ).fetchone()
        return row[0] if row else None

    def set_setting(self, key: str, value: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (key, value),
            )
            self._conn.commit()

    def delete_augmented_photos(self, person_id: str | None = None) -> int:
        """Delete augmented embedding rows (photo_path starts with '<augmented:').
        Pass person_id to limit to one person, or None to clear all persons."""
        with self._lock:
            if person_id is not None:
                cur = self._conn.execute(
                    "DELETE FROM face_photos WHERE person_id = ? AND photo_path LIKE '<augmented:%'",
                    (person_id,),
                )
            else:
                cur = self._conn.execute(
                    "DELETE FROM face_photos WHERE photo_path LIKE '<augmented:%'"
                )
            self._conn.commit()
            return cur.rowcount
```

Fix `get_person` and `list_persons` to exclude augmented rows from `photo_count`:

In `get_person`, change the COUNT subquery:
```python
# Before:
(SELECT COUNT(*) FROM face_photos f WHERE f.person_id = p.id)
# After (in get_person):
(SELECT COUNT(*) FROM face_photos f WHERE f.person_id = p.id AND f.photo_path NOT LIKE '<augmented:%')
```

In `list_persons`, same change to the COUNT subquery.

Fix `list_photos` to exclude augmented rows:
```python
def list_photos(self, person_id: str) -> list[FacePhoto]:
    with self._lock:
        rows = self._conn.execute(
            """
            SELECT id, person_id, photo_path, embedding, created_at
            FROM face_photos
            WHERE person_id = ? AND photo_path NOT LIKE '<augmented:%'
            ORDER BY created_at
            """,
            (person_id,),
        ).fetchall()
    return [
        FacePhoto(
            id=r[0], person_id=r[1], photo_path=r[2],
            embedding=_blob_to_emb(r[3]), created_at=r[4],
        )
        for r in rows
    ]
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd face-service && .venv/bin/python -m pytest tests/test_augmentation_integration.py -v
```

Expected: 5 PASSED.

- [ ] **Step 5: Update persons.py — augmentation in add_photo_bytes, regenerate, delete cleanup**

Add import at the top of `persons.py`:
```python
import json
from .augmentation import AugConfig, augment_and_embed
```

Add `_get_aug_config` method to `PersonStore`:
```python
    def _get_aug_config(self) -> AugConfig:
        val = self._db.get_setting("augmentation_config")
        if val is None:
            return AugConfig.default()
        try:
            return AugConfig.from_dict(json.loads(val))
        except Exception:
            return AugConfig.default()
```

Add `_add_augmented_for_image` private helper to `PersonStore`:
```python
    def _add_augmented_for_image(
        self, person_id: str, bgr: np.ndarray, aug_config: AugConfig
    ) -> int:
        """Generate and persist augmented embeddings. Returns count added."""
        count = 0
        for emb, label in augment_and_embed(bgr, self._rec, aug_config):
            self._db.add_photo(person_id, label, emb)
            count += 1
        return count
```

Modify `add_photo_bytes` to call augmentation (add after the `photo = self._db.add_photo(...)` line, before `self._rebuild_index()`):
```python
    def add_photo_bytes(
        self, person_id: str, raw: bytes, original_filename: str | None = None
    ) -> FacePhoto:
        """Decode bytes, extract embedding, persist file + row, rebuild index."""
        if self._db.get_person(person_id) is None:
            raise EnrollmentError("person not found")

        img = self._decode_image(raw)
        if img is None:
            raise EnrollmentError("could not decode image — expected JPEG, PNG, or WebP")

        embedding = self._rec.embed_only(img)
        if embedding is None:
            raise EnrollmentError("no face detected in the photo")

        ext = self._extension_for(original_filename)
        photo_id = uuid.uuid4().hex
        rel_dir = Path(person_id)
        rel_path = rel_dir / f"{photo_id}{ext}"
        abs_path = self._photos_dir / rel_path
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        with open(abs_path, "wb") as f:
            f.write(raw)

        with self._lock:
            photo = self._db.add_photo(person_id, str(rel_path), embedding)
            aug_config = self._get_aug_config()
            self._add_augmented_for_image(person_id, img, aug_config)
            self._rebuild_index()
        return photo
```

Modify `delete_photo` to clean up augmented embeddings and regenerate from remaining real photos:
```python
    def delete_photo(self, photo_id: str) -> bool:
        with self._lock:
            # Find what person this photo belongs to before deleting
            photos_before = {
                p.id: p for person in self._db.list_persons()
                for p in self._db.list_photos(person.id)
            }
            target = next((p for p in photos_before.values() if p.id == photo_id), None)
            if target is None:
                rel = self._db.delete_photo(photo_id)
                if rel is None:
                    return False
                self._safe_unlink(rel)
                self._rebuild_index()
                return True

            person_id = target.person_id
            rel = self._db.delete_photo(photo_id)
            if rel is None:
                return False
            self._safe_unlink(rel)

            # Rebuild augmented embeddings from remaining real photos
            self._db.delete_augmented_photos(person_id)
            aug_config = self._get_aug_config()
            for photo in self._db.list_photos(person_id):
                abs_path = self._photos_dir / photo.photo_path
                bgr = self._decode_image_from_path(abs_path)
                if bgr is not None:
                    self._add_augmented_for_image(person_id, bgr, aug_config)

            self._rebuild_index()
            return True
```

Add `_decode_image_from_path` helper and `regenerate_augmented` public method:
```python
    @staticmethod
    def _decode_image_from_path(path: Path) -> np.ndarray | None:
        if not path.is_file():
            return None
        arr = np.fromfile(str(path), dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return img if img is not None and img.size > 0 else None

    def regenerate_augmented(self) -> int:
        """Re-generate all augmented embeddings for every person using current config.

        Deletes existing augmented rows, then re-processes every real photo
        through the current augmentation config. Returns total embeddings added.
        """
        aug_config = self._get_aug_config()
        with self._lock:
            self._db.delete_augmented_photos()
            total = 0
            for person in self._db.list_persons():
                for photo in self._db.list_photos(person.id):
                    abs_path = self._photos_dir / photo.photo_path
                    bgr = self._decode_image_from_path(abs_path)
                    if bgr is not None:
                        total += self._add_augmented_for_image(person.id, bgr, aug_config)
            self._rebuild_index()
        return total
```

- [ ] **Step 6: Add augmentation endpoints to server.py**

Add `CTX_DB` app key near the top of server.py (after the existing `CTX_*` keys):
```python
CTX_DB = web.AppKey("db", Database)
```

Add three handler functions before the `make_app` function:
```python
# ---- augmentation config --------------------------------------------------

async def aug_config_get(request: web.Request) -> web.Response:
    db = request.app[CTX_DB]
    val = db.get_setting("augmentation_config")
    if val is None:
        from .augmentation import AugConfig
        return _json(AugConfig.default().to_dict())
    import json as _json_mod
    return _json(_json_mod.loads(val))


async def aug_config_put(request: web.Request) -> web.Response:
    db = request.app[CTX_DB]
    body = await _read_json(request)
    if isinstance(body, web.Response):
        return body
    from .augmentation import AugConfig
    import json as _json_mod
    try:
        cfg = AugConfig.from_dict(body)
    except Exception as exc:
        return _err(f"invalid config: {exc}")
    db.set_setting("augmentation_config", _json_mod.dumps(cfg.to_dict()))
    return _json(cfg.to_dict())


async def aug_regenerate(request: web.Request) -> web.Response:
    store = request.app[CTX_PERSONS]
    sup = request.app[CTX_SUPERVISOR]
    total = store.regenerate_augmented()
    sup.bump_index_version()
    return _json({"augmented_embeddings_created": total})
```

In `make_app`, expose `db` on the app (after `app[CTX_CONFIG] = config`):
```python
    app[CTX_DB] = db
```

Add three routes inside `app.add_routes([...])`:
```python
        web.get("/augmentation/config", aug_config_get),
        web.put("/augmentation/config", aug_config_put),
        web.post("/augmentation/regenerate", aug_regenerate),
```

- [ ] **Step 7: Add proxy route in backend/main.go**

In `main.go`, find the block that registers persons proxy routes:
```go
authed.Any("/persons", faceProxy.Handler())
authed.Any("/persons/*proxyPath", faceProxy.Handler())
```

Add immediately after:
```go
authed.Any("/augmentation", faceProxy.Handler())
authed.Any("/augmentation/*proxyPath", faceProxy.Handler())
```

- [ ] **Step 8: Run all tests**

```bash
cd face-service && .venv/bin/python -m pytest tests/ -v
```

Expected: all existing tests + integration tests PASS.

- [ ] **Step 9: Commit**

```bash
git add face-service/face_service/db.py \
        face-service/face_service/persons.py \
        face-service/face_service/server.py \
        face-service/tests/test_augmentation_integration.py \
        backend/main.go
git commit -m "feat(face): augmentation config storage, API endpoints, enrollment integration (Layer B)"
```

---

## Task 4: Layer C Core — Face Tracker

**Files:**
- Create: `face-service/face_service/tracker.py`
- Create: `face-service/tests/test_tracker.py`

**Interfaces:**
- Consumes: `DetectedFace` from `face_service.recognizer` (Task 1)
- Consumes: `Match` from `face_service.recognizer` (Task 1)
- Produces: `class FaceTrack` with fields:
  - `id: int`
  - `bbox: tuple[float, float, float, float]`
  - `hits: int`
  - `lost_count: int`
  - `det_score: float`
  - `current_embedding: np.ndarray | None`
  - method `push_vote(result: Match | None) -> None`
  - method `voted_identity() -> Match | None` (majority >50% wins)
- Produces: `class FaceTracker` with:
  - `__init__(min_iou, min_hits, max_lost, vote_window)`
  - `update(faces: list[DetectedFace]) -> None`
  - `confirmed_tracks() -> list[FaceTrack]`

- [ ] **Step 1: Write failing tests**

```python
# face-service/tests/test_tracker.py
import numpy as np
import pytest
from face_service.tracker import FaceTracker
from face_service.recognizer import DetectedFace, Match


def _face(x1, y1, x2, y2, score=0.99, emb_dim=0):
    emb = np.zeros(512, dtype=np.float32)
    emb[emb_dim] = 1.0
    return DetectedFace(bbox=(x1, y1, x2, y2), score=score, embedding=emb, landmarks=None)


def _match(pid="pid_a", name="Alice", sim=0.9):
    return Match(person_id=pid, name=name, similarity=sim)


def test_new_track_is_tentative():
    tracker = FaceTracker(min_iou=0.3, min_hits=3, max_lost=5, vote_window=10)
    tracker.update([_face(10, 10, 90, 90)])
    # hits=1, need min_hits=3 to confirm
    assert tracker.confirmed_tracks() == []


def test_track_confirmed_after_min_hits():
    tracker = FaceTracker(min_iou=0.3, min_hits=3, max_lost=5, vote_window=10)
    face = _face(10, 10, 90, 90)
    tracker.update([face])
    tracker.update([face])
    tracker.update([face])
    confirmed = tracker.confirmed_tracks()
    assert len(confirmed) == 1
    assert confirmed[0].hits == 3


def test_track_dies_after_max_lost():
    tracker = FaceTracker(min_iou=0.3, min_hits=3, max_lost=2, vote_window=10)
    face = _face(10, 10, 90, 90)
    # Confirm the track
    for _ in range(3):
        tracker.update([face])
    assert len(tracker.confirmed_tracks()) == 1

    # Miss 3 frames — should die after max_lost=2
    for _ in range(3):
        tracker.update([])
    assert tracker.confirmed_tracks() == []


def test_same_face_stays_one_track():
    tracker = FaceTracker(min_iou=0.3, min_hits=3, max_lost=5, vote_window=10)
    face = _face(10, 10, 90, 90)
    for _ in range(5):
        tracker.update([face])
    confirmed = tracker.confirmed_tracks()
    assert len(confirmed) == 1
    assert confirmed[0].hits == 5


def test_majority_vote_returns_winner():
    tracker = FaceTracker(min_iou=0.3, min_hits=1, max_lost=5, vote_window=5)
    face = _face(10, 10, 90, 90)
    tracker.update([face])
    track = tracker.confirmed_tracks()[0]

    # 4 Alice votes, 1 None
    track.push_vote(_match("pid_a", "Alice", 0.9))
    track.push_vote(_match("pid_a", "Alice", 0.9))
    track.push_vote(_match("pid_a", "Alice", 0.9))
    track.push_vote(_match("pid_a", "Alice", 0.9))
    track.push_vote(None)

    result = track.voted_identity()
    assert result is not None
    assert result.person_id == "pid_a"
    assert result.name == "Alice"


def test_majority_vote_returns_none_when_tie():
    tracker = FaceTracker(min_iou=0.3, min_hits=1, max_lost=5, vote_window=4)
    face = _face(10, 10, 90, 90)
    tracker.update([face])
    track = tracker.confirmed_tracks()[0]

    # 2 Alice, 2 None — no majority
    track.push_vote(_match("pid_a", "Alice", 0.9))
    track.push_vote(_match("pid_a", "Alice", 0.9))
    track.push_vote(None)
    track.push_vote(None)

    assert track.voted_identity() is None


def test_current_embedding_updated_on_match():
    tracker = FaceTracker(min_iou=0.3, min_hits=1, max_lost=5, vote_window=10)
    face = _face(10, 10, 90, 90, emb_dim=3)
    tracker.update([face])
    track = tracker.confirmed_tracks()[0]
    assert track.current_embedding is not None
    assert track.current_embedding[3] == pytest.approx(1.0)


def test_current_embedding_none_when_lost():
    tracker = FaceTracker(min_iou=0.3, min_hits=1, max_lost=5, vote_window=10)
    face = _face(10, 10, 90, 90)
    tracker.update([face])
    tracker.update([])  # miss one frame — track is lost but alive
    confirmed = tracker.confirmed_tracks()
    assert len(confirmed) == 1
    assert confirmed[0].current_embedding is None
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd face-service && .venv/bin/python -m pytest tests/test_tracker.py -v
```

Expected: FAIL — `ModuleNotFoundError: face_service.tracker`.

- [ ] **Step 3: Create tracker.py**

```python
# face-service/face_service/tracker.py
"""Lightweight IoU-based face tracker with per-track majority-vote identity cache.

No external dependencies beyond numpy. Uses greedy IoU association (sufficient
for the low track counts typical of a home camera feed).
"""
from __future__ import annotations

from collections import deque
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from .recognizer import DetectedFace, Match


def _iou(a: tuple, b: tuple) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter == 0.0:
        return 0.0
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _greedy_match(
    track_bboxes: list[tuple],
    det_bboxes: list[tuple],
    min_iou: float,
) -> tuple[list[tuple[int, int]], list[int], list[int]]:
    """Returns (matches, unmatched_det_indices, unmatched_track_indices)."""
    matches: list[tuple[int, int]] = []
    used_dets: set[int] = set()

    for ti, tb in enumerate(track_bboxes):
        best_iou = min_iou
        best_di = -1
        for di, db in enumerate(det_bboxes):
            if di in used_dets:
                continue
            iou = _iou(tb, db)
            if iou > best_iou:
                best_iou = iou
                best_di = di
        if best_di >= 0:
            matches.append((ti, best_di))
            used_dets.add(best_di)

    matched_tracks = {ti for ti, _ in matches}
    unmatched_dets = [di for di in range(len(det_bboxes)) if di not in used_dets]
    unmatched_tracks = [ti for ti in range(len(track_bboxes)) if ti not in matched_tracks]
    return matches, unmatched_dets, unmatched_tracks


class FaceTrack:
    """A single tracked face with a rolling recognition vote window."""

    def __init__(self, track_id: int, bbox: tuple, det_score: float, embedding, vote_window: int):
        self.id = track_id
        self.bbox = bbox
        self.det_score = det_score
        self.hits = 1
        self.lost_count = 0
        self.current_embedding = embedding
        self._votes: deque["Match | None"] = deque(maxlen=vote_window)

    def push_vote(self, result: "Match | None") -> None:
        self._votes.append(result)

    def voted_identity(self) -> "Match | None":
        """Return the Match that won majority (>50%) of the vote window, or None."""
        if not self._votes:
            return None

        counts: dict[str | None, int] = {}
        best_match_by_pid: dict[str, "Match"] = {}

        for v in self._votes:
            pid = v.person_id if v is not None else None
            counts[pid] = counts.get(pid, 0) + 1
            if v is not None and pid not in best_match_by_pid:
                best_match_by_pid[pid] = v

        best_pid = max(counts, key=counts.__getitem__)
        if best_pid is None:
            return None
        if counts[best_pid] / len(self._votes) <= 0.5:
            return None
        return best_match_by_pid.get(best_pid)


class FaceTracker:
    """Manages active face tracks across frames using greedy IoU association."""

    def __init__(self, min_iou: float, min_hits: int, max_lost: int, vote_window: int):
        self._min_iou = min_iou
        self._min_hits = min_hits
        self._max_lost = max_lost
        self._vote_window = vote_window
        self._tracks: list[FaceTrack] = []
        self._next_id = 0

    def update(self, faces: list["DetectedFace"]) -> None:
        """Associate detections with existing tracks and advance all track states."""
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
                    vote_window=self._vote_window,
                )
            )
            self._next_id += 1

        # Remove dead tracks
        self._tracks = [t for t in self._tracks if t.lost_count <= self._max_lost]

    def confirmed_tracks(self) -> list[FaceTrack]:
        """Return tracks that have been seen for at least min_hits consecutive frames."""
        return [t for t in self._tracks if t.hits >= self._min_hits]
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd face-service && .venv/bin/python -m pytest tests/test_tracker.py -v
```

Expected: 8 PASSED.

- [ ] **Step 5: Commit**

```bash
git add face-service/face_service/tracker.py face-service/tests/test_tracker.py
git commit -m "feat(face): IoU SORT tracker with majority-vote recognition cache (Layer C)"
```

---

## Task 5: Layer C Integration — Tracker in Worker + Config Vars

**Files:**
- Modify: `face-service/face_service/config.py` (add 4 tracking env vars)
- Modify: `face-service/face_service/worker.py` (integrate tracker into frame loop)

**Interfaces:**
- Consumes: `FaceTracker`, `FaceTrack` from `face_service.tracker` (Task 4)
- Consumes: `Config` from `face_service.config`
- The emitted detection event JSON now includes `"track_id": int` alongside existing fields.

- [ ] **Step 1: Add tracking env vars to config.py**

In `Config.from_env()`, add four fields inside the `return Config(...)` call. First add them to the `Config` dataclass (after `providers`):

```python
@dataclass(frozen=True)
class Config:
    # ... existing fields ...
    providers: tuple[str, ...]
    track_min_iou: float
    track_min_hits: int
    track_max_lost: int
    track_vote_window: int
```

In `from_env()`, add to the `return Config(...)` call:
```python
    track_min_iou=_env_float("FACE_SERVICE_TRACK_MIN_IOU", 0.3),
    track_min_hits=_env_int("FACE_SERVICE_TRACK_MIN_HITS", 3),
    track_max_lost=_env_int("FACE_SERVICE_TRACK_MAX_LOST", 5),
    track_vote_window=_env_int("FACE_SERVICE_TRACK_VOTE_WINDOW", 10),
```

- [ ] **Step 2: Integrate tracker into worker.py**

Add import at the top of `worker.py` (after existing imports):
```python
from .tracker import FaceTracker
```

In `_run_async`, instantiate the tracker after `rec = Recognizer(...)`:
```python
    tracker = FaceTracker(
        min_iou=config.track_min_iou,
        min_hits=config.track_min_hits,
        max_lost=config.track_max_lost,
        vote_window=config.track_vote_window,
    )
```

Pass `tracker` into `_process_frames`:
```python
    local_version = await _process_frames(
        ws=ws,
        camera_id=camera_id,
        config=config,
        rec=rec,
        tracker=tracker,
        index_ref=index_ref,
        local_version=local_version,
        fps_value=fps_value,
        index_version=index_version,
        shutdown_event=shutdown_event,
        out_queue=out_queue,
    )
```

Update `_process_frames` signature to accept `tracker`:
```python
async def _process_frames(
    *,
    ws,
    camera_id: str,
    config: Config,
    rec: Recognizer,
    tracker: FaceTracker,
    index_ref: list[MatchIndex],
    local_version: int,
    fps_value,
    index_version,
    shutdown_event,
    out_queue,
) -> int:
```

Replace the detection + event-building block (from `faces = rec.detect(frame)` through `out_queue.put_nowait(...)`) with:

```python
        try:
            faces = rec.detect(frame)
        except Exception as exc:
            log.warning("detect failed: %s", exc)
            continue

        tracker.update(faces)

        detections = []
        index = index_ref[0]
        for track in tracker.confirmed_tracks():
            if track.current_embedding is not None:
                match_result = index.match(track.current_embedding)
                track.push_vote(match_result)

            voted = track.voted_identity()
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
                "person_id": voted.person_id if voted else None,
                "name": voted.name if voted else None,
                "similarity": round(voted.similarity, 3) if voted else None,
            })

        # Throttle empty-frame events so we don't spam the WS at idle FPS.
        if not detections and now - last_emit_empty < 0.5:
            continue
        if not detections:
            last_emit_empty = now

        event = {
            "type": "detections",
            "camera_id": camera_id,
            "ts": frame_ts,
            "frame_w": frame_w,
            "frame_h": frame_h,
            "detections": detections,
        }
        try:
            out_queue.put_nowait(json.dumps(event))
        except Exception:
            pass  # queue full — drop
```

- [ ] **Step 3: Run full test suite**

```bash
cd face-service && .venv/bin/python -m pytest tests/ -v
```

Expected: all tests PASS (tracker integration is not unit-tested in isolation here since it's an end-to-end integration of previously tested components; behavior validated via manual test in next task).

- [ ] **Step 4: Commit**

```bash
git add face-service/face_service/config.py face-service/face_service/worker.py
git commit -m "feat(face): integrate tracker into worker frame loop (Layer C)"
```

---

## Task 6: Frontend — Augmentation Settings Panel + Photo Guide

**Files:**
- Modify: `frontend/src/api/client.ts` (add augmentation API calls)
- Create: `frontend/src/types/augmentation.ts`
- Create: `frontend/src/components/settings/AugmentationSettings.tsx`
- Modify: `frontend/src/components/settings/FaceRecognitionSection.tsx` (add augmentation panel + photo guide)

**Interfaces:**
- Consumes: `GET /api/augmentation/config`, `PUT /api/augmentation/config`, `POST /api/augmentation/regenerate` (Task 3)
- No new props on `FaceRecognitionSection` — augmentation panel is self-contained inside it.

- [ ] **Step 1: Add types**

```typescript
// frontend/src/types/augmentation.ts
export interface AugConfig {
  flip_enabled: boolean

  brightness_enabled: boolean
  brightness_steps: number
  brightness_magnitude_pct: number

  contrast_enabled: boolean
  contrast_steps: number
  contrast_magnitude_pct: number

  rotation_enabled: boolean
  rotation_steps: number
  rotation_max_angle_deg: number

  pixel_quality_enabled: boolean
  pixel_quality_steps: number
  pixel_quality_min_scale: number
}

export const DEFAULT_AUG_CONFIG: AugConfig = {
  flip_enabled: true,
  brightness_enabled: true,
  brightness_steps: 2,
  brightness_magnitude_pct: 20,
  contrast_enabled: true,
  contrast_steps: 2,
  contrast_magnitude_pct: 20,
  rotation_enabled: true,
  rotation_steps: 4,
  rotation_max_angle_deg: 20,
  pixel_quality_enabled: true,
  pixel_quality_steps: 3,
  pixel_quality_min_scale: 0.4,
}
```

- [ ] **Step 2: Add API methods to client.ts**

Add an `augmentation` section to the `api` export object in `client.ts`:
```typescript
  augmentation: {
    getConfig: () => request<AugConfig>('/augmentation/config'),
    setConfig: (cfg: AugConfig) =>
      request<AugConfig>('/augmentation/config', {
        method: 'PUT',
        body: JSON.stringify(cfg),
      }),
    regenerate: () =>
      request<{ augmented_embeddings_created: number }>('/augmentation/regenerate', {
        method: 'POST',
      }),
  },
```

Add the import at the top of `client.ts`:
```typescript
import type { AugConfig } from '../types/augmentation'
```

- [ ] **Step 3: Create AugmentationSettings component**

```tsx
// frontend/src/components/settings/AugmentationSettings.tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, RotateCcw, Sliders } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api/client'
import type { AugConfig } from '../../types/augmentation'
import { DEFAULT_AUG_CONFIG } from '../../types/augmentation'
import { Button } from '../ui/Button'

export function AugmentationSettings({ hasPersons }: { hasPersons: boolean }) {
  const qc = useQueryClient()
  const [guideOpen, setGuideOpen] = useState(false)

  const configQ = useQuery({
    queryKey: ['augmentation-config'],
    queryFn: () => api.augmentation.getConfig(),
  })

  const saveMut = useMutation({
    mutationFn: (cfg: AugConfig) => api.augmentation.setConfig(cfg),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['augmentation-config'] }),
  })

  const regenMut = useMutation({
    mutationFn: () => api.augmentation.regenerate(),
  })

  const cfg = configQ.data ?? DEFAULT_AUG_CONFIG
  const allDisabled =
    !cfg.flip_enabled &&
    !cfg.brightness_enabled &&
    !cfg.contrast_enabled &&
    !cfg.rotation_enabled &&
    !cfg.pixel_quality_enabled

  function patch(update: Partial<AugConfig>) {
    const next = { ...cfg, ...update }
    saveMut.mutate(next)
  }

  return (
    <div className="bg-ink-dark border border-ink-border rounded-r3 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-ink-border">
        <div className="flex items-center gap-2">
          <Sliders size={14} className="text-fg-3" strokeWidth={1.75} />
          <span className="font-sans font-semibold text-[13px] text-fg-1">
            Enrollment augmentation
          </span>
        </div>
        <button
          className="font-mono text-[10px] text-fg-3 uppercase tracking-[0.06em] flex items-center gap-1 hover:text-fg-2 transition-colors"
          onClick={() => patch(DEFAULT_AUG_CONFIG)}
        >
          <RotateCcw size={10} />
          Reset defaults
        </button>
      </div>

      <div className="p-5 flex flex-col gap-4">
        <p className="font-sans text-[12px] text-fg-3 leading-relaxed">
          When you upload a photo, Sentry generates additional embedding variants to improve
          recognition at distance and in varied lighting. Toggle types and adjust their parameters below.
        </p>

        {/* Flip */}
        <AugRow
          label="Horizontal flip"
          description="Mirrors the face — helps with slight left/right head turns."
          enabled={cfg.flip_enabled}
          onToggle={v => patch({ flip_enabled: v })}
        />

        {/* Brightness */}
        <AugRow
          label="Brightness"
          description="Simulates darker and brighter lighting conditions."
          enabled={cfg.brightness_enabled}
          onToggle={v => patch({ brightness_enabled: v })}
        >
          <ParamRow label="Steps" value={cfg.brightness_steps} min={1} max={6}
            onChange={v => patch({ brightness_steps: v })} />
          <ParamRow label="Magnitude %" value={cfg.brightness_magnitude_pct} min={5} max={50} step={5}
            onChange={v => patch({ brightness_magnitude_pct: v })} />
        </AugRow>

        {/* Contrast */}
        <AugRow
          label="Contrast"
          description="Adjusts contrast range — helps with flat or high-contrast scenes."
          enabled={cfg.contrast_enabled}
          onToggle={v => patch({ contrast_enabled: v })}
        >
          <ParamRow label="Steps" value={cfg.contrast_steps} min={1} max={6}
            onChange={v => patch({ contrast_steps: v })} />
          <ParamRow label="Magnitude %" value={cfg.contrast_magnitude_pct} min={5} max={50} step={5}
            onChange={v => patch({ contrast_magnitude_pct: v })} />
        </AugRow>

        {/* Rotation */}
        <AugRow
          label="Rotation"
          description="Small tilts left and right — handles slight head roll."
          enabled={cfg.rotation_enabled}
          onToggle={v => patch({ rotation_enabled: v })}
        >
          <ParamRow label="Steps" value={cfg.rotation_steps} min={2} max={8}
            onChange={v => patch({ rotation_steps: v })} />
          <ParamRow label="Max angle °" value={cfg.rotation_max_angle_deg} min={5} max={45} step={5}
            onChange={v => patch({ rotation_max_angle_deg: v })} />
        </AugRow>

        {/* Pixel quality */}
        <AugRow
          label="Pixel quality"
          description="Downsamples and upsamples the face to mimic how it looks from a distance."
          enabled={cfg.pixel_quality_enabled}
          onToggle={v => patch({ pixel_quality_enabled: v })}
        >
          <ParamRow label="Steps" value={cfg.pixel_quality_steps} min={1} max={6}
            onChange={v => patch({ pixel_quality_steps: v })} />
          <ParamRow label="Min scale" value={cfg.pixel_quality_min_scale} min={0.2} max={0.9} step={0.1}
            onChange={v => patch({ pixel_quality_min_scale: v })} />
        </AugRow>

        {/* Regenerate */}
        {hasPersons && (
          <div className="flex items-center justify-between pt-2 border-t border-ink-border">
            <span className="font-sans text-[12px] text-fg-3">
              Apply current settings to all enrolled people
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => regenMut.mutate()}
              disabled={regenMut.isPending}
            >
              {regenMut.isPending ? 'Regenerating…' : 'Re-generate embeddings'}
            </Button>
          </div>
        )}
        {regenMut.isSuccess && (
          <p className="font-mono text-[11px] text-fg-3">
            Done — {regenMut.data?.augmented_embeddings_created ?? 0} augmented embeddings created.
          </p>
        )}

        {/* Photo guide */}
        <div className="border-t border-ink-border pt-3">
          <button
            className="flex items-center gap-1.5 font-sans text-[12px] text-fg-3 hover:text-fg-2 transition-colors"
            onClick={() => setGuideOpen(o => !o)}
          >
            {guideOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Photo guide
            {allDisabled && (
              <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.06em] text-dim-red">
                Augmentation off — read this
              </span>
            )}
          </button>
          {guideOpen && (
            <ul className="mt-2 pl-4 flex flex-col gap-1 list-disc marker:text-fg-4">
              <li className="font-sans text-[12px] text-fg-3 leading-relaxed">
                Face centered and unobstructed — no sunglasses, hats, or scarves.
              </li>
              <li className="font-sans text-[12px] text-fg-3 leading-relaxed">
                Upload at least one frontal shot and one slight ¾-angle shot.
              </li>
              <li className="font-sans text-[12px] text-fg-3 leading-relaxed">
                Even, diffuse lighting — avoid strong shadows or bright backlighting.
              </li>
              <li className="font-sans text-[12px] text-fg-3 leading-relaxed">
                Face should fill at least ¼ of the image width.
              </li>
              {allDisabled && (
                <li className="font-sans text-[12px] text-fg-3 leading-relaxed font-semibold">
                  Augmentation is off: also take one photo from the same distance the camera sees the person.
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- sub-components -------------------------------------------------------

function AugRow({
  label,
  description,
  enabled,
  onToggle,
  children,
}: {
  label: string
  description: string
  enabled: boolean
  onToggle: (v: boolean) => void
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="font-sans font-medium text-[13px] text-fg-1">{label}</span>
          <p className="font-sans text-[11px] text-fg-3 mt-0.5 leading-relaxed">{description}</p>
        </div>
        <Toggle value={enabled} onChange={onToggle} />
      </div>
      {enabled && children && (
        <div className="pl-3 border-l border-ink-border flex flex-col gap-2">{children}</div>
      )}
    </div>
  )
}

function ParamRow({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="font-sans text-[11px] text-fg-3 w-28 flex-shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="flex-1 accent-dim-red"
      />
      <span className="font-mono text-[11px] text-fg-2 w-10 text-right tabular-nums">
        {value}
      </span>
    </div>
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative flex-shrink-0 w-8 h-4 rounded-full transition-colors ${
        value ? 'bg-dim-red' : 'bg-ink-border'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
          value ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}
```

- [ ] **Step 4: Add AugmentationSettings to FaceRecognitionSection.tsx**

In `FaceRecognitionSection.tsx`, add the import:
```tsx
import { AugmentationSettings } from './AugmentationSettings'
```

Add the panel between the People panel and the Cameras panel (after the closing `</div>` of the People panel `div`):
```tsx
      {/* Augmentation settings panel */}
      <AugmentationSettings hasPersons={persons.length > 0} />
```

- [ ] **Step 5: Manual verification**

Start the full system:
```bash
./run.sh
```

Open `http://localhost:5173`, go to Settings → Face recognition. Verify:
- Augmentation settings panel renders below the People panel
- Toggling each augmentation type shows/hides parameter sliders
- "Reset defaults" resets all sliders to default values
- Uploading a photo to a person generates augmented rows (visible in face-service logs)
- "Re-generate embeddings" button appears when persons exist and triggers regeneration
- Photo guide collapses/expands; warning badge shows when all types are disabled

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types/augmentation.ts \
        frontend/src/api/client.ts \
        frontend/src/components/settings/AugmentationSettings.tsx \
        frontend/src/components/settings/FaceRecognitionSection.tsx
git commit -m "feat(frontend): augmentation settings panel + photo guide"
```

---

## Self-Review

**Spec coverage check:**
- Layer A det_size=1024 → Task 1 ✓
- Layer A gallery matching → Task 1 ✓
- Layer B augmentation engine (all 5 types incl. pixel quality) → Task 2 ✓
- Layer B config stored as JSON in settings table → Task 3 ✓
- Layer B GET/PUT /augmentation/config + POST /augmentation/regenerate → Task 3 ✓
- Layer B photo_count excludes augmented → Task 3 ✓
- Layer B list_photos excludes augmented → Task 3 ✓
- Layer B delete photo re-generates augmented from remaining → Task 3 ✓
- Layer B frontend panel (toggles, sliders, reset, photo guide, re-generate) → Task 6 ✓
- Layer B Go proxy route /augmentation/* → Task 3 ✓
- Layer C tracker (tentative/confirmed/lost/dead states) → Task 4 ✓
- Layer C majority vote >50% per track → Task 4 ✓
- Layer C track_id in emitted event → Task 5 ✓
- Layer C 4 env vars in config → Task 5 ✓
- Photo guide prominent when augmentation disabled → Task 6 ✓

**Type consistency check:**
- `AugConfig.from_dict` / `to_dict` / `default` — consistent Task 2 → Task 3 → Task 6
- `augment_and_embed(bgr, recognizer, config)` — consistent Task 2 → Task 3
- `FaceTrack.push_vote(Match | None)` / `voted_identity() -> Match | None` — consistent Task 4 → Task 5
- `FaceTracker.update(list[DetectedFace])` / `confirmed_tracks() -> list[FaceTrack]` — consistent Task 4 → Task 5
- `Database.delete_augmented_photos(person_id: str | None)` — consistent Task 3 tests → implementation
- `tracker` parameter added to `_process_frames` — propagated from `_run_async` ✓
