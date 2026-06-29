# Face Recognition Robustness — Design Spec

**Date:** 2026-06-29
**Status:** Approved

## Problem

Face recognition fails or flickers to "unknown" when subjects are 3–5 meters from a 1280×720 camera. Root causes:

1. **Small face detection** — SCRFD at `det_size=640` struggles with faces ~30–50px wide.
2. **Sparse enrollment** — 2 photos averaged into one prototype can't represent the person across lighting/angle variation seen at distance.
3. **Frame-level matching** — one bad frame immediately emits "unknown" with no temporal smoothing.

## Hardware Context

Runs on a DGX Spark (Blackwell GPU). TensorRT and CUDA EPs are available. Inference budget is not a constraint — push quality first.

## Solution Overview

Three independent layers, each addressing a distinct failure mode:

| Layer | What it fixes | Files touched |
|---|---|---|
| A — Detection & gallery matching | Small face detection; sparse prototype matching | `config.py`, `recognizer.py` |
| B — Enrollment augmentation | Low diversity from 2 photos; distance degradation | `augmentation.py` (new), `persons.py`, `db.py`, `server.py`, frontend |
| C — Face tracking + vote cache | Frame-to-frame flicker; single-frame "unknown" spikes | `tracker.py` (new), `worker.py` |

---

## Layer A: Detection & Gallery Matching

### Detection size

Increase default `det_size` from `640` to `1024` in `config.py`. Env var `FACE_SERVICE_DET_SIZE` remains available for override. At 1024 the SCRFD grid is finer — faces as small as ~20px become detectable. On DGX with TensorRT this adds negligible latency.

### Gallery matching (replace mean prototype)

**Current:** `MatchIndex.rebuild()` averages all embeddings per person into one L2-normalized prototype. `match()` does `matrix @ query` and argmax.

**New:** Store all individual embeddings as separate rows in the matrix, each tagged with its `person_id`. `match()` computes similarity against every row, groups by `person_id`, takes the max similarity per person, then argmax across persons. If any single enrolled embedding (real or augmented) matches well, it's a hit.

```
# Pseudocode
sims = matrix @ query          # shape (total_embeddings,)
per_person_max = group_max(sims, by=person_ids)
best_person = argmax(per_person_max)
if per_person_max[best_person] >= threshold: return Match(...)
```

No API or DB schema changes. Threshold stays at `0.42` initially; tune after Layer B augmentation is live.

---

## Layer B: Enrollment Augmentation

### Augmentation engine (`augmentation.py`)

New module. `augment_and_embed(bgr, recognizer, config)` applies transforms to a face image, runs `recognizer.detect()` on each variant, and returns only embeddings where InsightFace successfully detected a face (failed detections are silently skipped).

**Configurable augmentation types:**

| Type | Parameters | Recommended default |
|---|---|---|
| Horizontal flip | enabled (bool) | true |
| Brightness | steps (int), magnitude_pct (float) | 2 steps, ±20% |
| Contrast | steps (int), magnitude_pct (float) | 2 steps, ±20% |
| Rotation | steps (int), max_angle_deg (float) | 4 steps, ±20° |
| Pixel quality | steps (int), min_scale (float 0–1) | 3 steps, min 0.4 |

**Pixel quality** downscales the crop to `min_scale`–`1.0` in `steps` intervals, then upscales back to original — mimicking face appearance at increasing camera distances.

Augmentation is fully optional. If all types are disabled, only the original embedding is stored.

### Storage

Augmented embeddings are stored as additional rows in `face_photos` with `photo_path` set to a synthetic marker like `<augmented:flip>`, `<augmented:brightness:+20>`, etc. This distinguishes them from real uploaded photos in any UI listing. No DB schema change needed.

### Re-enrollment on config change

When the user saves new augmentation settings, the frontend offers a "Re-generate augmented embeddings for all persons" action. This triggers a backend endpoint that re-processes stored real photos (those without synthetic `photo_path` markers) through the new augmentation config.

### Augmentation config API

Two new endpoints on the face-service:

- `GET /augmentation/config` — returns current config (with defaults if never set)
- `PUT /augmentation/config` — saves new config
- `POST /augmentation/regenerate` — re-processes all real photos (those without synthetic `photo_path` markers) through the current augmentation config; replaces existing augmented embeddings for all persons

Config persisted as a JSON blob in a new `settings` table in `face.db`.

### Frontend — Augmentation settings panel

Located in the Persons/Enrollment section of the dashboard. Contains:

- Per-type toggles and parameter controls (sliders + number inputs) with recommended defaults shown inline
- "Reset to recommended defaults" button
- On save: if enrolled persons exist, prompt "Re-generate augmented embeddings with new settings?" with Yes/No

**Photo Guide** — collapsible section in the enrollment UI, shown prominently when augmentation is fully disabled:

> - Face centered, unobstructed, no sunglasses or hats
> - Capture one frontal shot and one slight 3/4 angle shot
> - Even, diffuse lighting — avoid strong shadows or backlighting
> - Face should fill at least 1/4 of the image width
> - If augmentation is off, also take one photo from the same distance the camera will see the person

---

## Layer C: Face Tracking + Recognition Cache

### FaceTracker (`tracker.py`)

Lightweight IoU-based SORT implementation (~100 lines, no new pip dependency). Maintains a list of active tracks across frames.

**Track states:**

| State | Condition |
|---|---|
| Tentative | Seen for < `min_hits` consecutive frames |
| Confirmed | Seen for ≥ `min_hits` consecutive frames |
| Lost | Missed for ≤ `max_lost` frames (kept alive for occlusion) |
| Dead | Missed for > `max_lost` frames — removed |

Only confirmed tracks emit identity events.

**Association:** Hungarian algorithm (or greedy IoU) matches incoming bboxes to existing tracks by IoU. Bboxes below `min_iou` threshold start new tentative tracks.

### Recognition cache per track

Each confirmed track holds a rolling window (size `vote_window`) of recognition results (`person_id` or `None`). The emitted identity is the **majority winner** of the window. A person must win >50% of window slots to be emitted as known — one bad frame cannot flip a confirmed identity to unknown.

### Integration in `worker.py`

`_process_frames()` is updated:

```
faces = rec.detect(frame)               # list[DetectedFace] with .embedding
tracks = tracker.update(faces)          # associates detections, updates state
for track in tracker.confirmed_tracks():
    # track.current_embedding is the embedding from the detection matched
    # to this track in the current frame; None if the track is in lost state
    track.push_vote(match(track.current_embedding) if track.current_embedding else None)
    emit detection with track.voted_identity()
```

The emitted detection event gains a `track_id` field (stable integer for the track's lifetime). The `person_id` and `name` fields now reflect the voted identity, not the per-frame match.

### Tunable env vars

| Variable | Default | Meaning |
|---|---|---|
| `FACE_SERVICE_TRACK_MAX_LOST` | 5 | Frames a track survives without a detection |
| `FACE_SERVICE_TRACK_MIN_HITS` | 3 | Frames to confirm a new track |
| `FACE_SERVICE_TRACK_VOTE_WINDOW` | 10 | Rolling window size for majority vote |
| `FACE_SERVICE_TRACK_MIN_IOU` | 0.3 | Minimum IoU to associate detection to track |

---

## Files Changed

| File | Change |
|---|---|
| `face-service/face_service/config.py` | `det_size` default → 1024; add 4 tracking env vars |
| `face-service/face_service/recognizer.py` | `MatchIndex`: gallery matching instead of mean prototype |
| `face-service/face_service/augmentation.py` | New — augmentation engine |
| `face-service/face_service/tracker.py` | New — IoU SORT tracker + recognition vote cache |
| `face-service/face_service/worker.py` | Integrate tracker into frame loop |
| `face-service/face_service/persons.py` | Call augmentation on photo upload; add re-enrollment endpoint |
| `face-service/face_service/db.py` | Add `settings` table for augmentation config |
| `face-service/face_service/server.py` | Register augmentation config endpoints |
| `frontend/src/` | Augmentation settings panel + photo guide in enrollment UI |

## Out of Scope

- Changing the InsightFace model pack (`buffalo_l` stays)
- Per-person augmentation configs (one global config)
- Face re-identification across camera feeds
- Active learning / auto-enrollment from live video
