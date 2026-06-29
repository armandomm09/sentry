"""InsightFace wrapper: detection + embedding + matching.

The model bundle (`buffalo_l` by default) gives us:
  - SCRFD face detector → bbox + 5 landmarks
  - ArcFace recognition head → L2-normalized 512-d embedding

The matcher is a simple cosine similarity against a mean-per-person prototype.
Cosine of L2-normalized vectors == dot product, so we can do the whole match as
one matmul.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass

import numpy as np

log = logging.getLogger(__name__)


@dataclass
class DetectedFace:
    bbox: tuple[float, float, float, float]  # x1, y1, x2, y2 (pixel coords)
    score: float                              # detector confidence
    embedding: np.ndarray | None              # L2-normalized 512-d
    landmarks: np.ndarray | None              # (5, 2) — kept for future use


@dataclass
class Match:
    person_id: str
    name: str
    similarity: float


class Recognizer:
    """Lazy-loaded InsightFace bundle. Thread-safe for inference.

    InsightFace's FaceAnalysis isn't documented as thread-safe — onnxruntime sessions
    generally are for read-only inference, but we serialize calls with a lock to be
    safe and to keep GPU memory predictable when workers share a model handle.
    """

    def __init__(self, model_pack: str, det_size: int, providers: tuple[str, ...]):
        self._model_pack = model_pack
        self._det_size = det_size
        self._providers = providers
        self._app = None
        self._lock = threading.Lock()

    def _ensure_loaded(self) -> None:
        if self._app is not None:
            return
        # Imported lazily so the rest of the service can start without ORT installed.
        from insightface.app import FaceAnalysis  # type: ignore
        import onnxruntime as ort  # type: ignore

        # Filter the configured provider list down to the ones the installed ORT
        # build actually supports, preserving preference order. Asking for
        # CUDAExecutionProvider on a CPU-only build emits a noisy warning per
        # call; on aarch64 without the GPU wheel we'd also fall through silently
        # to CPU, which makes debugging GPU-vs-CPU mode harder. Doing the filter
        # ourselves keeps the logs honest.
        available = set(ort.get_available_providers())
        providers = [p for p in self._providers if p in available]
        if not providers:
            providers = ["CPUExecutionProvider"]

        # TensorrtExecutionProvider appears in ort.get_available_providers() even
        # when libnvinfer.so.10 is not installed. InsightFace falls back all the
        # way to CPU-only when TRT fails at runtime instead of trying CUDA next.
        # Detect this ahead of time: if the TRT shared library isn't present on
        # LD_LIBRARY_PATH / ldconfig, remove TRT from the provider list so CUDA
        # gets used directly.
        if "TensorrtExecutionProvider" in providers:
            import ctypes.util
            if ctypes.util.find_library("nvinfer") is None:
                log.info(
                    "libnvinfer not found — removing TensorrtExecutionProvider "
                    "(install TensorRT to enable it)"
                )
                providers = [p for p in providers if p != "TensorrtExecutionProvider"]

        # ctx_id picks the device for a GPU EP; -1 means CPU. If we ended up on
        # CPU only we must pass -1 or InsightFace tries to bind a CUDA context
        # we don't have.
        gpu_eps = {"CUDAExecutionProvider", "TensorrtExecutionProvider", "ROCMExecutionProvider"}
        ctx_id = 0 if any(p in gpu_eps for p in providers) else -1

        log.info(
            "loading InsightFace bundle=%s det_size=%d providers=%s ctx_id=%d (available=%s)",
            self._model_pack, self._det_size, providers, ctx_id, sorted(available),
        )
        app = FaceAnalysis(name=self._model_pack, providers=providers)
        app.prepare(ctx_id=ctx_id, det_size=(self._det_size, self._det_size))
        self._app = app
        log.info("InsightFace ready")

    # --- detection ---------------------------------------------------------

    def detect(self, bgr: np.ndarray) -> list[DetectedFace]:
        """Run detection + embedding on a single BGR frame."""
        self._ensure_loaded()
        with self._lock:
            faces = self._app.get(bgr)
        out: list[DetectedFace] = []
        for f in faces:
            bbox = tuple(float(x) for x in f.bbox)  # x1,y1,x2,y2
            emb = getattr(f, "normed_embedding", None)
            if emb is None:
                raw = getattr(f, "embedding", None)
                if raw is not None:
                    n = np.linalg.norm(raw)
                    emb = raw / n if n > 0 else None
            out.append(
                DetectedFace(
                    bbox=bbox,  # type: ignore[arg-type]
                    score=float(getattr(f, "det_score", 0.0)),
                    embedding=emb.astype(np.float32) if emb is not None else None,
                    landmarks=getattr(f, "kps", None),
                )
            )
        return out

    def embed_only(self, bgr: np.ndarray) -> np.ndarray | None:
        """Detect a single face and return its embedding. Used for enrollment.

        If multiple faces are detected we return the largest one — enrollment
        photos shouldn't have crowds, but we pick the most likely subject just
        in case.
        """
        faces = self.detect(bgr)
        if not faces:
            return None
        # largest bbox area
        def area(f: DetectedFace) -> float:
            x1, y1, x2, y2 = f.bbox
            return max(0.0, (x2 - x1)) * max(0.0, (y2 - y1))
        best = max(faces, key=area)
        return best.embedding


class MatchIndex:
    """In-memory cosine gallery matcher.

    Stores every individual embedding as a row (rather than a mean prototype),
    groups rows by person_id at match time, and returns the person whose best
    individual embedding is closest to the query. This means any one good photo
    out of many augmented variants is sufficient for a match.
    """

    def __init__(self, threshold: float):
        self._threshold = threshold
        self._row_pids: list[str] = []          # person_id per matrix row
        self._pid_names: dict[str, str] = {}     # person_id -> display name
        self._matrix: np.ndarray | None = None   # shape (N_rows, 512), L2-norm

    def rebuild(self, embeddings: list[tuple[str, str, np.ndarray]]) -> None:
        """embeddings: iterable of (person_id, name, embedding)."""
        rows: list[np.ndarray] = []
        row_pids: list[str] = []
        pid_names: dict[str, str] = {}

        for pid, name, emb in embeddings:
            pid_names[pid] = name
            n = np.linalg.norm(emb)
            if n == 0:
                continue
            rows.append((emb / n).astype(np.float32))
            row_pids.append(pid)

        if not rows:
            self._row_pids = []
            self._pid_names = {}
            self._matrix = None
            return

        self._row_pids = row_pids
        self._pid_names = pid_names
        self._matrix = np.stack(rows, axis=0)

    def match(self, embedding: np.ndarray) -> Match | None:
        if self._matrix is None or embedding is None:
            return None
        sims = self._matrix @ embedding.astype(np.float32)

        # Take max similarity per person across all their enrolled embeddings.
        best_sim_by_pid: dict[str, float] = {}
        for i, pid in enumerate(self._row_pids):
            s = float(sims[i])
            if s > best_sim_by_pid.get(pid, -1.0):
                best_sim_by_pid[pid] = s

        best_pid = max(best_sim_by_pid, key=best_sim_by_pid.__getitem__)
        best_sim = best_sim_by_pid[best_pid]

        if best_sim < self._threshold:
            return None
        return Match(
            person_id=best_pid,
            name=self._pid_names[best_pid],
            similarity=best_sim,
        )

    @property
    def size(self) -> int:
        return len(self._pid_names)  # unique persons enrolled
