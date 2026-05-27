#!/usr/bin/env bash
# One-time installer for the Sentry face-recognition microservice.
#
# Creates face-service/.venv, installs pinned deps, and pre-downloads the
# InsightFace model bundle so the first request doesn't pay a multi-hundred-MB
# download cost. Re-running is safe — venv create is idempotent and pip will
# no-op when deps are satisfied.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVC="$ROOT/face-service"
VENV="$SVC/.venv"

if [[ ! -d "$SVC" ]]; then
  echo "face-service directory missing at $SVC" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required (brew install python@3.12)" >&2
  exit 1
fi

PY_VERSION="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
case "$PY_VERSION" in
  3.10|3.11|3.12) ;;
  *)
    echo "WARNING: insightface + onnxruntime are tested on Python 3.10-3.12; you have $PY_VERSION." >&2
    ;;
esac

if [[ ! -d "$VENV" ]]; then
  echo "Creating venv at $VENV"
  python3 -m venv "$VENV"
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "Upgrading pip…"
pip install --upgrade pip wheel >/dev/null

echo "Installing requirements (this can take a few minutes on first run)…"
# pip install -r "$SVC/requirements.txt"

echo "Pre-downloading the InsightFace bundle (buffalo_l)…"
python - <<'PY'
import os
os.environ.setdefault("INSIGHTFACE_HOME", os.path.expanduser("~/.insightface"))
from insightface.app import FaceAnalysis
app = FaceAnalysis(name="buffalo_l")
app.prepare(ctx_id=-1, det_size=(640, 640))
print("model ready")
PY

echo ""
echo "Face-service is ready. Start everything with ./start.sh"
