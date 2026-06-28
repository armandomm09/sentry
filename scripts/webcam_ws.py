#!/usr/bin/env python3
"""WebSocket server that streams laptop webcam JPEG frames.

Sentry connects to this as a WebSocket CLIENT. Each binary message is one JPEG frame.

Usage:
    pip install websockets opencv-python
    python scripts/webcam_ws.py [--port PORT] [--fps FPS] [--quality QUALITY]

Then in the Sentry dashboard add a camera with URL:
    ws://localhost:8765     (or ws://<your-ip>:8765 from another machine)
"""

import argparse
import asyncio
import logging
import time

import cv2

log = logging.getLogger(__name__)


async def _serve(cap: cv2.VideoCapture, fps: int, quality: int, port: int) -> None:
    try:
        import websockets
    except ImportError:
        raise SystemExit("Install websockets: pip install websockets")

    clients: set = set()

    async def handler(ws) -> None:
        clients.add(ws)
        log.info("client connected: %s", ws.remote_address)
        try:
            await ws.wait_closed()
        finally:
            clients.discard(ws)
            log.info("client disconnected")

    async def capture_loop() -> None:
        interval = 1.0 / fps
        encode_params = [cv2.IMWRITE_JPEG_QUALITY, quality]
        while True:
            t0 = time.monotonic()
            ok, frame = cap.read()
            if not ok:
                log.warning("webcam read failed, retrying")
                await asyncio.sleep(0.1)
                continue

            _, buf = cv2.imencode(".jpg", frame, encode_params)
            data = buf.tobytes()

            if clients:
                results = await asyncio.gather(
                    *[ws.send(data) for ws in list(clients)],
                    return_exceptions=True,
                )
                for r in results:
                    if isinstance(r, Exception):
                        log.debug("send error: %s", r)

            elapsed = time.monotonic() - t0
            await asyncio.sleep(max(0.0, interval - elapsed))

    log.info("webcam WS server starting on ws://0.0.0.0:%d", port)
    log.info("add this URL to Sentry: ws://localhost:%d", port)

    async with websockets.serve(handler, "0.0.0.0", port):
        await capture_loop()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port",    type=int, default=8765, help="WebSocket server port (default: 8765)")
    ap.add_argument("--fps",     type=int, default=10,   help="Capture frame rate (default: 10)")
    ap.add_argument("--quality", type=int, default=75,   help="JPEG quality 1-100 (default: 75)")
    ap.add_argument("--camera",  type=int, default=0,    help="OpenCV camera index (default: 0)")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        raise SystemExit(f"Could not open camera {args.camera}")

    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    log.info("camera %d: %dx%d @ %dfps → ws://localhost:%d", args.camera, w, h, args.fps, args.port)

    try:
        asyncio.run(_serve(cap, args.fps, args.quality, args.port))
    except KeyboardInterrupt:
        pass
    finally:
        cap.release()
        log.info("stopped")


if __name__ == "__main__":
    main()
