"""Per-camera worker process.

Lifecycle:
  parent supervisor spawns one Process(target=run_worker, args=...) per active
  camera. The worker owns:
    - an ffmpeg subprocess that pulls RTSP and pipes BGR24 frames to stdout
    - its own Recognizer (loaded lazily on first frame)
    - a snapshot of the MatchIndex (rebuilt from the shared DB when version bumps)

  Communication with the parent is intentionally minimal:
    - fps_value (mp.Value 'd')     : target processing FPS, parent can change at runtime
    - index_version (mp.Value 'i') : bump from parent when persons/photos change
    - shutdown_event (mp.Event)    : set by parent to ask the worker to exit
    - out_queue (mp.Queue)         : worker pushes detection events to parent
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import threading
import time
from dataclasses import dataclass

import numpy as np

from .config import Config
from .db import Database
from .recognizer import MatchIndex, Recognizer


log = logging.getLogger(__name__)

# Frames are pulled from ffmpeg at this max rate. The worker then decides whether
# to process or skip each one based on the requested fps. Kept slightly above
# active_fps so the queue stays responsive when the parent bumps to active.
PIPE_FPS = 10


@dataclass
class FrameGeom:
    src_w: int
    src_h: int
    proc_w: int
    proc_h: int


def _ffprobe(rtsp_url: str) -> tuple[int, int] | None:
    """Probe RTSP source for native resolution. Returns (w, h) or None on failure."""
    try:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "error",
                "-rtsp_transport", "tcp",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "csv=p=0:s=x",
                rtsp_url,
            ],
            timeout=10,
        )
        w, h = out.decode().strip().split("x")
        return int(w), int(h)
    except (subprocess.SubprocessError, ValueError, FileNotFoundError) as e:
        log.warning("ffprobe failed for %s: %s", rtsp_url, e)
        return None


def _read_exact(stream, n: int, shutdown_event) -> bytes | None:
    """Read exactly n bytes from a binary stream, or return None on EOF/shutdown.

    The default Popen pipe is a BufferedReader and `read(n)` is supposed to
    block until n bytes are available, but it can still return short on signals
    or if the underlying pipe is closed. Looping makes the contract explicit and
    keeps the stream-end check unambiguous (None == upstream closed).
    """
    buf = bytearray()
    while len(buf) < n:
        if shutdown_event.is_set():
            return None
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def _start_stderr_pump(proc: subprocess.Popen, camera_id: str, log: logging.Logger) -> None:
    """Drain ffmpeg stderr into our log so failures aren't invisible."""
    stderr = proc.stderr
    if stderr is None:
        return

    def pump() -> None:
        try:
            for raw in iter(stderr.readline, b""):
                line = raw.decode("utf-8", errors="replace").rstrip()
                if line:
                    log.warning("ffmpeg: %s", line)
        except Exception:
            pass

    t = threading.Thread(
        target=pump, name=f"ffmpeg-stderr-{camera_id[:8]}", daemon=True,
    )
    t.start()


def _ffmpeg_command(rtsp_url: str, geom: FrameGeom) -> list[str]:
    return [
        "ffmpeg",
        "-loglevel", "error",
        "-rtsp_transport", "tcp",
        "-fflags", "nobuffer",
        "-i", rtsp_url,
        "-an",
        "-vf", f"scale={geom.proc_w}:{geom.proc_h},fps={PIPE_FPS}",
        "-f", "rawvideo",
        "-pix_fmt", "bgr24",
        "pipe:1",
    ]


def _resolve_geometry(rtsp_url: str, target_w: int) -> FrameGeom:
    """Pick processing dims that preserve the source aspect ratio."""
    probed = _ffprobe(rtsp_url)
    if probed is None:
        # fallback: assume 16:9 — bbox overlay will be slightly off for other
        # aspect ratios but that's a recoverable cosmetic issue.
        src_w, src_h = 1280, 720
    else:
        src_w, src_h = probed

    proc_w = target_w
    # round to even — many encoders/decoders require it
    proc_h = max(2, int(round(src_h * (proc_w / src_w))) & ~1)
    return FrameGeom(src_w=src_w, src_h=src_h, proc_w=proc_w, proc_h=proc_h)


def _load_index(db_path: str, threshold: float) -> MatchIndex:
    db = Database(__import__("pathlib").Path(db_path))
    idx = MatchIndex(threshold=threshold)
    idx.rebuild(list(db.all_embeddings()))
    db.close()
    return idx


def run_worker(
    camera_id: str,
    rtsp_url: str,
    config: Config,
    fps_value,           # mp.Value('d')
    index_version,       # mp.Value('i')
    shutdown_event,      # mp.Event
    out_queue,           # mp.Queue
) -> None:
    """Worker entrypoint. Runs until shutdown_event is set or unrecoverable error."""

    # Ignore SIGINT in worker so Ctrl-C in parent shuts us down via shutdown_event.
    signal.signal(signal.SIGINT, signal.SIG_IGN)

    logging.basicConfig(
        level=os.environ.get("FACE_SERVICE_LOG_LEVEL", "INFO"),
        format=f"%(asctime)s [worker:{camera_id[:8]}] %(levelname)s %(message)s",
    )
    log = logging.getLogger(f"worker.{camera_id[:8]}")
    log.info("starting worker for camera %s", camera_id)

    rec = Recognizer(
        model_pack=config.model_pack,
        det_size=config.det_size,
        providers=config.providers,
    )
    index = _load_index(str(config.db_path), config.match_threshold)
    local_version = int(index_version.value)
    log.info("initial index loaded with %d prototypes (version=%d)", index.size, local_version)

    geom = _resolve_geometry(rtsp_url, config.frame_width)
    log.info(
        "frame geometry: source=%dx%d processing=%dx%d",
        geom.src_w, geom.src_h, geom.proc_w, geom.proc_h,
    )

    frame_size = geom.proc_w * geom.proc_h * 3  # bgr24
    reconnect_delay = 3.0

    while not shutdown_event.is_set():
        proc = subprocess.Popen(
            _ffmpeg_command(rtsp_url, geom),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        log.info("ffmpeg started (pid=%d)", proc.pid)
        # Drain stderr in a daemon thread so a chatty ffmpeg never deadlocks the
        # pipe, and we can actually surface its error messages to our log.
        _start_stderr_pump(proc, camera_id, log)

        try:
            _read_loop(
                camera_id=camera_id,
                proc=proc,
                geom=geom,
                frame_size=frame_size,
                rec=rec,
                index_ref=[index],   # mutable holder so reloads propagate
                index_version=index_version,
                local_version_ref=[local_version],
                config=config,
                fps_value=fps_value,
                shutdown_event=shutdown_event,
                out_queue=out_queue,
                log=log,
            )
        except Exception as e:
            log.warning("read loop crashed: %s", e)

        # cleanup ffmpeg
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        proc.wait(timeout=5)

        if shutdown_event.is_set():
            break
        log.info("ffmpeg exited, reconnecting in %.1fs", reconnect_delay)
        # interruptible wait
        for _ in range(int(reconnect_delay * 10)):
            if shutdown_event.is_set():
                break
            time.sleep(0.1)

    log.info("worker exiting cleanly")


def _read_loop(
    *,
    camera_id: str,
    proc: subprocess.Popen,
    geom: FrameGeom,
    frame_size: int,
    rec: Recognizer,
    index_ref: list[MatchIndex],
    index_version,
    local_version_ref: list[int],
    config: Config,
    fps_value,
    shutdown_event,
    out_queue,
    log: logging.Logger,
) -> None:
    """Read frames from ffmpeg stdout, drop most of them, run model on the rest."""
    stdout = proc.stdout
    assert stdout is not None

    last_processed = 0.0
    last_emit_empty = 0.0
    while not shutdown_event.is_set():
        if proc.poll() is not None:
            log.info("ffmpeg ended (rc=%s)", proc.returncode)
            return

        chunk = _read_exact(stdout, frame_size, shutdown_event)
        if chunk is None:
            log.info("ffmpeg stream ended")
            return

        now = time.monotonic()
        target_fps = max(0.1, float(fps_value.value))
        min_interval = 1.0 / target_fps
        if now - last_processed < min_interval:
            continue

        # hot-reload of match index when parent bumps version
        cur_ver = int(index_version.value)
        if cur_ver != local_version_ref[0]:
            log.info("reloading match index: %d -> %d", local_version_ref[0], cur_ver)
            try:
                new_idx = _load_index(str(config.db_path), config.match_threshold)
                index_ref[0] = new_idx
                local_version_ref[0] = cur_ver
            except Exception as e:
                log.warning("index reload failed: %s", e)

        frame = np.frombuffer(chunk, dtype=np.uint8).reshape((geom.proc_h, geom.proc_w, 3))
        last_processed = now

        try:
            faces = rec.detect(frame)
        except Exception as e:
            log.warning("detect failed: %s", e)
            continue

        detections = []
        index = index_ref[0]
        for f in faces:
            match = index.match(f.embedding) if f.embedding is not None else None
            x1, y1, x2, y2 = f.bbox
            detections.append({
                "bbox": [
                    max(0.0, x1 / geom.proc_w),
                    max(0.0, y1 / geom.proc_h),
                    min(1.0, x2 / geom.proc_w),
                    min(1.0, y2 / geom.proc_h),
                ],
                "score": round(f.score, 3),
                "person_id": match.person_id if match else None,
                "name": match.name if match else None,
                "similarity": round(match.similarity, 3) if match else None,
            })

        # Throttle empty-frame events: they're useful so the overlay clears, but we
        # don't need to spam the WS at idle FPS when nothing's there.
        if not detections and now - last_emit_empty < 0.5:
            continue
        if not detections:
            last_emit_empty = now

        event = {
            "type": "detections",
            "camera_id": camera_id,
            "ts": time.time(),
            "frame_w": geom.proc_w,
            "frame_h": geom.proc_h,
            "detections": detections,
        }
        try:
            out_queue.put_nowait(json.dumps(event))
        except Exception:
            # queue full — supervisor is backed up; drop this frame's event.
            pass
