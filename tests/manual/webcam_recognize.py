"""Manual end-to-end test for the Sentry face-recognition stack.

Reads frames from the local webcam (OpenCV's VideoCapture), runs detection +
matching using the exact same `face_service` modules the production worker
process uses, and overlays bounding boxes + names on a live preview window.

Why this exists: when something fails in the dashboard ("I see my feed but no
boxes"), it can be ambiguous whether the bug is in the recognizer, the
streaming pipeline (ffmpeg/RTSP/HLS), or the WebSocket overlay. This script
exercises only the recognizer path against a known-good input (your laptop
camera) and isolates that variable.

Run from project root:

    ./face-service/.venv/bin/python tests/manual/webcam_recognize.py

Press 'q' or Esc to quit.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

import cv2

# Make the face_service package importable regardless of cwd.
REPO_ROOT = Path(__file__).resolve().parents[2]
SVC_ROOT = REPO_ROOT / "face-service"
sys.path.insert(0, str(SVC_ROOT))

from face_service.db import Database  # noqa: E402
from face_service.recognizer import MatchIndex, Recognizer  # noqa: E402

log = logging.getLogger("webcam-test")


# Match the visual language of the dashboard overlay: green for known faces,
# DIM red for unknowns. Keeping these in sync makes debugging less confusing.
COLOR_MATCH_BGR = (119, 217, 56)   # #38d977
COLOR_UNKNOWN_BGR = (41, 58, 232)  # #e83a29


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Webcam face-recognition sanity check")
    p.add_argument("--camera-index", type=int, default=0,
                   help="OpenCV VideoCapture index (default 0)")
    p.add_argument("--data-dir", type=Path, default=SVC_ROOT / "data",
                   help="face-service data dir (contains face.db + photos/)")
    p.add_argument("--threshold", type=float, default=0.42,
                   help="Cosine similarity threshold for a match (default 0.42)")
    p.add_argument("--det-size", type=int, default=640,
                   help="InsightFace detection input edge")
    p.add_argument("--fps", type=float, default=8.0,
                   help="Max processing FPS (default 8)")
    p.add_argument("--mirror", action="store_true",
                   help="Horizontally flip frames (selfie mode)")
    p.add_argument("--width", type=int, default=1280, help="Capture width")
    p.add_argument("--height", type=int, default=720, help="Capture height")
    return p.parse_args()


def open_camera(index: int, width: int, height: int) -> cv2.VideoCapture:
    cap = cv2.VideoCapture(index)
    if not cap.isOpened():
        raise SystemExit(
            f"Could not open camera index {index}. "
            "On macOS, the terminal app needs Camera permission "
            "(System Settings → Privacy & Security → Camera)."
        )
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    return cap


def load_index(db_path: Path, threshold: float) -> MatchIndex:
    db = Database(db_path)
    idx = MatchIndex(threshold=threshold)
    idx.rebuild(list(db.all_embeddings()))
    db.close()
    return idx


def draw_overlay(frame, faces, index: MatchIndex) -> None:
    h, w = frame.shape[:2]
    for f in faces:
        match = index.match(f.embedding) if f.embedding is not None else None
        x1, y1, x2, y2 = (int(v) for v in f.bbox)
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w - 1, x2), min(h - 1, y2)

        color = COLOR_MATCH_BGR if match else COLOR_UNKNOWN_BGR
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)

        if match:
            label = f"{match.name}  {int(match.similarity * 100)}%"
        else:
            label = f"Unknown  {int(f.score * 100)}%"

        # Filled label strip above the box (or below if there's no room above).
        (tw, th), baseline = cv2.getTextSize(
            label, cv2.FONT_HERSHEY_DUPLEX, 0.55, 1,
        )
        pad = 4
        ly1 = y1 - th - 2 * pad
        ly2 = y1
        if ly1 < 0:
            ly1 = y2
            ly2 = y2 + th + 2 * pad
        cv2.rectangle(frame, (x1, ly1), (x1 + tw + 2 * pad, ly2), color, -1)
        cv2.putText(
            frame, label, (x1 + pad, ly2 - pad - baseline // 2),
            cv2.FONT_HERSHEY_DUPLEX, 0.55, (12, 12, 12), 1, cv2.LINE_AA,
        )


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    db_path = args.data_dir / "face.db"
    if not db_path.is_file():
        log.error("face.db not found at %s — enroll someone first", db_path)
        return 1

    log.info("loading match index from %s", db_path)
    index = load_index(db_path, args.threshold)
    log.info("loaded %d person prototype(s)", index.size)
    if index.size == 0:
        log.warning(
            "no prototypes loaded — every face will show as Unknown. "
            "Enroll someone via the dashboard or POST a photo to face-service."
        )

    log.info("loading InsightFace (first call downloads/loads the model)…")
    rec = Recognizer(
        model_pack="buffalo_l",
        det_size=args.det_size,
        providers=("CoreMLExecutionProvider", "CPUExecutionProvider"),
    )
    # Force eager load with a tiny dummy frame so model-load latency happens
    # before we start the camera loop.
    import numpy as np
    rec.detect(np.zeros((64, 64, 3), dtype=np.uint8))
    log.info("model ready")

    cap = open_camera(args.camera_index, args.width, args.height)
    win = "Sentry — webcam recognition test"
    cv2.namedWindow(win, cv2.WINDOW_AUTOSIZE)

    min_interval = 1.0 / max(args.fps, 0.5)
    last_process = 0.0
    last_faces = []  # type: list
    fps_ema = 0.0
    frames = 0

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                log.warning("camera read failed; retrying")
                time.sleep(0.1)
                continue
            if args.mirror:
                frame = cv2.flip(frame, 1)

            now = time.monotonic()
            if now - last_process >= min_interval:
                t0 = time.monotonic()
                try:
                    last_faces = rec.detect(frame)
                except Exception as e:
                    log.exception("detect failed: %s", e)
                    last_faces = []
                dt = time.monotonic() - t0
                inst_fps = 1.0 / dt if dt > 0 else 0.0
                fps_ema = inst_fps if fps_ema == 0 else (0.9 * fps_ema + 0.1 * inst_fps)
                last_process = now

            draw_overlay(frame, last_faces, index)

            # HUD: model fps, prototype count, threshold
            hud = (
                f"model {fps_ema:5.1f} fps   "
                f"prototypes {index.size}   "
                f"threshold {args.threshold:.2f}"
            )
            cv2.putText(
                frame, hud, (12, frame.shape[0] - 14),
                cv2.FONT_HERSHEY_DUPLEX, 0.5, (240, 240, 240), 1, cv2.LINE_AA,
            )

            cv2.imshow(win, frame)
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):  # q or Esc
                break
            frames += 1
    finally:
        cap.release()
        cv2.destroyAllWindows()
    log.info("exited after %d frames", frames)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
