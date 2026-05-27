"""SQLite-backed persistence for persons and face embeddings.

Schema is intentionally tiny:
- persons: one row per enrolled identity
- face_photos: one row per uploaded photo, carrying the embedding inline

Embeddings are stored as raw float32 little-endian blobs (512-dim for buffalo_l).
"""

from __future__ import annotations

import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import numpy as np


SCHEMA = """
CREATE TABLE IF NOT EXISTS persons (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS face_photos (
    id          TEXT PRIMARY KEY,
    person_id   TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    photo_path  TEXT NOT NULL,
    embedding   BLOB NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_person ON face_photos(person_id);
"""


@dataclass
class Person:
    id: str
    name: str
    created_at: str
    photo_count: int = 0

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "created_at": self.created_at,
            "photo_count": self.photo_count,
        }


@dataclass
class FacePhoto:
    id: str
    person_id: str
    photo_path: str
    embedding: np.ndarray
    created_at: str

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "person_id": self.person_id,
            "photo_path": self.photo_path,
            "created_at": self.created_at,
        }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _emb_to_blob(v: np.ndarray) -> bytes:
    return np.ascontiguousarray(v, dtype=np.float32).tobytes()


def _blob_to_emb(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype=np.float32)


class Database:
    """Thin synchronous SQLite wrapper. Methods are thread-safe via an internal lock.

    The DB is small (hundreds of rows in practice) and writes are infrequent, so a
    single lock keeps things simple. Read-heavy paths can still scan inside the lock
    fast — the cache layer in PersonStore is what queries actually hit.
    """

    def __init__(self, path: Path):
        self._path = path
        self._lock = threading.RLock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # ---- persons -----------------------------------------------------------

    def create_person(self, name: str) -> Person:
        pid = uuid.uuid4().hex
        ts = _now()
        with self._lock:
            self._conn.execute(
                "INSERT INTO persons (id, name, created_at) VALUES (?, ?, ?)",
                (pid, name, ts),
            )
            self._conn.commit()
        return Person(id=pid, name=name, created_at=ts, photo_count=0)

    def rename_person(self, person_id: str, name: str) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "UPDATE persons SET name = ? WHERE id = ?", (name, person_id)
            )
            self._conn.commit()
            return cur.rowcount > 0

    def delete_person(self, person_id: str) -> list[str]:
        """Delete person + all face photos. Returns photo_paths so caller can rm files."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT photo_path FROM face_photos WHERE person_id = ?", (person_id,)
            ).fetchall()
            self._conn.execute("DELETE FROM persons WHERE id = ?", (person_id,))
            self._conn.commit()
            return [r[0] for r in rows]

    def get_person(self, person_id: str) -> Person | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT p.id, p.name, p.created_at,
                       (SELECT COUNT(*) FROM face_photos f WHERE f.person_id = p.id)
                FROM persons p WHERE p.id = ?
                """,
                (person_id,),
            ).fetchone()
        if not row:
            return None
        return Person(id=row[0], name=row[1], created_at=row[2], photo_count=row[3])

    def list_persons(self) -> list[Person]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT p.id, p.name, p.created_at,
                       (SELECT COUNT(*) FROM face_photos f WHERE f.person_id = p.id)
                FROM persons p
                ORDER BY LOWER(p.name)
                """
            ).fetchall()
        return [Person(id=r[0], name=r[1], created_at=r[2], photo_count=r[3]) for r in rows]

    # ---- photos / embeddings ----------------------------------------------

    def add_photo(
        self, person_id: str, photo_path: str, embedding: np.ndarray
    ) -> FacePhoto:
        pid = uuid.uuid4().hex
        ts = _now()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO face_photos (id, person_id, photo_path, embedding, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (pid, person_id, photo_path, _emb_to_blob(embedding), ts),
            )
            self._conn.commit()
        return FacePhoto(
            id=pid,
            person_id=person_id,
            photo_path=photo_path,
            embedding=embedding,
            created_at=ts,
        )

    def list_photos(self, person_id: str) -> list[FacePhoto]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT id, person_id, photo_path, embedding, created_at
                FROM face_photos WHERE person_id = ?
                ORDER BY created_at
                """,
                (person_id,),
            ).fetchall()
        return [
            FacePhoto(
                id=r[0], person_id=r[1], photo_path=r[2],
                embedding=_blob_to_emb(r[3]), created_at=r[4],
            )
            for r in rows
        ]

    def delete_photo(self, photo_id: str) -> str | None:
        """Delete one photo. Returns the photo_path so caller can rm the file."""
        with self._lock:
            row = self._conn.execute(
                "SELECT photo_path FROM face_photos WHERE id = ?", (photo_id,)
            ).fetchone()
            if not row:
                return None
            self._conn.execute("DELETE FROM face_photos WHERE id = ?", (photo_id,))
            self._conn.commit()
            return row[0]

    def all_embeddings(self) -> Iterable[tuple[str, str, np.ndarray]]:
        """Yield (person_id, name, embedding) across the whole DB. Used to warm cache."""
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT p.id, p.name, f.embedding
                FROM persons p JOIN face_photos f ON f.person_id = p.id
                """
            ).fetchall()
        for r in rows:
            yield r[0], r[1], _blob_to_emb(r[2])
