# Tests

This tree separates two kinds of tests so the CI bot and a human at a laptop
don't trip over each other's expectations.

```
tests/
├── manual/   Interactive checks driven by a human (open a window, point a
│             webcam, click around). Never run in CI — they require physical
│             devices, GUI, or eyeballs.
└── ci/      Headless, deterministic tests safe for CI/CD pipelines. Empty
             for now; add unit + integration tests here as the project grows.
```

## Manual tests

### `manual/webcam_recognize.py`

End-to-end sanity check for the face-recognition stack without involving the Go
backend, ffmpeg, or HLS. It reads frames from the host webcam via OpenCV,
detects + identifies faces using the same `face_service` modules the production
worker uses, and draws boxes + names on a live OpenCV window.

Run from the project root:

```bash
./face-service/.venv/bin/python tests/manual/webcam_recognize.py
```

Useful flags:
- `--camera-index 1` — pick a non-default capture device
- `--threshold 0.4` — override the match threshold for ad-hoc tuning
- `--data-dir face-service/data` — point at a different photos+db dir
- `--fps 12` — cap processing rate (default 8)

Press `q` (or `Esc`) in the OpenCV window to exit.

Use this when:
- You enrolled a person and want to confirm the embedding actually identifies
  them on a real camera, independent of RTSP/ffmpeg/HLS.
- The bounding boxes don't show up in the dashboard and you want to isolate
  whether the recognizer or the streaming pipeline is at fault.
- You're tweaking the match threshold and want a quick A/B with your own face.
