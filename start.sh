#!/usr/bin/env bash
# start.sh — launch Sentry in Docker (production mode)
#
# Usage:
#   ./start.sh              auto-detect GPU; start detached
#   ./start.sh --gpu        force GPU compose overlay
#   ./start.sh --cpu        force CPU-only
#   ./start.sh --build      rebuild images before starting
#   ./start.sh --down       stop and remove containers
#   ./start.sh --logs       tail logs after starting
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

MODE="auto"
BUILD_FLAG=""
ACTION="up"
FOLLOW_LOGS=0

for arg in "$@"; do
  case "$arg" in
    --gpu)   MODE="gpu"  ;;
    --cpu)   MODE="cpu"  ;;
    --auto)  MODE="auto" ;;
    --build) BUILD_FLAG="--build" ;;
    --down)  ACTION="down" ;;
    --logs)  FOLLOW_LOGS=1 ;;
    --help)
      sed -n '/^# Usage:/,/^[^#]/{ /^#/{ s/^# \{0,1\}//; p } }' "$0"
      exit 0 ;;
  esac
done

# ── Load .env ─────────────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  echo "ERROR: .env not found. Copy .env.example to .env and set JWT_SECRET."
  exit 1
fi
set -o allexport
# shellcheck disable=SC1091
source .env
set +o allexport

if [[ -z "${JWT_SECRET:-}" ]]; then
  echo "ERROR: JWT_SECRET is not set in .env."
  exit 1
fi

# ── Choose compose files ───────────────────────────────────────────────────────
BASE_COMPOSE="-f docker-compose.yml"

if [[ "$MODE" == "auto" ]]; then
  if nvidia-smi -L &>/dev/null 2>&1; then
    if docker info 2>/dev/null | grep -qi "nvidia"; then
      MODE="gpu"
    else
      echo "WARNING: nvidia-smi found a GPU but Docker's NVIDIA runtime is not configured."
      echo "  Install nvidia-container-toolkit: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
      echo "  Falling back to CPU mode. Use --gpu to force GPU once toolkit is installed."
      MODE="cpu"
    fi
  else
    MODE="cpu"
  fi
fi

if [[ "$MODE" == "gpu" ]]; then
  COMPOSE_FILES="$BASE_COMPOSE -f docker-compose.gpu.yml"
  echo "Mode: GPU (CUDA EP)"
else
  COMPOSE_FILES="$BASE_COMPOSE"
  echo "Mode: CPU"
fi

# ── Execute ────────────────────────────────────────────────────────────────────
if [[ "$ACTION" == "down" ]]; then
  # shellcheck disable=SC2086
  docker compose $COMPOSE_FILES down
  exit 0
fi

# shellcheck disable=SC2086
docker compose $COMPOSE_FILES up $BUILD_FLAG -d

echo ""
echo "  Frontend   → http://localhost:5173"
echo "  Backend    → http://localhost:8080"
echo "  Face API   → http://localhost:8090"
echo ""
echo "  Default login: admin / sentry123"
echo "  Logs:  docker compose logs -f"
echo "  Stop:  ./start.sh --down"

if [[ "$FOLLOW_LOGS" -eq 1 ]]; then
  # shellcheck disable=SC2086
  docker compose $COMPOSE_FILES logs -f
fi
