"""Per-camera worker process.

Lifecycle:
  Parent supervisor spawns one Process(target=run_worker, args=...) per active
  camera. The worker:
    - connects to the Go relay WebSocket (/api/cameras/{id}/frames) as a client
    - receives JPEG frames as binary WebSocket messages
    - decodes each frame with cv2.imdecode and runs InsightFace inference
    - pushes detection events to out_queue for the supervisor to fan-out

  Communication with the parent:
    - fps_value (mp.Value 'd')     : target processing FPS, parent can change at runtime
    - index_version (mp.Value 'i') : bump from parent when persons/photos change
    - shutdown_event (mp.Event)    : set by parent to ask the worker to exit
    - out_queue (mp.Queue)         : worker pushes detection events to parent
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import time
from pathlib import Path

import cv2
import numpy as np

from .config import Config
from .db import Database
from .recognizer import MatchIndex, Recognizer


log = logging.getLogger(__name__)


def _load_index(db_path: str, threshold: float) -> MatchIndex:
    db = Database(Path(db_path))
    idx = MatchIndex(threshold=threshold)
    idx.rebuild(list(db.all_embeddings()))
    db.close()
    return idx


def run_worker(
    camera_id: str,
    config: Config,
    fps_value,       # mp.Value('d')
    index_version,   # mp.Value('i')
    shutdown_event,  # mp.Event
    out_queue,       # mp.Queue
) -> None:
    """Worker entrypoint. Runs until shutdown_event is set."""

    signal.signal(signal.SIGINT, signal.SIG_IGN)

    logging.basicConfig(
        level=os.environ.get("FACE_SERVICE_LOG_LEVEL", "INFO"),
        format=f"%(asctime)s [worker:{camera_id[:8]}] %(levelname)s %(message)s",
    )
    log.info("worker starting for camera %s", camera_id)

    asyncio.run(_run_async(camera_id, config, fps_value, index_version, shutdown_event, out_queue))
    log.info("worker exiting for camera %s", camera_id)


async def _run_async(
    camera_id: str,
    config: Config,
    fps_value,
    index_version,
    shutdown_event,
    out_queue,
) -> None:
    """Async main loop: connect to Go relay, receive frames, run inference."""
    import aiohttp

    relay_url = f"{config.relay_url}/api/cameras/{camera_id}/frames"
    log.info("will connect to relay at %s", relay_url)

    rec = Recognizer(
        model_pack=config.model_pack,
        det_size=config.det_size,
        providers=config.providers,
    )
    index_ref = [_load_index(str(config.db_path), config.match_threshold)]
    local_version = int(index_version.value)
    log.info("index loaded: %d prototypes (version=%d)", index_ref[0].size, local_version)

    while not shutdown_event.is_set():
        try:
            async with aiohttp.ClientSession() as session:
                ws = await session.ws_connect(
                    relay_url,
                    heartbeat=15,
                    timeout=aiohttp.ClientTimeout(total=None, connect=10),
                )
                log.info("connected to relay for camera %s", camera_id)
                try:
                    local_version = await _process_frames(
                        ws=ws,
                        camera_id=camera_id,
                        config=config,
                        rec=rec,
                        index_ref=index_ref,
                        local_version=local_version,
                        fps_value=fps_value,
                        index_version=index_version,
                        shutdown_event=shutdown_event,
                        out_queue=out_queue,
                    )
                finally:
                    await ws.close()
        except Exception as exc:
            log.warning("relay error for %s: %s", camera_id, exc)

        if shutdown_event.is_set():
            break
        log.info("relay lost for %s, reconnecting in 3s", camera_id)
        # Interruptible wait.
        for _ in range(30):
            if shutdown_event.is_set():
                break
            await asyncio.sleep(0.1)


async def _process_frames(
    *,
    ws,
    camera_id: str,
    config: Config,
    rec: Recognizer,
    index_ref: list[MatchIndex],
    local_version: int,
    fps_value,
    index_version,
    shutdown_event,
    out_queue,
) -> int:
    """Read frames from the WebSocket, decode, infer, emit events. Returns latest local_version."""
    import aiohttp

    last_processed = 0.0
    last_emit_empty = 0.0

    while not shutdown_event.is_set():
        try:
            msg = await asyncio.wait_for(ws.receive(), timeout=5.0)
        except asyncio.TimeoutError:
            continue

        if msg.type == aiohttp.WSMsgType.BINARY:
            data = msg.data
        elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
            log.info("relay ws closed for %s", camera_id)
            break
        else:
            continue

        # FPS throttling.
        now = time.monotonic()
        target_fps = max(0.1, float(fps_value.value))
        if now - last_processed < 1.0 / target_fps:
            continue

        # Decode JPEG to BGR.
        arr = np.frombuffer(data, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            continue

        frame_h, frame_w = frame.shape[:2]

        # Optionally downscale to config.frame_width for faster inference.
        if frame_w > config.frame_width:
            scale = config.frame_width / frame_w
            frame = cv2.resize(frame, (config.frame_width, int(frame_h * scale)))
            frame_h, frame_w = frame.shape[:2]

        # Hot-reload match index when parent bumps version.
        cur_ver = int(index_version.value)
        if cur_ver != local_version:
            log.info("reloading match index: %d -> %d", local_version, cur_ver)
            try:
                index_ref[0] = _load_index(str(config.db_path), config.match_threshold)
                local_version = cur_ver
            except Exception as exc:
                log.warning("index reload failed: %s", exc)

        last_processed = time.monotonic()

        try:
            faces = rec.detect(frame)
        except Exception as exc:
            log.warning("detect failed: %s", exc)
            continue

        detections = []
        index = index_ref[0]
        for f in faces:
            match = index.match(f.embedding) if f.embedding is not None else None
            x1, y1, x2, y2 = f.bbox
            detections.append({
                "bbox": [
                    max(0.0, x1 / frame_w),
                    max(0.0, y1 / frame_h),
                    min(1.0, x2 / frame_w),
                    min(1.0, y2 / frame_h),
                ],
                "score": round(f.score, 3),
                "person_id": match.person_id if match else None,
                "name": match.name if match else None,
                "similarity": round(match.similarity, 3) if match else None,
            })

        # Throttle empty-frame events so we don't spam the WS at idle FPS.
        if not detections and now - last_emit_empty < 0.5:
            continue
        if not detections:
            last_emit_empty = now

        event = {
            "type": "detections",
            "camera_id": camera_id,
            "ts": time.time(),
            "frame_w": frame_w,
            "frame_h": frame_h,
            "detections": detections,
        }
        try:
            out_queue.put_nowait(json.dumps(event))
        except Exception:
            pass  # queue full — drop

    return local_version
