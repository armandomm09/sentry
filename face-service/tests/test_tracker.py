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
