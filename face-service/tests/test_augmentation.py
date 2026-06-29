from unittest.mock import MagicMock
import numpy as np
import pytest

from face_service.augmentation import AugConfig, augment_and_embed
from face_service.recognizer import DetectedFace


def _make_recognizer(embedding: np.ndarray | None = None):
    """Mock recognizer that returns a single face with the given embedding."""
    rec = MagicMock()
    if embedding is None:
        rec.detect.return_value = []
    else:
        emb = embedding.copy()
        face = DetectedFace(bbox=(10.0, 10.0, 90.0, 90.0), score=0.99, embedding=emb, landmarks=None)
        rec.detect.return_value = [face]
    return rec


def _unit_emb(dim: int = 0) -> np.ndarray:
    v = np.zeros(512, dtype=np.float32)
    v[dim] = 1.0
    return v


def test_flip_generates_one_embedding():
    cfg = AugConfig(
        flip_enabled=True,
        brightness_enabled=False,
        contrast_enabled=False,
        rotation_enabled=False,
        pixel_quality_enabled=False,
    )
    rec = _make_recognizer(_unit_emb())
    bgr = np.zeros((100, 100, 3), dtype=np.uint8)
    results = augment_and_embed(bgr, rec, cfg)
    assert len(results) == 1
    label = results[0][1]
    assert label == "<augmented:flip>"
    np.testing.assert_array_almost_equal(results[0][0], _unit_emb())


def test_brightness_generates_steps_embeddings():
    cfg = AugConfig(
        flip_enabled=False,
        brightness_enabled=True,
        brightness_steps=2,
        brightness_magnitude_pct=20.0,
        contrast_enabled=False,
        rotation_enabled=False,
        pixel_quality_enabled=False,
    )
    rec = _make_recognizer(_unit_emb())
    bgr = np.zeros((100, 100, 3), dtype=np.uint8)
    results = augment_and_embed(bgr, rec, cfg)
    assert len(results) == 2
    labels = [r[1] for r in results]
    assert all(l.startswith("<augmented:brightness:") for l in labels)


def test_rotation_skips_when_detect_returns_empty():
    cfg = AugConfig(
        flip_enabled=False,
        brightness_enabled=False,
        contrast_enabled=False,
        rotation_enabled=True,
        rotation_steps=2,
        rotation_max_angle_deg=20.0,
        pixel_quality_enabled=False,
    )
    rec = _make_recognizer(None)  # detect returns []
    bgr = np.zeros((100, 100, 3), dtype=np.uint8)
    results = augment_and_embed(bgr, rec, cfg)
    assert results == []


def test_pixel_quality_generates_steps_embeddings():
    cfg = AugConfig(
        flip_enabled=False,
        brightness_enabled=False,
        contrast_enabled=False,
        rotation_enabled=False,
        pixel_quality_enabled=True,
        pixel_quality_steps=3,
        pixel_quality_min_scale=0.4,
    )
    rec = _make_recognizer(_unit_emb())
    bgr = np.zeros((100, 100, 3), dtype=np.uint8)
    results = augment_and_embed(bgr, rec, cfg)
    assert len(results) == 3
    labels = [r[1] for r in results]
    assert all(l.startswith("<augmented:pixel_quality:") for l in labels)


def test_aug_config_roundtrip():
    cfg = AugConfig.default()
    d = cfg.to_dict()
    cfg2 = AugConfig.from_dict(d)
    assert cfg == cfg2


def test_all_disabled_returns_empty():
    cfg = AugConfig(
        flip_enabled=False,
        brightness_enabled=False,
        contrast_enabled=False,
        rotation_enabled=False,
        pixel_quality_enabled=False,
    )
    rec = _make_recognizer(_unit_emb())
    bgr = np.zeros((100, 100, 3), dtype=np.uint8)
    assert augment_and_embed(bgr, rec, cfg) == []
