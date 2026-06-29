"""aiohttp HTTP + WebSocket API for the face-service.

Routes (all JSON unless noted):
  GET    /health
  GET    /persons
  POST   /persons                              {name}
  GET    /persons/{pid}
  PATCH  /persons/{pid}                        {name}
  DELETE /persons/{pid}
  GET    /persons/{pid}/photos
  POST   /persons/{pid}/photos                 multipart: photo=<file>
  DELETE /persons/{pid}/photos/{photo_id}
  GET    /persons/{pid}/photos/{photo_id}/raw  -> binary
  GET    /cameras
  POST   /cameras                              {camera_id, rtsp_url}
  DELETE /cameras/{camera_id}
  GET    /cameras/{camera_id}/ws               WebSocket: detection stream
"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

from .config import Config
from .db import Database
from .persons import EnrollmentError, PersonStore
from .recognizer import Recognizer
from .supervisor import Supervisor


log = logging.getLogger(__name__)

CTX_PERSONS = web.AppKey("persons", PersonStore)
CTX_SUPERVISOR = web.AppKey("supervisor", Supervisor)
CTX_CONFIG = web.AppKey("config", Config)
CTX_DB = web.AppKey("db", Database)


def _json(payload: Any, status: int = 200) -> web.Response:
    return web.json_response(payload, status=status)


def _err(msg: str, status: int = 400) -> web.Response:
    return _json({"error": msg}, status=status)


# ---- health ---------------------------------------------------------------

async def health(_request: web.Request) -> web.Response:
    return _json({"status": "ok"})


# ---- persons --------------------------------------------------------------

async def persons_list(request: web.Request) -> web.Response:
    store = request.app[CTX_PERSONS]
    return _json([p.to_json() for p in store.list_persons()])


async def persons_create(request: web.Request) -> web.Response:
    store = request.app[CTX_PERSONS]
    body = await _read_json(request)
    if isinstance(body, web.Response):
        return body
    name = (body.get("name") or "").strip()
    if not name:
        return _err("name is required")
    try:
        p = store.create_person(name)
    except EnrollmentError as e:
        return _err(str(e))
    return _json(p.to_json(), status=201)


async def persons_get(request: web.Request) -> web.Response:
    store = request.app[CTX_PERSONS]
    pid = request.match_info["pid"]
    p = store.get_person(pid)
    if not p:
        return _err("person not found", status=404)
    return _json(p.to_json())


async def persons_patch(request: web.Request) -> web.Response:
    store = request.app[CTX_PERSONS]
    pid = request.match_info["pid"]
    body = await _read_json(request)
    if isinstance(body, web.Response):
        return body
    if "name" not in body:
        return _err("nothing to update")
    try:
        ok = store.rename_person(pid, body["name"])
    except EnrollmentError as e:
        return _err(str(e))
    if not ok:
        return _err("person not found", status=404)
    p = store.get_person(pid)
    return _json(p.to_json() if p else {})


async def persons_delete(request: web.Request) -> web.Response:
    store = request.app[CTX_PERSONS]
    pid = request.match_info["pid"]
    ok = store.delete_person(pid)
    if not ok:
        return _err("person not found", status=404)
    request.app[CTX_SUPERVISOR].bump_index_version()
    return web.Response(status=204)


# ---- photos ---------------------------------------------------------------

async def photos_list(request: web.Request) -> web.Response:
    store = request.app[CTX_PERSONS]
    pid = request.match_info["pid"]
    if not store.get_person(pid):
        return _err("person not found", status=404)
    photos = store.list_photos(pid)
    return _json([p.to_json() for p in photos])


async def photos_upload(request: web.Request) -> web.Response:
    """multipart upload — field name 'photo'. Multiple parts are accepted; we
    enroll each one. Returns the list of newly added photos."""
    store = request.app[CTX_PERSONS]
    pid = request.match_info["pid"]
    if not store.get_person(pid):
        return _err("person not found", status=404)

    reader = await request.multipart()
    added = []
    errors = []
    async for part in reader:
        if part.name != "photo":
            continue
        filename = part.filename or "upload.jpg"
        raw = await part.read(decode=True)
        if not raw:
            errors.append({"filename": filename, "error": "empty upload"})
            continue
        try:
            photo = store.add_photo_bytes(pid, raw, filename)
            added.append(photo.to_json())
        except EnrollmentError as e:
            errors.append({"filename": filename, "error": str(e)})

    if added:
        request.app[CTX_SUPERVISOR].bump_index_version()
    if not added and errors:
        return _json({"added": [], "errors": errors}, status=400)
    return _json({"added": added, "errors": errors}, status=201)


async def photos_delete(request: web.Request) -> web.Response:
    store = request.app[CTX_PERSONS]
    pid = request.match_info["pid"]
    photo_id = request.match_info["photo_id"]
    if not store.get_person(pid):
        return _err("person not found", status=404)
    ok = store.delete_photo(photo_id)
    if not ok:
        return _err("photo not found", status=404)
    request.app[CTX_SUPERVISOR].bump_index_version()
    return web.Response(status=204)


async def photos_raw(request: web.Request) -> web.Response:
    store = request.app[CTX_PERSONS]
    pid = request.match_info["pid"]
    photo_id = request.match_info["photo_id"]
    photos = store.list_photos(pid)
    photo = next((p for p in photos if p.id == photo_id), None)
    if photo is None:
        return _err("photo not found", status=404)
    path = store.photo_abs_path(photo.photo_path)
    if not path.is_file():
        return _err("file missing on disk", status=410)
    ctype, _ = mimetypes.guess_type(path.name)
    return web.FileResponse(path=path, headers={"Content-Type": ctype or "image/jpeg"})


# ---- cameras --------------------------------------------------------------

async def cameras_list(request: web.Request) -> web.Response:
    sup = request.app[CTX_SUPERVISOR]
    return _json(sup.list_cameras())


async def cameras_enable(request: web.Request) -> web.Response:
    sup = request.app[CTX_SUPERVISOR]
    body = await _read_json(request)
    if isinstance(body, web.Response):
        return body
    camera_id = (body.get("camera_id") or "").strip()
    if not camera_id:
        return _err("camera_id is required")
    sup.start_camera(camera_id)
    return _json({"camera_id": camera_id, "running": sup.is_running(camera_id)})


async def cameras_disable(request: web.Request) -> web.Response:
    sup = request.app[CTX_SUPERVISOR]
    camera_id = request.match_info["camera_id"]
    sup.stop_camera(camera_id)
    return web.Response(status=204)


# ---- WebSocket: detection stream -----------------------------------------

async def camera_ws(request: web.Request) -> web.WebSocketResponse:
    """Stream detection events for a single camera.

    Side-effect: while this WS is connected, the worker for the camera is bumped
    to active FPS. When the last subscriber leaves, FPS drops back to idle.
    """
    camera_id = request.match_info["camera_id"]
    sup = request.app[CTX_SUPERVISOR]

    ws = web.WebSocketResponse(heartbeat=15)
    await ws.prepare(request)

    if not sup.is_running(camera_id):
        await ws.send_json({"type": "error", "message": "camera not enabled for face recognition"})
        await ws.close()
        return ws

    q = sup.subscribe(camera_id)
    try:
        await ws.send_json({"type": "hello", "camera_id": camera_id})
        push_task = asyncio.create_task(_ws_push(ws, q))
        try:
            async for msg in ws:
                # Drain client messages so heartbeats work. We don't expect inbound
                # frames yet (could be used later for filter overrides).
                if msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                    break
        finally:
            push_task.cancel()
            try:
                await push_task
            except asyncio.CancelledError:
                pass
    finally:
        sup.unsubscribe(camera_id, q)
        if not ws.closed:
            await ws.close()
    return ws


async def _ws_push(ws: web.WebSocketResponse, q: asyncio.Queue) -> None:
    while True:
        msg = await q.get()
        if ws.closed:
            return
        try:
            await ws.send_str(msg)
        except ConnectionResetError:
            return


# ---- augmentation config --------------------------------------------------

async def aug_config_get(request: web.Request) -> web.Response:
    db = request.app[CTX_DB]
    val = db.get_setting("augmentation_config")
    if val is None:
        from .augmentation import AugConfig
        return _json(AugConfig.default().to_dict())
    import json as _json_mod
    return _json(_json_mod.loads(val))


async def aug_config_put(request: web.Request) -> web.Response:
    db = request.app[CTX_DB]
    body = await _read_json(request)
    if isinstance(body, web.Response):
        return body
    from .augmentation import AugConfig
    import json as _json_mod
    try:
        cfg = AugConfig.from_dict(body)
    except Exception as exc:
        return _err(f"invalid config: {exc}")
    db.set_setting("augmentation_config", _json_mod.dumps(cfg.to_dict()))
    return _json(cfg.to_dict())


async def aug_regenerate(request: web.Request) -> web.Response:
    store = request.app[CTX_PERSONS]
    sup = request.app[CTX_SUPERVISOR]
    total = store.regenerate_augmented()
    sup.bump_index_version()
    return _json({"augmented_embeddings_created": total})


# ---- helpers --------------------------------------------------------------

async def _read_json(request: web.Request) -> dict | web.Response:
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return _err("invalid JSON body")
    if not isinstance(data, dict):
        return _err("expected JSON object")
    return data


# ---- app factory ----------------------------------------------------------

def make_app(config: Config) -> web.Application:
    app = web.Application(client_max_size=64 * 1024 * 1024)  # 64MB for photo uploads

    db = Database(config.db_path)
    recognizer = Recognizer(
        model_pack=config.model_pack,
        det_size=config.det_size,
        providers=config.providers,
    )
    persons = PersonStore(
        db=db,
        recognizer=recognizer,
        photos_dir=config.photos_dir,
        match_threshold=config.match_threshold,
    )
    supervisor = Supervisor(config)

    app[CTX_CONFIG] = config
    app[CTX_DB] = db
    app[CTX_PERSONS] = persons
    app[CTX_SUPERVISOR] = supervisor

    async def _on_startup(_app: web.Application) -> None:
        supervisor.start(asyncio.get_running_loop())

    async def _on_cleanup(_app: web.Application) -> None:
        supervisor.stop()
        db.close()

    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)

    app.add_routes([
        web.get("/health", health),

        web.get("/persons", persons_list),
        web.post("/persons", persons_create),
        web.get(r"/persons/{pid}", persons_get),
        web.patch(r"/persons/{pid}", persons_patch),
        web.delete(r"/persons/{pid}", persons_delete),

        web.get(r"/persons/{pid}/photos", photos_list),
        web.post(r"/persons/{pid}/photos", photos_upload),
        web.delete(r"/persons/{pid}/photos/{photo_id}", photos_delete),
        web.get(r"/persons/{pid}/photos/{photo_id}/raw", photos_raw),

        web.get("/cameras", cameras_list),
        web.post("/cameras", cameras_enable),
        web.delete(r"/cameras/{camera_id}", cameras_disable),
        web.get(r"/cameras/{camera_id}/ws", camera_ws),

        web.get("/augmentation/config", aug_config_get),
        web.put("/augmentation/config", aug_config_put),
        web.post("/augmentation/regenerate", aug_regenerate),
    ])

    return app
