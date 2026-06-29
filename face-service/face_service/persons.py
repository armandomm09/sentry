"""Person enrollment service.

Bridges the SQLite store, the recognizer (for embedding extraction at upload time),
and the in-memory MatchIndex that workers consult on every frame.

Photos are stored as files under data/photos/{person_id}/{photo_id}{ext}. We keep
the originals so we can re-extract embeddings if the model is ever swapped.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from pathlib import Path

import cv2
import numpy as np

from .augmentation import AugConfig, augment_and_embed
from .db import Database, FacePhoto, Person
from .recognizer import MatchIndex, Recognizer

log = logging.getLogger(__name__)


class EnrollmentError(Exception):
    """User-facing error during photo enrollment."""


class PersonStore:
    def __init__(
        self,
        db: Database,
        recognizer: Recognizer,
        photos_dir: Path,
        match_threshold: float,
    ):
        self._db = db
        self._rec = recognizer
        self._photos_dir = photos_dir
        self._index = MatchIndex(threshold=match_threshold)
        self._lock = threading.RLock()
        photos_dir.mkdir(parents=True, exist_ok=True)
        self._rebuild_index()

    # ---- match index ------------------------------------------------------

    @property
    def index(self) -> MatchIndex:
        return self._index

    def _rebuild_index(self) -> None:
        rows = list(self._db.all_embeddings())
        self._index.rebuild(rows)
        log.info("match index rebuilt: %d person prototypes", self._index.size)

    # ---- persons CRUD -----------------------------------------------------

    def list_persons(self) -> list[Person]:
        return self._db.list_persons()

    def get_person(self, person_id: str) -> Person | None:
        return self._db.get_person(person_id)

    def create_person(self, name: str) -> Person:
        name = name.strip()
        if not name:
            raise EnrollmentError("name is required")
        return self._db.create_person(name)

    def rename_person(self, person_id: str, name: str) -> bool:
        name = name.strip()
        if not name:
            raise EnrollmentError("name is required")
        with self._lock:
            ok = self._db.rename_person(person_id, name)
            if ok:
                self._rebuild_index()
            return ok

    def delete_person(self, person_id: str) -> bool:
        with self._lock:
            paths = self._db.delete_person(person_id)
            for p in paths:
                self._safe_unlink(p)
            person_root = self._photos_dir / person_id
            if person_root.is_dir():
                try:
                    person_root.rmdir()
                except OSError:
                    pass  # not empty (race) — leave it
            self._rebuild_index()
            return bool(paths)

    # ---- augmentation config helpers --------------------------------------

    def _get_aug_config(self) -> AugConfig:
        val = self._db.get_setting("augmentation_config")
        if val is None:
            return AugConfig.default()
        try:
            return AugConfig.from_dict(json.loads(val))
        except Exception:
            return AugConfig.default()

    def _add_augmented_for_image(
        self, person_id: str, bgr: np.ndarray, aug_config: AugConfig
    ) -> int:
        """Generate and persist augmented embeddings. Returns count added."""
        count = 0
        for emb, label in augment_and_embed(bgr, self._rec, aug_config):
            self._db.add_photo(person_id, label, emb)
            count += 1
        return count

    # ---- photo enrollment -------------------------------------------------

    def list_photos(self, person_id: str) -> list[FacePhoto]:
        return self._db.list_photos(person_id)

    def add_photo_bytes(
        self, person_id: str, raw: bytes, original_filename: str | None = None
    ) -> FacePhoto:
        """Decode bytes, extract embedding, persist file + row, rebuild index."""
        if self._db.get_person(person_id) is None:
            raise EnrollmentError("person not found")

        img = self._decode_image(raw)
        if img is None:
            raise EnrollmentError("could not decode image — expected JPEG, PNG, or WebP")

        embedding = self._rec.embed_only(img)
        if embedding is None:
            raise EnrollmentError("no face detected in the photo")

        ext = self._extension_for(original_filename)
        photo_id = uuid.uuid4().hex
        rel_dir = Path(person_id)
        rel_path = rel_dir / f"{photo_id}{ext}"
        abs_path = self._photos_dir / rel_path
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        with open(abs_path, "wb") as f:
            f.write(raw)

        with self._lock:
            photo = self._db.add_photo(person_id, str(rel_path), embedding)
            aug_config = self._get_aug_config()
            self._add_augmented_for_image(person_id, img, aug_config)
            self._rebuild_index()
        return photo

    def delete_photo(self, photo_id: str) -> bool:
        with self._lock:
            # Find what person this photo belongs to before deleting
            photos_before = {
                p.id: p for person in self._db.list_persons()
                for p in self._db.list_photos(person.id)
            }
            target = next((p for p in photos_before.values() if p.id == photo_id), None)
            if target is None:
                rel = self._db.delete_photo(photo_id)
                if rel is None:
                    return False
                self._safe_unlink(rel)
                self._rebuild_index()
                return True

            person_id = target.person_id
            rel = self._db.delete_photo(photo_id)
            if rel is None:
                return False
            self._safe_unlink(rel)

            # Rebuild augmented embeddings from remaining real photos
            self._db.delete_augmented_photos(person_id)
            aug_config = self._get_aug_config()
            for photo in self._db.list_photos(person_id):
                abs_path = self._photos_dir / photo.photo_path
                bgr = self._decode_image_from_path(abs_path)
                if bgr is not None:
                    self._add_augmented_for_image(person_id, bgr, aug_config)

            self._rebuild_index()
            return True

    def regenerate_augmented(self) -> int:
        """Re-generate all augmented embeddings for every person using current config.

        Deletes existing augmented rows, then re-processes every real photo
        through the current augmentation config. Returns total embeddings added.
        """
        aug_config = self._get_aug_config()
        with self._lock:
            self._db.delete_augmented_photos()
            total = 0
            for person in self._db.list_persons():
                for photo in self._db.list_photos(person.id):
                    abs_path = self._photos_dir / photo.photo_path
                    bgr = self._decode_image_from_path(abs_path)
                    if bgr is not None:
                        total += self._add_augmented_for_image(person.id, bgr, aug_config)
            self._rebuild_index()
        return total

    def photo_abs_path(self, rel_path: str) -> Path:
        return self._photos_dir / rel_path

    # ---- helpers ----------------------------------------------------------

    @staticmethod
    def _decode_image_from_path(path: Path) -> np.ndarray | None:
        if not path.is_file():
            return None
        arr = np.fromfile(str(path), dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return img if img is not None and img.size > 0 else None

    @staticmethod
    def _decode_image(raw: bytes) -> np.ndarray | None:
        arr = np.frombuffer(raw, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None or img.size == 0:
            return None
        return img

    @staticmethod
    def _extension_for(filename: str | None) -> str:
        if not filename:
            return ".jpg"
        ext = os.path.splitext(filename)[1].lower()
        if ext in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}:
            return ext
        return ".jpg"

    def _safe_unlink(self, rel_path: str) -> None:
        try:
            (self._photos_dir / rel_path).unlink()
        except FileNotFoundError:
            pass
        except OSError as e:
            log.warning("failed to remove photo %s: %s", rel_path, e)
