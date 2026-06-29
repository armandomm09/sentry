import json
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch
import numpy as np
import pytest

from face_service.db import Database
from face_service.augmentation import AugConfig


@pytest.fixture
def tmp_db(tmp_path):
    return Database(tmp_path / "face.db")


def test_settings_roundtrip(tmp_db):
    assert tmp_db.get_setting("augmentation_config") is None
    tmp_db.set_setting("augmentation_config", '{"flip_enabled": false}')
    val = tmp_db.get_setting("augmentation_config")
    assert val is not None
    assert json.loads(val)["flip_enabled"] is False


def test_delete_augmented_photos_removes_only_augmented(tmp_db):
    pid = tmp_db.create_person("Alice").id
    real_emb = np.zeros(512, dtype=np.float32); real_emb[0] = 1.0
    tmp_db.add_photo(pid, "real/photo.jpg", real_emb)
    tmp_db.add_photo(pid, "<augmented:flip>", real_emb)
    tmp_db.add_photo(pid, "<augmented:brightness:+20>", real_emb)

    deleted = tmp_db.delete_augmented_photos(pid)
    assert deleted == 2

    photos = tmp_db.list_photos(pid)
    assert len(photos) == 1
    assert photos[0].photo_path == "real/photo.jpg"


def test_delete_augmented_photos_all_persons(tmp_db):
    pid_a = tmp_db.create_person("Alice").id
    pid_b = tmp_db.create_person("Bob").id
    emb = np.zeros(512, dtype=np.float32); emb[0] = 1.0
    tmp_db.add_photo(pid_a, "<augmented:flip>", emb)
    tmp_db.add_photo(pid_b, "<augmented:flip>", emb)

    deleted = tmp_db.delete_augmented_photos()
    assert deleted == 2


def test_photo_count_excludes_augmented(tmp_db):
    pid = tmp_db.create_person("Alice").id
    emb = np.zeros(512, dtype=np.float32); emb[0] = 1.0
    tmp_db.add_photo(pid, "photo.jpg", emb)
    tmp_db.add_photo(pid, "<augmented:flip>", emb)

    person = tmp_db.get_person(pid)
    assert person is not None
    assert person.photo_count == 1  # only real photo


def test_list_photos_excludes_augmented(tmp_db):
    pid = tmp_db.create_person("Alice").id
    emb = np.zeros(512, dtype=np.float32); emb[0] = 1.0
    tmp_db.add_photo(pid, "real.jpg", emb)
    tmp_db.add_photo(pid, "<augmented:flip>", emb)

    photos = tmp_db.list_photos(pid)
    assert len(photos) == 1
    assert photos[0].photo_path == "real.jpg"
