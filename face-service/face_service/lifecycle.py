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
                # Explicit little-endian: the Go side decodes with binary.LittleEndian.
                emb = np.asarray(st.crop_embedding, dtype="<f4")
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
