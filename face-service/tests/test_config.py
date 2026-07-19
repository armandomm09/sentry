from face_service.config import Config


def test_identity_defaults(monkeypatch):
    for var in (
        "FACE_SERVICE_ACQUIRE_THRESHOLD",
        "FACE_SERVICE_KEEP_THRESHOLD",
        "FACE_SERVICE_ACQUIRE_VOTES",
        "FACE_SERVICE_MIN_VOTE_FACE_PX",
        "FACE_SERVICE_MIN_VOTE_DET_SCORE",
        "FACE_SERVICE_UNKNOWN_MIN_AGE_S",
        "FACE_SERVICE_UNKNOWN_MIN_VOTES",
    ):
        monkeypatch.delenv(var, raising=False)
    cfg = Config.from_env()
    assert cfg.acquire_threshold == 0.45
    assert cfg.keep_threshold == 0.35
    assert cfg.acquire_votes == 3
    assert cfg.min_vote_face_px == 48
    assert cfg.min_vote_det_score == 0.6
    assert cfg.unknown_min_age_s == 3.0
    assert cfg.unknown_min_votes == 5
    assert not hasattr(cfg, "track_vote_window")


def test_identity_env_overrides(monkeypatch):
    monkeypatch.setenv("FACE_SERVICE_ACQUIRE_THRESHOLD", "0.5")
    monkeypatch.setenv("FACE_SERVICE_KEEP_THRESHOLD", "0.3")
    monkeypatch.setenv("FACE_SERVICE_ACQUIRE_VOTES", "4")
    monkeypatch.setenv("FACE_SERVICE_MIN_VOTE_FACE_PX", "64")
    monkeypatch.setenv("FACE_SERVICE_MIN_VOTE_DET_SCORE", "0.7")
    monkeypatch.setenv("FACE_SERVICE_UNKNOWN_MIN_AGE_S", "5.5")
    monkeypatch.setenv("FACE_SERVICE_UNKNOWN_MIN_VOTES", "8")
    cfg = Config.from_env()
    assert cfg.acquire_threshold == 0.5
    assert cfg.keep_threshold == 0.3
    assert cfg.acquire_votes == 4
    assert cfg.min_vote_face_px == 64
    assert cfg.min_vote_det_score == 0.7
    assert cfg.unknown_min_age_s == 5.5
    assert cfg.unknown_min_votes == 8
