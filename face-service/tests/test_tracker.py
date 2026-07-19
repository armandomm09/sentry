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
