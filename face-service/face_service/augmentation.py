"""Enrollment augmentation: generate embedding variants from a single image.

Each augmentation type applies an OpenCV transform, re-runs face detection,
and returns the embedding if InsightFace found a face. Failed detections are
silently skipped — some extreme rotations may lose the face.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import cv2
import numpy as np

if TYPE_CHECKING:
    from .recognizer import Recognizer


@dataclass
class AugConfig:
    flip_enabled: bool = True

    brightness_enabled: bool = True
    brightness_steps: int = 2
    brightness_magnitude_pct: float = 20.0

    contrast_enabled: bool = True
    contrast_steps: int = 2
    contrast_magnitude_pct: float = 20.0

    rotation_enabled: bool = True
    rotation_steps: int = 4
    rotation_max_angle_deg: float = 20.0

    pixel_quality_enabled: bool = True
    pixel_quality_steps: int = 3
    pixel_quality_min_scale: float = 0.4

    @staticmethod
    def default() -> "AugConfig":
        return AugConfig()

    def to_dict(self) -> dict:
        return {
            "flip_enabled": self.flip_enabled,
            "brightness_enabled": self.brightness_enabled,
            "brightness_steps": self.brightness_steps,
            "brightness_magnitude_pct": self.brightness_magnitude_pct,
            "contrast_enabled": self.contrast_enabled,
            "contrast_steps": self.contrast_steps,
            "contrast_magnitude_pct": self.contrast_magnitude_pct,
            "rotation_enabled": self.rotation_enabled,
            "rotation_steps": self.rotation_steps,
            "rotation_max_angle_deg": self.rotation_max_angle_deg,
            "pixel_quality_enabled": self.pixel_quality_enabled,
            "pixel_quality_steps": self.pixel_quality_steps,
            "pixel_quality_min_scale": self.pixel_quality_min_scale,
        }

    @staticmethod
    def from_dict(d: dict) -> "AugConfig":
        cfg = AugConfig()
        for f_name in cfg.to_dict():
            if f_name in d:
                setattr(cfg, f_name, d[f_name])
        return cfg


def _embed_or_none(bgr: np.ndarray, recognizer: "Recognizer") -> np.ndarray | None:
    """Run detect on bgr, return embedding of largest face or None."""
    from .recognizer import DetectedFace
    faces = recognizer.detect(bgr)
    if not faces:
        return None
    best = max(
        faces,
        key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
    )
    return best.embedding


def augment_and_embed(
    bgr: np.ndarray,
    recognizer: "Recognizer",
    config: AugConfig,
) -> list[tuple[np.ndarray, str]]:
    """Apply configured augmentations to bgr, return (embedding, label) pairs.

    Only augmentation variants where InsightFace detects a face are included.
    The original image is NOT included — caller handles the real embedding separately.
    """
    results: list[tuple[np.ndarray, str]] = []

    # Horizontal flip
    if config.flip_enabled:
        aug = cv2.flip(bgr, 1)
        emb = _embed_or_none(aug, recognizer)
        if emb is not None:
            results.append((emb, "<augmented:flip>"))

    # Brightness: `steps` linearly spaced deltas from -magnitude to +magnitude
    if config.brightness_enabled and config.brightness_steps > 0:
        for delta in np.linspace(
            -config.brightness_magnitude_pct,
            config.brightness_magnitude_pct,
            config.brightness_steps,
        ):
            if abs(delta) < 1e-3:
                continue
            factor = 1.0 + delta / 100.0
            aug = np.clip(bgr.astype(np.float32) * factor, 0, 255).astype(np.uint8)
            emb = _embed_or_none(aug, recognizer)
            if emb is not None:
                results.append((emb, f"<augmented:brightness:{delta:+.0f}>"))

    # Contrast: scale deviation from mean pixel value
    if config.contrast_enabled and config.contrast_steps > 0:
        mean_val = float(bgr.mean())
        for delta in np.linspace(
            -config.contrast_magnitude_pct,
            config.contrast_magnitude_pct,
            config.contrast_steps,
        ):
            if abs(delta) < 1e-3:
                continue
            factor = 1.0 + delta / 100.0
            aug = np.clip(
                mean_val + (bgr.astype(np.float32) - mean_val) * factor, 0, 255
            ).astype(np.uint8)
            emb = _embed_or_none(aug, recognizer)
            if emb is not None:
                results.append((emb, f"<augmented:contrast:{delta:+.0f}>"))

    # Rotation: angles from -max_angle to +max_angle
    if config.rotation_enabled and config.rotation_steps > 0:
        h, w = bgr.shape[:2]
        cx, cy = w / 2.0, h / 2.0
        for angle in np.linspace(
            -config.rotation_max_angle_deg,
            config.rotation_max_angle_deg,
            config.rotation_steps,
        ):
            if abs(angle) < 1e-3:
                continue
            M = cv2.getRotationMatrix2D((cx, cy), float(angle), 1.0)
            aug = cv2.warpAffine(
                bgr, M, (w, h),
                flags=cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_REPLICATE,
            )
            emb = _embed_or_none(aug, recognizer)
            if emb is not None:
                results.append((emb, f"<augmented:rotation:{angle:+.0f}>"))

    # Pixel quality: downsample + upsample to simulate distance
    # scales go from min_scale to just below 1.0 (steps intervals, excluding 1.0)
    if config.pixel_quality_enabled and config.pixel_quality_steps > 0:
        h, w = bgr.shape[:2]
        scales = np.linspace(
            config.pixel_quality_min_scale, 1.0, config.pixel_quality_steps + 1
        )[:-1]  # exclude 1.0 (original resolution)
        for scale in scales:
            sw = max(1, int(w * scale))
            sh = max(1, int(h * scale))
            small = cv2.resize(bgr, (sw, sh), interpolation=cv2.INTER_AREA)
            aug = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
            emb = _embed_or_none(aug, recognizer)
            if emb is not None:
                results.append((emb, f"<augmented:pixel_quality:{scale:.2f}>"))

    return results
