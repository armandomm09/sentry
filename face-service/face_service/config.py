"""Environment-driven configuration for the face-service."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if v else default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ[name])
    except (KeyError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    data_dir: Path
    db_path: Path
    photos_dir: Path
    model_pack: str           # insightface model bundle name
    det_size: int             # detection input edge (square)
    match_threshold: float    # cosine similarity threshold for a match
    idle_fps: float           # fps when no viewer is attached
    active_fps: float         # fps when a viewer is watching
    frame_width: int          # ffmpeg downscale width (height auto)
    providers: tuple[str, ...]

    @staticmethod
    def from_env() -> "Config":
        data_dir = Path(_env("FACE_SERVICE_DATA_DIR", "./data")).resolve()
        # Provider order: explicit override > TensorRT > CUDA > CoreML > CPU.
        # The recognizer filters this list to what the installed ORT build
        # actually supports, so requesting CUDA on a CPU-only install is a no-op
        # (not a warning). TensorRT is listed first so DGX Spark / Jetson Thor
        # picks it up when the GPU wheel includes TRT EP — measurably faster on
        # Blackwell than the plain CUDA EP.
        providers_env = os.environ.get("FACE_SERVICE_PROVIDERS")
        if providers_env:
            providers = tuple(p.strip() for p in providers_env.split(",") if p.strip())
        else:
            providers = (
                "TensorrtExecutionProvider",
                "CUDAExecutionProvider",
                "CoreMLExecutionProvider",
                "CPUExecutionProvider",
            )
        return Config(
            host=_env("FACE_SERVICE_HOST", "127.0.0.1"),
            port=_env_int("FACE_SERVICE_PORT", 8090),
            data_dir=data_dir,
            db_path=data_dir / "face.db",
            photos_dir=data_dir / "photos",
            model_pack=_env("FACE_SERVICE_MODEL", "buffalo_l"),
            det_size=_env_int("FACE_SERVICE_DET_SIZE", 640),
            match_threshold=_env_float("FACE_SERVICE_MATCH_THRESHOLD", 0.42),
            idle_fps=_env_float("FACE_SERVICE_IDLE_FPS", 2.0),
            active_fps=_env_float("FACE_SERVICE_ACTIVE_FPS", 8.0),
            frame_width=_env_int("FACE_SERVICE_FRAME_WIDTH", 640),
            providers=providers,
        )
