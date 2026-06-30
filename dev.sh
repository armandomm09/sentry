#!/usr/bin/env bash
# dev.sh — native hot-reload dev mode (no Docker)
#
# Prerequisites (one-time):
#   go install github.com/air-verse/air@latest
#   ./scripts/setup-face-service.sh
#   face-service/.venv/bin/pip install watchdog
#   cd frontend && npm install
#
# Mobile runs separately:
#   cd mobile && npx expo start
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

# ── Prerequisite checks ───────────────────────────────────────────────────────
FACE_VENV="$ROOT/face-service/.venv"

if ! command -v air &>/dev/null; then
  echo "ERROR: 'air' not found."
  echo "  Install: go install github.com/air-verse/air@latest"
  echo "  Then add \$(go env GOPATH)/bin to your PATH."
  exit 1
fi

if [[ ! -x "$FACE_VENV/bin/python" ]]; then
  echo "ERROR: face-service venv not found."
  echo "  Run: ./scripts/setup-face-service.sh"
  exit 1
fi

if ! "$FACE_VENV/bin/python" -c "import watchdog" &>/dev/null; then
  echo "ERROR: 'watchdog' not installed in face-service venv."
  echo "  Run: face-service/.venv/bin/pip install watchdog"
  exit 1
fi

# ── Cleanup on exit ───────────────────────────────────────────────────────────
PIDS=()

cleanup() {
  trap - INT TERM
  echo ""
  echo "Stopping dev services..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

# ── Backend (air live reload) ─────────────────────────────────────────────────
echo "Starting backend with hot reload (air)..."
cd "$ROOT/backend"
air &
PIDS+=($!)

# ── Face-service (watchmedo auto-restart on .py changes) ──────────────────────
echo "Starting face-service with hot reload (watchmedo)..."
cd "$ROOT/face-service"

# Mirror run.sh: add pip-installed cuDNN/cuBLAS to LD_LIBRARY_PATH for CUDA EP
NVIDIA_LIB="$FACE_VENV/lib/python3.12/site-packages/nvidia"
FACE_LD=""
for pkg in cudnn cublas; do
  lib_dir="$NVIDIA_LIB/$pkg/lib"
  [[ -d "$lib_dir" ]] && FACE_LD="$lib_dir:$FACE_LD"
done

LD_LIBRARY_PATH="${FACE_LD}${LD_LIBRARY_PATH:-}" \
  "$FACE_VENV/bin/watchmedo" auto-restart \
    --patterns="*.py" \
    --recursive \
    --directory="./face_service" \
    -- "$FACE_VENV/bin/python" -m face_service &
PIDS+=($!)

# ── Frontend (Vite HMR) ───────────────────────────────────────────────────────
echo "Starting frontend (Vite HMR)..."
cd "$ROOT/frontend"
npm run dev &
PIDS+=($!)

echo ""
echo "  Frontend   → http://localhost:5173  (Vite HMR)"
echo "  Backend    → http://localhost:8080  (air live reload)"
echo "  Face API   → http://localhost:8090  (watchmedo restart on .py save)"
echo ""
echo "  Mobile     → cd mobile && npx expo start"
echo ""
echo "Press Ctrl+C to stop all services."

# Wait for any child to exit (surface crashes)
wait -n 2>/dev/null || wait
cleanup
