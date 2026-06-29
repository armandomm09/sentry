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
