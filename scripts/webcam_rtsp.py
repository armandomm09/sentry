#!/usr/bin/env python3
"""
Expose your computer's webcam as an RTSP stream you can add to Sentry.

Pipeline:
    avfoundation (macOS) / v4l2 (Linux) webcam
      -> ffmpeg (h264 encode)
      -> mediamtx RTSP server  ->  rtsp://localhost:8554/<path>

mediamtx is auto-downloaded into scripts/.cache/ on first run.

Usage:
    python3 scripts/webcam_rtsp.py
    python3 scripts/webcam_rtsp.py --device 1 --path frontdoor --port 8554
    python3 scripts/webcam_rtsp.py --list-devices
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import ssl
import tarfile
import time
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
CACHE_DIR = SCRIPT_DIR / ".cache"
MEDIAMTX_DIR = CACHE_DIR / "mediamtx"
MEDIAMTX_BIN = MEDIAMTX_DIR / "mediamtx"
MEDIAMTX_CONF = MEDIAMTX_DIR / "mediamtx.yml"


def die(msg: str, code: int = 1) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def require_ffmpeg() -> str:
    path = shutil.which("ffmpeg")
    if not path:
        die("ffmpeg not found on PATH. Install with `brew install ffmpeg`.")
    return path


def mediamtx_asset_name() -> str:
    sysname = platform.system().lower()
    machine = platform.machine().lower()
    if sysname == "darwin":
        os_part = "darwin"
        arch = "arm64" if machine in ("arm64", "aarch64") else "amd64"
    elif sysname == "linux":
        os_part = "linux"
        arch = "arm64" if machine in ("arm64", "aarch64") else "amd64"
    else:
        die(f"unsupported platform: {sysname}/{machine}")
    return f"mediamtx_{{version}}_{os_part}_{arch}.tar.gz"


def _http_get(url: str, accept: str | None = None) -> bytes:
    """GET a URL, falling back to system `curl` if Python's SSL trust store is empty
    (common on python.org installs on macOS)."""
    headers = {"User-Agent": "sentry-webcam-rtsp"}
    if accept:
        headers["Accept"] = accept
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    except (ssl.SSLError, urllib.error.URLError) as e:
        if not shutil.which("curl"):
            raise
        print(f"  (python SSL failed: {e}; falling back to curl)")
        cmd = ["curl", "-fsSL", url]
        if accept:
            cmd += ["-H", f"Accept: {accept}"]
        return subprocess.check_output(cmd)


def _http_download(url: str, dest: Path) -> None:
    try:
        urllib.request.urlretrieve(url, dest)
    except (ssl.SSLError, urllib.error.URLError) as e:
        if not shutil.which("curl"):
            raise
        print(f"  (python SSL failed: {e}; falling back to curl)")
        subprocess.check_call(["curl", "-fsSL", "-o", str(dest), url])


def latest_mediamtx_release() -> tuple[str, str]:
    """Return (version_tag, download_url) for the matching asset."""
    body = _http_get(
        "https://api.github.com/repos/bluenviron/mediamtx/releases/latest",
        accept="application/vnd.github+json",
    )
    data = json.loads(body)
    tag = data["tag_name"]
    pattern = mediamtx_asset_name().format(version=tag)
    for asset in data["assets"]:
        if asset["name"] == pattern:
            return tag, asset["browser_download_url"]
    die(f"no mediamtx asset matching {pattern} in release {tag}")


def ensure_mediamtx() -> Path:
    if MEDIAMTX_BIN.exists():
        return MEDIAMTX_BIN
    MEDIAMTX_DIR.mkdir(parents=True, exist_ok=True)
    print("Fetching mediamtx (one-time download)...")
    tag, url = latest_mediamtx_release()
    print(f"  {tag}  {url}")
    tarball = MEDIAMTX_DIR / "mediamtx.tar.gz"
    _http_download(url, tarball)
    with tarfile.open(tarball) as tf:
        tf.extractall(MEDIAMTX_DIR)
    tarball.unlink()
    if not MEDIAMTX_BIN.exists():
        die(f"extracted archive missing mediamtx binary at {MEDIAMTX_BIN}")
    MEDIAMTX_BIN.chmod(0o755)
    return MEDIAMTX_BIN


def write_mediamtx_config(rtsp_port: int) -> Path:
    # Minimal config: only RTSP enabled, all paths accepted.
    MEDIAMTX_CONF.write_text(
        "logLevel: warn\n"
        f"rtspAddress: :{rtsp_port}\n"
        "rtmp: no\n"
        "hls: no\n"
        "webrtc: no\n"
        "srt: no\n"
        "api: no\n"
        "paths:\n"
        "  all_others:\n"
    )
    return MEDIAMTX_CONF


def list_devices(ffmpeg: str) -> None:
    sysname = platform.system().lower()
    if sysname == "darwin":
        subprocess.run(
            [ffmpeg, "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
        )
    elif sysname == "linux":
        for dev in sorted(Path("/dev").glob("video*")):
            print(dev)
    else:
        die(f"unsupported platform: {sysname}")


def ffmpeg_capture_cmd(ffmpeg: str, device: str, rtsp_url: str, fps: int, size: str) -> list[str]:
    sysname = platform.system().lower()
    common_out = [
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-pix_fmt", 'uyvy422', #"yuv420p",
        "-g", str(fps * 2),
        "-an",
        "-f", "rtsp",
        "-rtsp_transport", "tcp",
        rtsp_url,
    ]
    if sysname == "darwin":
        return [
            ffmpeg, "-hide_banner", "-loglevel", "warning",
            "-f", "avfoundation",
            "-framerate", str(fps),
            "-video_size", size,
            "-i", f"{device}:none",
            *common_out,
        ]
    if sysname == "linux":
        dev_path = device if device.startswith("/dev/") else f"/dev/video{device}"
        return [
            ffmpeg, "-hide_banner", "-loglevel", "warning",
            "-f", "v4l2",
            "-framerate", str(fps),
            "-video_size", size,
            "-i", dev_path,
            *common_out,
        ]
    die(f"unsupported platform: {sysname}")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--device", default="0", help="camera device (macOS: avfoundation index, Linux: /dev/videoN or N). Default: 0")
    p.add_argument("--path", default="webcam", help="RTSP path. Default: webcam")
    p.add_argument("--port", type=int, default=8554, help="RTSP port. Default: 8554")
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--size", default="1280x720")
    p.add_argument("--list-devices", action="store_true", help="list cameras and exit")
    args = p.parse_args()

    ffmpeg = require_ffmpeg()

    if args.list_devices:
        list_devices(ffmpeg)
        return 0

    binary = ensure_mediamtx()
    conf = write_mediamtx_config(args.port)

    rtsp_publish = f"rtsp://127.0.0.1:{args.port}/{args.path}"

    print(f"Starting mediamtx on :{args.port} ...")
    mtx = subprocess.Popen(
        [str(binary), str(conf)],
        cwd=str(MEDIAMTX_DIR),
        stdout=sys.stdout,
        stderr=subprocess.STDOUT,
    )
    time.sleep(1.0)
    if mtx.poll() is not None:
        die(f"mediamtx exited immediately (code {mtx.returncode})")

    ff_cmd = ffmpeg_capture_cmd(ffmpeg, args.device, rtsp_publish, args.fps, args.size)
    print(f"Starting ffmpeg: device={args.device} size={args.size} fps={args.fps}")
    ff = subprocess.Popen(ff_cmd)

    # Show the URL the user should add in Sentry. On macOS, localhost works
    # because the Sentry backend ffmpeg runs on the same host.
    print()
    print("=" * 64)
    print(f"  RTSP URL for Sentry:  rtsp://127.0.0.1:{args.port}/{args.path}")
    print("=" * 64)
    print("Press Ctrl+C to stop.")

    def shutdown(*_):
        for proc in (ff, mtx):
            if proc.poll() is None:
                proc.terminate()
        for proc in (ff, mtx):
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # If either subprocess dies, take the other down too.
    while True:
        time.sleep(0.5)
        if ff.poll() is not None:
            print(f"ffmpeg exited (code {ff.returncode})", file=sys.stderr)
            shutdown()
        if mtx.poll() is not None:
            print(f"mediamtx exited (code {mtx.returncode})", file=sys.stderr)
            shutdown()


if __name__ == "__main__":
    sys.exit(main())
