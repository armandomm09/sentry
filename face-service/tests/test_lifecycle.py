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
    # (95,95,185,185) overlaps (100,100,160,160) at IoU 0.44 >= min_iou 0.3,
    # so it associates with the same track while growing the face 60px -> 90px.
    for i in range(2):
        _step(tracker, emitter, [_face(95, 95, 185, 185)], ts=101.0 + i, votes=_match(sim=0.5))
    big_crop = emitter._states[0].crop_jpeg
    assert big_crop is not None and small_crop is not None
    assert len(big_crop) != len(small_crop)  # crop was replaced

    import cv2
    small = cv2.imdecode(np.frombuffer(small_crop, np.uint8), cv2.IMREAD_COLOR)
    big = cv2.imdecode(np.frombuffer(big_crop, np.uint8), cv2.IMREAD_COLOR)
    assert big.shape[0] > small.shape[0]
