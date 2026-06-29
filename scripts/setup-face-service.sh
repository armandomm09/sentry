#!/usr/bin/env bash
# One-time installer for the Sentry face-recognition microservice.
#
# Creates face-service/.venv and installs ONNX Runtime + InsightFace + helpers.
# By default it auto-detects the platform and picks CPU or GPU:
#
#   macOS arm64                  -> CPU (CoreML EP picks up automatically)
#   Linux x86_64 + NVIDIA GPU    -> onnxruntime-gpu from PyPI
#   Linux aarch64 + NVIDIA GPU   -> onnxruntime-gpu wheel from Ultralytics GitHub
#                                   (PyPI has no aarch64 wheel; NVIDIA's pip index
#                                    pypi.jetson-ai-lab.dev is defunct/NXDOMAIN)
#   Anything else                -> CPU
#
# Override with --mode cpu | gpu, e.g. `./scripts/setup-face-service.sh --mode gpu`.
#
# Re-running is safe: venv creation is idempotent and pip will no-op when deps
# are already satisfied.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVC="$ROOT/face-service"
VENV="$SVC/.venv"

# --- args ------------------------------------------------------------------
MODE="auto"                 # auto | cpu | gpu

# aarch64 GPU wheel: onnxruntime-gpu built for CUDA 12 + Python 3.12 + linux_aarch64
# Hosted on GitHub (Ultralytics assets). pypi.jetson-ai-lab.dev is defunct (NXDOMAIN).
ORT_AARCH64_WHEEL_URL="${FACE_SERVICE_ORT_WHEEL_URL:-https://github.com/ultralytics/assets/releases/download/v0.0.0/onnxruntime_gpu-1.24.0-cp312-cp312-linux_aarch64.whl}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)            MODE="$2"; shift 2 ;;
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
      # Detect Python minor version to select the correct wheel
      PY_MINOR="$(python3 -c 'import sys; print(sys.version_info[1])')"
      if [[ "$PY_MINOR" != "12" ]]; then
        echo "WARNING: aarch64 GPU wheel is built for Python 3.12; you have 3.$PY_MINOR." >&2
        echo "  Falling back to CPU ORT. Use Python 3.12 for GPU support." >&2
      else
        echo "Installing onnxruntime-gpu for aarch64 (Python 3.12, CUDA 12)…"
        echo "  Source: $ORT_AARCH64_WHEEL_URL"
        # Step 1: install GPU wheel (adds CUDA .so but omits __init__.py and the
        # ABI-tagged pybind .so Python prefers).
        if pip install --no-deps "$ORT_AARCH64_WHEEL_URL"; then
          # Step 2: install CPU onnxruntime to get __init__.py. Use 1.23.2 because:
          # - 1.24.0 doesn't exist on PyPI for aarch64
          # - 1.24.1 added OrtEpAssignedNode which the 1.24.0 GPU pybind lacks
          # - 1.23.2 __init__.py imports only symbols present in 1.24.0 GPU pybind
          pip install "onnxruntime==1.23.2"

          # Step 3: the CPU install overwrites onnxruntime_pybind11_state with
          # the ABI-tagged CPU .so. Replace it with the GPU version so Python
          # loads the GPU implementation (Python prefers .cpython-3XX-*.so over
          # plain .so when both exist).
          CAPI_DIR="$(python3 -c "import onnxruntime; import os; print(os.path.join(os.path.dirname(onnxruntime.__file__), 'capi'))")"
          GPU_SO="$CAPI_DIR/onnxruntime_pybind11_state.so"
          ABI_SO="$CAPI_DIR/onnxruntime_pybind11_state.cpython-312-aarch64-linux-gnu.so"
          if [[ -f "$GPU_SO" && -f "$ABI_SO" ]]; then
            gpu_size=$(stat -c%s "$GPU_SO")
            cpu_size=$(stat -c%s "$ABI_SO")
            if [[ "$gpu_size" -gt "$cpu_size" ]]; then
              cp "$GPU_SO" "$ABI_SO"
              echo "  Patched pybind .so: replaced CPU ($cpu_size B) with GPU ($gpu_size B)"
            fi
          fi

          # Step 4: ORT 1.24+ links against cuDNN 9. Install the pip-distributed
          # cuDNN 9 and cuBLAS (run.sh adds their lib dirs to LD_LIBRARY_PATH).
          echo "Installing NVIDIA CUDA runtime libraries (cuDNN 9, cuBLAS)…"
          pip install "nvidia-cudnn-cu12>=9" "nvidia-cublas-cu12"
          GPU_INSTALLED=1
        else
          echo
          echo "  GPU wheel download failed." >&2
          echo "  You can manually install by downloading the .whl and running:" >&2
          echo "    pip install --no-deps /path/to/onnxruntime_gpu-*.whl" >&2
          echo "  Or override the URL: FACE_SERVICE_ORT_WHEEL_URL=<url> ./scripts/setup-face-service.sh --mode gpu" >&2
          echo
          echo "  Falling back to CPU ORT."
        fi
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
