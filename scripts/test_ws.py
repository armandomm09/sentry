#!/usr/bin/env python3
"""Connect to a WebSocket frame server and print live stats.

Use this to verify that a WebSocket source is sending frames.

Works with:
  - The webcam_ws.py test server
  - Sentry's relay endpoint for a camera

Usage:
    # Test the webcam server directly:
    ./face-service/.venv/bin/python scripts/test_ws.py ws://localhost:8765

    # Test Sentry's relay for a camera:
    ./face-service/.venv/bin/python scripts/test_ws.py ws://localhost:8080/api/cameras/<id>/frames
"""

import asyncio
import sys
import time

import aiohttp


async def main(url: str) -> None:
    print(f"Connecting to {url} ...")
    try:
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(url, timeout=aiohttp.ClientTimeout(connect=5, total=None)) as ws:
                print("Connected! Receiving frames — press Ctrl-C to stop.\n")
                count = 0
                t0 = time.monotonic()
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.BINARY:
                        count += 1
                        elapsed = time.monotonic() - t0
                        fps = count / elapsed if elapsed > 0 else 0.0
                        print(f"  frame {count:5d}  {len(msg.data):8,} bytes  {fps:5.1f} fps", end="\r", flush=True)
                    elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                        print(f"\nConnection closed: {msg.type}")
                        break
    except aiohttp.ClientConnectorError:
        print(f"ERROR: could not connect to {url}")
        print("  - Is the server running?")
        print("  - Is the URL correct (ws:// not http://)?")
        sys.exit(1)
    except Exception as e:
        print(f"\nERROR: {e}")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    try:
        asyncio.run(main(sys.argv[1]))
    except KeyboardInterrupt:
        print("\nStopped.")
