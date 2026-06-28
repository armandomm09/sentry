#!/usr/bin/env python3
"""WebSocket server that streams laptop webcam JPEG frames.

Uses aiohttp (already installed in the face-service venv).
Sentry connects to this server as a WebSocket client.
Each binary message = one JPEG frame.

Run with:
    ./face-service/.venv/bin/python scripts/webcam_ws.py

Then add a camera in Sentry with URL:
    ws://localhost:8765
"""

import argparse
import asyncio
import logging
import time

import cv2
from aiohttp import web

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

clients: set[web.WebSocketResponse] = set()


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    clients.add(ws)
    log.info("client connected: %s", request.remote)
    try:
        async for _ in ws:
            pass  # drain any client messages; we only send
    finally:
        clients.discard(ws)
        log.info("client disconnected: %s", request.remote)
    return ws


async def capture_loop(cap: cv2.VideoCapture, fps: int, quality: int) -> None:
    interval = 1.0 / fps
    params = [cv2.IMWRITE_JPEG_QUALITY, quality]
    frame_count = 0
    while True:
        t0 = time.monotonic()
        ok, frame = cap.read()
        if not ok:
            log.warning("webcam read failed, retrying")
            await asyncio.sleep(0.1)
            continue

        _, buf = cv2.imencode(".jpg", frame, params)
        data = buf.tobytes()
        frame_count += 1

        if clients:
            results = await asyncio.gather(
                *[ws.send_bytes(data) for ws in list(clients)],
                return_exceptions=True,
            )
            for r in results:
                if isinstance(r, Exception):
                    log.debug("send error: %s", r)

        if frame_count % (fps * 5) == 0:
            log.info("streaming: frame %d  %d bytes  %d client(s)", frame_count, len(data), len(clients))

        elapsed = time.monotonic() - t0
        await asyncio.sleep(max(0.0, interval - elapsed))


async def run(port: int, fps: int, quality: int, camera_idx: int) -> None:
    cap = cv2.VideoCapture(camera_idx)
    if not cap.isOpened():
        raise SystemExit(f"Could not open camera {camera_idx}")

    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    log.info("camera %d: %dx%d", camera_idx, w, h)
    log.info("WS server starting on ws://0.0.0.0:%d/", port)
    log.info("Add to Sentry dashboard:  ws://localhost:%d", port)

    app = web.Application()
    app.router.add_get("/", ws_handler)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()

    try:
        await capture_loop(cap, fps, quality)
    finally:
        cap.release()
        await runner.cleanup()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port",    type=int, default=8765, help="WebSocket port (default: 8765)")
    ap.add_argument("--fps",     type=int, default=10,   help="Capture FPS (default: 10)")
    ap.add_argument("--quality", type=int, default=75,   help="JPEG quality 1-100 (default: 75)")
    ap.add_argument("--camera",  type=int, default=0,    help="Camera index (default: 0)")
    args = ap.parse_args()

    try:
        asyncio.run(run(args.port, args.fps, args.quality, args.camera))
    except KeyboardInterrupt:
        log.info("stopped")


if __name__ == "__main__":
    main()
