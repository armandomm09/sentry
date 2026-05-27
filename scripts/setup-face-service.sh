#!/usr/bin/env bash
# One-time installer for the Sentry face-recognition microservice.
#
# Creates face-service/.venv and installs ONNX Runtime + InsightFace + helpers.
# By default it auto-detects the platform and picks CPU or GPU:
#
#   macOS arm64                  -> CPU (CoreML EP picks up automatically)
#   Linux x86_64 + NVIDIA GPU    -> onnxruntime-gpu from PyPI
#   Linux aarch64 + NVIDIA GPU   -> onnxruntime-gpu from NVIDIA's pip index
#                                   (PyPI has no aarch64 wheel; see below)
#   Anything else                -> CPU
#
# Override with --mode cpu | gpu, e.g. `./scripts/setup-face-service.sh --mode gpu`.
#
# On aarch64 + CUDA (DGX Spark, Jetson Thor, Grace Hopper) the GPU wheel comes
# from a NVIDIA-maintained pip index. Default is jetson-ai-lab.dev's CUDA 12.6
# SBSA channel; override via FACE_SERVICE_ORT_INDEX_URL or --gpu-index-url.
#
# Re-running is safe: venv creation is idempotent and pip will no-op when deps
# are already satisfied.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVC="$ROOT/face-service"
VENV="$SVC/.venv"

# --- args ------------------------------------------------------------------
MODE="auto"                 # auto | cpu | gpu
GPU_INDEX_URL="${FACE_SERVICE_ORT_INDEX_URL:-https://pypi.jetson-ai-lab.dev/sbsa/cu126}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)            MODE="$2"; shift 2 ;;
    --gpu-index-url)   GPU_INDEX_URL="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -d "$SVC" ]]; then
  echo "face-service directory missing at $SVC" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required (on Ubuntu: sudo apt install python3 python3-venv)" >&2
  exit 1
fi

PY_VERSION="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
case "$PY_VERSION" in
  3.10|3.11|3.12) ;;
  *)
    echo "WARNING: insightface + onnxruntime are tested on Python 3.10-3.12; you have $PY_VERSION." >&2
    ;;
esac

# --- platform detection ----------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
HAS_NVIDIA=0
if command -v nvidia-smi >/dev/null 2>&1; then
  if nvidia-smi -L >/dev/null 2>&1; then HAS_NVIDIA=1; fi
fi

if [[ "$MODE" == "auto" ]]; then
  if [[ "$OS" == "Linux" && "$HAS_NVIDIA" -eq 1 ]]; then
    MODE="gpu"
  else
    MODE="cpu"
  fi
fi

# --- venv ------------------------------------------------------------------
if [[ ! -d "$VENV" ]]; then
  echo "Creating venv at $VENV"
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "Upgrading pip…"
pip install --upgrade pip wheel >/dev/null

# --- base install (CPU ORT + everything else) ------------------------------
echo "Installing base requirements (CPU ORT + InsightFace + aiohttp)…"
pip install -r "$SVC/requirements.txt"

# --- optional GPU layer ----------------------------------------------------
GPU_INSTALLED=0
if [[ "$MODE" == "gpu" ]]; then
  case "$OS-$ARCH" in
    Linux-x86_64)
      echo "Installing onnxruntime-gpu (PyPI, x86_64)…"
      # `onnxruntime-gpu` replaces `onnxruntime` in the same env. pip handles
      # the conflict because both packages provide the `onnxruntime` import.
      pip install -r "$SVC/requirements-gpu-x86_64.txt"
      GPU_INSTALLED=1
      ;;
    Linux-aarch64)
      echo "Installing onnxruntime-gpu for aarch64 from $GPU_INDEX_URL"
      echo "  (PyPI has no aarch64+CUDA wheel for ORT; using NVIDIA pip mirror)"
      if pip install --extra-index-url "$GPU_INDEX_URL" \
           -r "$SVC/requirements-gpu-aarch64.txt"; then
        GPU_INSTALLED=1
      else
        echo
        echo "  GPU install failed. Common fixes:" >&2
        echo "    - point at a different CUDA version of the mirror, e.g." >&2
        echo "        FACE_SERVICE_ORT_INDEX_URL=https://pypi.jetson-ai-lab.dev/sbsa/cu130 \\" >&2
        echo "          ./scripts/setup-face-service.sh --mode gpu" >&2
        echo "    - or drop a wheel into ./vendor/ and run:" >&2
        echo "        pip install ./vendor/onnxruntime_gpu-*.whl" >&2
        echo
        echo "  Falling back to CPU ORT. Re-run with --mode gpu once a wheel works."
      fi
      ;;
    Darwin-*)
      echo "macOS detected — CoreML EP comes built-in with the CPU wheel; nothing extra to install."
      ;;
    *)
      echo "WARNING: --mode gpu requested on unsupported platform ($OS-$ARCH); staying on CPU." >&2
      ;;
  esac
fi

# --- model pre-warm --------------------------------------------------------
echo "Pre-downloading the InsightFace bundle (buffalo_l)…"
python - <<'PY'
import os
os.environ.setdefault("INSIGHTFACE_HOME", os.path.expanduser("~/.insightface"))
from insightface.app import FaceAnalysis
app = FaceAnalysis(name="buffalo_l")
app.prepare(ctx_id=-1, det_size=(640, 640))
print("model ready")
PY

# --- summary ---------------------------------------------------------------
echo
echo "Face-service is ready."
echo "  Platform:           $OS-$ARCH"
echo "  Mode requested:     $MODE"
if [[ "$GPU_INSTALLED" -eq 1 ]]; then
  echo "  ONNX Runtime:       GPU (CUDA EP available)"
else
  echo "  ONNX Runtime:       CPU"
fi
echo
echo "Start everything with ./start.sh"
