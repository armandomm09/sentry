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

    def is_quality_frame(self) -> bool:
        face_h = self.bbox[3] - self.bbox[1]
        return (
            face_h >= self._params.min_vote_face_px
            and self.det_score >= self._params.min_vote_det_score
        )

    def push_vote(self, match: "Match | None") -> None:
        """Feed one recognition result. Ignored unless the current frame is quality."""
        if not self.is_quality_frame():
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

    def update(self, faces: list["DetectedFace"]) -> list["FaceTrack"]:
        """Associate detections with existing tracks and advance all track states.

        Returns the tracks removed this frame (exceeded max_lost), so callers
        can emit end-of-track lifecycle events.
        """
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
        dead = [t for t in self._tracks if t.lost_count > self._max_lost]
        self._tracks = [t for t in self._tracks if t.lost_count <= self._max_lost]
        for t in self._tracks:
            t.resolve_unknown(now)
        return dead

    def confirmed_tracks(self) -> list[FaceTrack]:
        """Return tracks that have been seen for at least min_hits consecutive frames."""
        return [t for t in self._tracks if t.hits >= self._min_hits]
