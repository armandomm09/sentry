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
