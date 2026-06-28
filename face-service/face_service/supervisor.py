"""Worker-pool supervisor + detection pubsub.

Holds one WorkerHandle per active camera. Each handle owns the mp.Process and the
shared mp primitives the parent uses to talk to it. The supervisor also runs a
background thread that drains the shared output queue and hands events off to an
asyncio pubsub so WebSocket clients can subscribe per camera.
"""

from __future__ import annotations

import asyncio
import json
import logging
import multiprocessing as mp
import threading
import time
from dataclasses import dataclass, field

from .config import Config
from .worker import run_worker


log = logging.getLogger(__name__)

# Bound the cross-process queue so a stuck WS subscriber can't cause unbounded
# memory growth in the parent.
QUEUE_CAPACITY = 256


@dataclass
class WorkerHandle:
    camera_id: str
    process: mp.Process
    fps_value: "mp.sharedctypes.Synchronized"
    index_version: "mp.sharedctypes.Synchronized"
    shutdown_event: mp.synchronize.Event
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    started_at: float = field(default_factory=time.time)

    @property
    def subscriber_count(self) -> int:
        return len(self.subscribers)

    @property
    def alive(self) -> bool:
        return self.process.is_alive()


class Supervisor:
    """Owns the worker pool and pubsub. All public methods are safe to call from
    the asyncio thread; cross-thread coordination is handled internally.
    """

    def __init__(self, config: Config):
        self._config = config
        self._workers: dict[str, WorkerHandle] = {}
        self._workers_lock = threading.RLock()
        self._mp_ctx = mp.get_context("spawn")
        self._out_queue: mp.Queue = self._mp_ctx.Queue(maxsize=QUEUE_CAPACITY * 4)
        self._index_version_global = 0
        self._loop: asyncio.AbstractEventLoop | None = None
        self._reader_thread: threading.Thread | None = None
        self._stopping = False

    # ---- lifecycle --------------------------------------------------------

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._reader_thread = threading.Thread(
            target=self._drain_queue, name="face-supervisor-reader", daemon=True,
        )
        self._reader_thread.start()
        log.info("supervisor reader thread started")

    def stop(self) -> None:
        self._stopping = True
        with self._workers_lock:
            for h in list(self._workers.values()):
                self._terminate(h)
            self._workers.clear()
        log.info("supervisor stopped")

    # ---- worker management ------------------------------------------------

    def list_cameras(self) -> list[dict]:
        with self._workers_lock:
            return [
                {
                    "camera_id": h.camera_id,
                    "alive": h.alive,
                    "fps": float(h.fps_value.value),
                    "subscribers": h.subscriber_count,
                    "started_at": h.started_at,
                }
                for h in self._workers.values()
            ]

    def is_running(self, camera_id: str) -> bool:
        with self._workers_lock:
            h = self._workers.get(camera_id)
            return bool(h and h.alive)

    def start_camera(self, camera_id: str) -> None:
        """Start a worker for this camera. No-op if already running.
        The worker connects to the Go relay WebSocket — no source URL needed here.
        """
        with self._workers_lock:
            existing = self._workers.get(camera_id)
            if existing and existing.alive:
                return  # already running

            fps = self._mp_ctx.Value("d", self._config.idle_fps)
            version = self._mp_ctx.Value("i", self._index_version_global)
            shutdown = self._mp_ctx.Event()

            proc = self._mp_ctx.Process(
                target=run_worker,
                name=f"face-worker-{camera_id[:8]}",
                args=(camera_id, self._config, fps, version, shutdown, self._out_queue),
                daemon=True,
            )
            proc.start()
            handle = WorkerHandle(
                camera_id=camera_id,
                process=proc,
                fps_value=fps,
                index_version=version,
                shutdown_event=shutdown,
            )
            self._workers[camera_id] = handle
            log.info("started worker for camera %s (pid=%d)", camera_id, proc.pid)

    def stop_camera(self, camera_id: str) -> None:
        with self._workers_lock:
            h = self._workers.pop(camera_id, None)
            if h is None:
                return
            self._terminate(h)
            # don't drop subscribers; let them get a closed event from the WS layer
            log.info("stopped worker for camera %s", camera_id)

    def _terminate(self, h: WorkerHandle) -> None:
        h.shutdown_event.set()
        h.process.join(timeout=3)
        if h.process.is_alive():
            log.warning("worker %s did not stop in time, terminating", h.camera_id)
            h.process.terminate()
            h.process.join(timeout=3)
        if h.process.is_alive():
            h.process.kill()

    # ---- match-index versioning ------------------------------------------

    def bump_index_version(self) -> None:
        """Signal all live workers to reload the match index from SQLite."""
        with self._workers_lock:
            self._index_version_global += 1
            for h in self._workers.values():
                h.index_version.value = self._index_version_global

    # ---- viewer-attached / FPS gating -------------------------------------

    def subscribe(self, camera_id: str) -> asyncio.Queue:
        """Create a subscriber queue and bump FPS to active mode while attached."""
        q: asyncio.Queue = asyncio.Queue(maxsize=128)
        with self._workers_lock:
            h = self._workers.get(camera_id)
            if h is None:
                # Not running — caller (WS handler) will close with an error.
                # We still return the queue so subscribe/unsubscribe contract holds.
                return q
            h.subscribers.add(q)
            self._refresh_fps_locked(h)
        return q

    def unsubscribe(self, camera_id: str, q: asyncio.Queue) -> None:
        with self._workers_lock:
            h = self._workers.get(camera_id)
            if h is None:
                return
            h.subscribers.discard(q)
            self._refresh_fps_locked(h)

    def _refresh_fps_locked(self, h: WorkerHandle) -> None:
        target = self._config.active_fps if h.subscribers else self._config.idle_fps
        if abs(h.fps_value.value - target) > 0.01:
            h.fps_value.value = target
            log.info(
                "camera %s fps -> %.1f (subscribers=%d)",
                h.camera_id, target, len(h.subscribers),
            )

    # ---- queue draining ---------------------------------------------------

    def _drain_queue(self) -> None:
        """Background thread: read from mp.Queue, dispatch into asyncio pubsub."""
        while not self._stopping:
            try:
                msg = self._out_queue.get(timeout=0.5)
            except Exception:
                continue
            if self._loop is None:
                continue
            try:
                event = json.loads(msg)
            except json.JSONDecodeError:
                continue
            camera_id = event.get("camera_id")
            if not camera_id:
                continue
            asyncio.run_coroutine_threadsafe(
                self._fanout(camera_id, msg), self._loop,
            )

    async def _fanout(self, camera_id: str, msg: str) -> None:
        with self._workers_lock:
            h = self._workers.get(camera_id)
            if h is None:
                return
            queues = list(h.subscribers)
        for q in queues:
            if q.full():
                # slow subscriber — drop the oldest to keep up
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                pass
