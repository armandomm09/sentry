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
