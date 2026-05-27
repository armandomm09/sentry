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

        log.info(
            "loading InsightFace bundle=%s det_size=%d providers=%s",
            self._model_pack, self._det_size, self._providers,
        )
        # InsightFace will silently drop unavailable providers, so we can pass them
        # all and let it pick the best one actually installed.
        app = FaceAnalysis(name=self._model_pack, providers=list(self._providers))
        app.prepare(ctx_id=0, det_size=(self._det_size, self._det_size))
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
    """In-memory cosine matcher built from a list of per-person embeddings.

    We average the embeddings of each person's enrolled photos into a single
    L2-normalized prototype, then match by argmax dot product. This is plenty
    fast for hundreds of people and avoids depending on FAISS.
    """

    def __init__(self, threshold: float):
        self._threshold = threshold
        self._person_ids: list[str] = []
        self._names: list[str] = []
        self._matrix: np.ndarray | None = None  # shape (N, 512), L2-normalized

    def rebuild(self, embeddings: list[tuple[str, str, np.ndarray]]) -> None:
        """embeddings: iterable of (person_id, name, embedding)."""
        # group by person_id
        by_person: dict[str, list[np.ndarray]] = {}
        names: dict[str, str] = {}
        for pid, name, emb in embeddings:
            by_person.setdefault(pid, []).append(emb)
            names[pid] = name

        if not by_person:
            self._person_ids = []
            self._names = []
            self._matrix = None
            return

        prototypes = []
        ids = []
        labels = []
        for pid, embs in by_person.items():
            mean = np.mean(np.stack(embs, axis=0), axis=0)
            n = np.linalg.norm(mean)
            if n == 0:
                continue
            prototypes.append((mean / n).astype(np.float32))
            ids.append(pid)
            labels.append(names[pid])

        self._person_ids = ids
        self._names = labels
        self._matrix = np.stack(prototypes, axis=0) if prototypes else None

    def match(self, embedding: np.ndarray) -> Match | None:
        if self._matrix is None or embedding is None:
            return None
        sims = self._matrix @ embedding.astype(np.float32)
        idx = int(np.argmax(sims))
        sim = float(sims[idx])
        if sim < self._threshold:
            return None
        return Match(person_id=self._person_ids[idx], name=self._names[idx], similarity=sim)

    @property
    def size(self) -> int:
        return 0 if self._matrix is None else self._matrix.shape[0]
