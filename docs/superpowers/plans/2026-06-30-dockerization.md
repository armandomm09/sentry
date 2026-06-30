# Sentry Dockerization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dockerize Sentry (Go backend, Python face-service, React frontend) with GPU-first production compose and a native hot-reload dev mode, plus a comprehensive RUNNING.md guide covering all run modes including mobile.

**Architecture:** Three services in `docker-compose.yml` (CPU base) overlaid by `docker-compose.gpu.yml` (NVIDIA device + GPU build arg). All Dockerfiles use the repo root as build context. Dev mode is native (no Docker): `air` for Go, `watchmedo` for Python, Vite HMR for frontend. Mobile always runs natively via Expo.

**Tech Stack:** Docker 29 / Compose v5, `golang:1.25-bookworm`, `python:3.12-slim`, `node:22-alpine`, `nginx:alpine`, `air` (Go live reload), `watchdog` (Python file watcher).

## Global Constraints

- Platform: Linux aarch64, NVIDIA GB10. All Docker images must target `linux/arm64`.
- GPU path in face-service: 3-step aarch64 ORT patch (Ultralytics wheel → CPU __init__.py → .so patch → cudnn/cublas pip packages). Matches logic in `scripts/setup-face-service.sh`.
- Build context for all three Dockerfiles is the repo root (`.`). This lets each Dockerfile reach its service subdirectory and the `docker/` directory in a single build invocation.
- HLS segments shared between backend and frontend nginx via named volume `hls_streams`; backend writes to `/tmp/sentry/streams`, nginx reads from `/hls`.
- `JWT_SECRET` must come from a `.env` file; `start.sh` exits with an error if it is missing.
- `insightface` buffalo_l model (~600 MB) is baked into the face-service image during `docker build`. No volume is mounted over `/root/.insightface`; rebuilding the image updates the model.
- Mobile never runs in Docker. The backend URL is entered at login time in the Expo app — no source change needed.
- `modernc.org/sqlite` is pure Go; compile the backend with `CGO_ENABLED=0`.

---

### Task 1: Root `.dockerignore` and Backend Dockerfile

**Files:**
- Create: `.dockerignore`
- Create: `docker/backend/Dockerfile`

**Interfaces:**
- Produces: Docker image `sentry-backend` exposing port 8080, binary at `/app/backend`, data dir at `/app/data`, HLS dir at `/tmp/sentry/streams`.

- [ ] **Step 1: Create `.dockerignore`**

This keeps large local artifacts out of the build context (venv, node_modules, data files). Create at repo root:

```
# .dockerignore
backend/data/
face-service/data/
face-service/.venv/
frontend/node_modules/
frontend/dist/
mobile/
**/.git
**/__pycache__
**/.pytest_cache
**/tmp
.env
*.md
docs/
tests/
```

- [ ] **Step 2: Create `docker/backend/Dockerfile`**

Two-stage build: compile a static binary in the Go toolchain image, then copy it into a minimal Debian image that has `ffmpeg`.

```dockerfile
# docker/backend/Dockerfile
# Stage 1 — compile
FROM golang:1.25-bookworm AS builder
WORKDIR /src

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /app/backend .

# Stage 2 — runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/backend ./backend

RUN mkdir -p /tmp/sentry/streams data

EXPOSE 8080
ENV PORT=8080 \
    SENTRY_DATA_DIR=/app/data

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
    CMD wget -qO- http://localhost:8080/health || exit 1

CMD ["./backend"]
```

- [ ] **Step 3: Build and verify**

```bash
docker build -f docker/backend/Dockerfile -t sentry-backend:test .
```

Expected: build exits 0. Confirm the binary and ffmpeg are present:
```bash
docker run --rm sentry-backend:test sh -c "ls /app/backend && ffmpeg -version | head -1"
```
Expected output includes `backend` and `ffmpeg version ...`.

- [ ] **Step 4: Commit**

```bash
git add .dockerignore docker/backend/Dockerfile
git commit -m "docker: add .dockerignore and backend Dockerfile"
```

---

### Task 2: Face-service Dockerfile (CPU + GPU)

**Files:**
- Create: `docker/face-service/Dockerfile`
- Create: `docker/face-service/patch_ort.py`
- Create: `docker/face-service/entrypoint.sh`

**Interfaces:**
- Produces: Docker image `sentry-face` built with `--build-arg GPU=0` (CPU) or `--build-arg GPU=1` (GPU). Exposes port 8090. Must be run with `FACE_SERVICE_HOST=0.0.0.0` and `FACE_SERVICE_RELAY_URL=ws://backend:8080`.
- GPU image requires NVIDIA container runtime at run time (`docker run --gpus all ...`).

- [ ] **Step 1: Create the ORT patch script**

This Python script is COPY'd into the image and run during the GPU build layer. It swaps the CPU ABI-tagged `.so` with the GPU `.so` (same logic as `scripts/setup-face-service.sh`):

```python
# docker/face-service/patch_ort.py
"""Replace the CPU ABI-tagged pybind .so with the GPU .so.

After installing onnxruntime-gpu (step 1, no-deps) and onnxruntime CPU
(step 2, for __init__.py), Python prefers the ABI-tagged CPU .so. This
script replaces it with the GPU .so so the CUDA EP is loaded.
"""
import os
import shutil

import onnxruntime  # noqa: F401 — import to resolve path

capi_dir = os.path.join(os.path.dirname(onnxruntime.__file__), "capi")
gpu_so = os.path.join(capi_dir, "onnxruntime_pybind11_state.so")
abi_so = os.path.join(
    capi_dir, "onnxruntime_pybind11_state.cpython-312-aarch64-linux-gnu.so"
)

if not os.path.exists(gpu_so):
    print(f"ERROR: GPU .so not found at {gpu_so}")
    raise SystemExit(1)

if not os.path.exists(abi_so):
    print(f"ERROR: ABI .so not found at {abi_so}")
    raise SystemExit(1)

gpu_size = os.path.getsize(gpu_so)
abi_size = os.path.getsize(abi_so)

if gpu_size > abi_size:
    shutil.copy(gpu_so, abi_so)
    print(f"Patched: GPU .so ({gpu_size} B) → ABI .so path")
else:
    print(f"WARN: GPU .so ({gpu_size} B) not larger than ABI .so ({abi_size} B). Skipping.")
```

- [ ] **Step 2: Create the entrypoint script**

At runtime the CUDA libs installed by `nvidia-cudnn-cu12` and `nvidia-cublas-cu12` must be on `LD_LIBRARY_PATH`. This script discovers their paths dynamically (same logic as `run.sh`):

```bash
#!/bin/sh
# docker/face-service/entrypoint.sh
# Adds pip-installed NVIDIA library paths to LD_LIBRARY_PATH so ORT's
# CUDAExecutionProvider can find cuDNN and cuBLAS at runtime.
SITE=$(python -c "import site; print(site.getsitepackages()[0])" 2>/dev/null || true)
for pkg in cudnn cublas; do
    lib_dir="$SITE/nvidia/$pkg/lib"
    if [ -d "$lib_dir" ]; then
        export LD_LIBRARY_PATH="$lib_dir:${LD_LIBRARY_PATH:-}"
    fi
done
exec "$@"
```

- [ ] **Step 3: Create `docker/face-service/Dockerfile`**

The CPU path installs `onnxruntime` from `requirements.txt`. The GPU path (aarch64) follows the exact 3-step process from `scripts/setup-face-service.sh`. The buffalo_l model is pre-baked so container startup is instant.

```dockerfile
# docker/face-service/Dockerfile
FROM python:3.12-slim

# System libs needed by OpenCV headless and insightface
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
        curl \
        wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Base Python requirements (CPU ORT included) ──────────────────────────────
COPY face-service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# ── GPU path: aarch64 ORT patch (only when GPU=1) ────────────────────────────
ARG GPU=0
ARG ORT_AARCH64_WHEEL_URL="https://github.com/ultralytics/assets/releases/download/v0.0.0/onnxruntime_gpu-1.19.2-cp312-cp312-linux_aarch64.whl"

COPY docker/face-service/patch_ort.py /tmp/patch_ort.py

RUN if [ "$GPU" = "1" ]; then \
        echo "=== GPU build: installing aarch64 ORT GPU wheel ===" && \
        # Step 1: GPU wheel — has CUDA .so but no __init__.py
        pip install --no-cache-dir --no-deps "$ORT_AARCH64_WHEEL_URL" && \
        # Step 2: CPU ORT for __init__.py (compatible with GPU pybind ABI)
        pip install --no-cache-dir "onnxruntime==1.23.2" && \
        # Step 3: Patch ABI-tagged .so with GPU .so
        python /tmp/patch_ort.py && \
        # Step 4: CUDA runtime libs (cuDNN 9, cuBLAS) — entrypoint adds to LD_LIBRARY_PATH
        pip install --no-cache-dir "nvidia-cudnn-cu12>=9" "nvidia-cublas-cu12"; \
    fi

# ── Pre-bake buffalo_l model (~600 MB, cached as image layer) ─────────────────
ENV INSIGHTFACE_HOME=/root/.insightface
RUN python - <<'PY'
import os
os.environ["INSIGHTFACE_HOME"] = "/root/.insightface"
from insightface.app import FaceAnalysis
app = FaceAnalysis(name="buffalo_l")
app.prepare(ctx_id=-1, det_size=(640, 640))
print("buffalo_l model ready")
PY

# ── Application code ──────────────────────────────────────────────────────────
COPY face-service/face_service/ ./face_service/
COPY docker/face-service/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8090

ENV FACE_SERVICE_HOST=0.0.0.0 \
    FACE_SERVICE_PORT=8090 \
    FACE_SERVICE_DATA_DIR=/app/data \
    INSIGHTFACE_HOME=/root/.insightface

ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "-m", "face_service"]
```

- [ ] **Step 4: Build CPU image and verify**

```bash
docker build --build-arg GPU=0 -f docker/face-service/Dockerfile -t sentry-face:cpu-test .
```

Expected: build exits 0. Verify ORT and model:
```bash
docker run --rm sentry-face:cpu-test python -c "
import onnxruntime as ort
print('ORT version:', ort.__version__)
print('Providers:', ort.get_available_providers())
import os; print('Model exists:', os.path.isdir('/root/.insightface/models/buffalo_l'))
"
```
Expected: ORT version `1.19.2`, providers includes `CPUExecutionProvider`, model dir exists.

- [ ] **Step 5: Build GPU image and verify**

```bash
docker build --build-arg GPU=1 -f docker/face-service/Dockerfile -t sentry-face:gpu-test .
```

Expected: build exits 0. Verify CUDA EP is available (run with GPU access):
```bash
docker run --rm --gpus all sentry-face:gpu-test python -c "
import onnxruntime as ort
print('Providers:', ort.get_available_providers())
"
```
Expected: providers includes `CUDAExecutionProvider`.

- [ ] **Step 6: Commit**

```bash
git add docker/face-service/
git commit -m "docker: add face-service Dockerfile with CPU/GPU ARG and buffalo_l pre-bake"
```

---

### Task 3: Frontend Dockerfile and nginx config

**Files:**
- Create: `docker/frontend/nginx.conf`
- Create: `docker/frontend/Dockerfile`

**Interfaces:**
- Produces: Docker image `sentry-frontend` serving the built React SPA on port 80.
- nginx proxies `/api/` → `backend:8080`, strips `/face/` prefix → `face-service:8090` (WebSocket-capable), serves `/hls/` directly from the shared `hls_streams` volume mounted at `/hls`.
- SPA fallback: all unmatched routes return `index.html`.

- [ ] **Step 1: Create `docker/frontend/nginx.conf`**

The `map` directive (valid in `http {}` context, which is where nginx includes `conf.d/` files) handles WebSocket connection upgrades cleanly.

```nginx
# docker/frontend/nginx.conf
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;

    root /usr/share/nginx/html;
    index index.html;

    # ── HLS segments: serve directly from shared volume ──────────────────────
    # Backend writes to /tmp/sentry/streams; compose mounts that volume at /hls.
    location /hls/ {
        alias /hls/;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header Access-Control-Allow-Origin "*";
        add_header Access-Control-Allow-Methods "GET, OPTIONS";
    }

    # ── Backend REST API + frame WebSocket ───────────────────────────────────
    location /api/ {
        proxy_pass         http://backend:8080;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host       $host;
        proxy_read_timeout 300s;
    }

    # ── Face-service detection WebSocket (strip /face prefix) ────────────────
    # Mirrors vite.config.ts: rewrite /face/X → /X on face-service:8090
    location /face/ {
        rewrite            ^/face(/.*)?$ $1 break;
        proxy_pass         http://face-service:8090;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host       $host;
        proxy_read_timeout 300s;
    }

    # ── SPA fallback ─────────────────────────────────────────────────────────
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

- [ ] **Step 2: Create `docker/frontend/Dockerfile`**

Two-stage build: Node compiles the Vite app; nginx serves the static output. The nginx.conf is COPY'd from `docker/frontend/nginx.conf` (reachable because build context is repo root).

```dockerfile
# docker/frontend/Dockerfile
# Stage 1 — build
FROM node:22-alpine AS builder
WORKDIR /app

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# Stage 2 — serve
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
```

- [ ] **Step 3: Build and verify**

```bash
docker build -f docker/frontend/Dockerfile -t sentry-frontend:test .
```

Expected: build exits 0. Check that the nginx config parses cleanly:
```bash
docker run --rm sentry-frontend:test nginx -t
```
Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful`.

- [ ] **Step 4: Commit**

```bash
git add docker/frontend/
git commit -m "docker: add frontend Dockerfile and nginx reverse-proxy config"
```

---

### Task 4: Base `docker-compose.yml` and `.env.example`

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

**Interfaces:**
- Consumes images built in Tasks 1–3.
- Produces: full three-service stack in CPU mode. `docker compose config` must pass.

- [ ] **Step 1: Create `.env.example`**

```bash
# .env.example — copy to .env and fill in values before running
# Required
JWT_SECRET=change-me-to-a-long-random-string

# Optional face-service tuning (defaults shown)
# FACE_SERVICE_MATCH_THRESHOLD=0.42
# FACE_SERVICE_MODEL=buffalo_l
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
# docker-compose.yml  — production base, CPU face-service
# To enable GPU: docker compose -f docker-compose.yml -f docker-compose.gpu.yml up
# Or use ./start.sh (auto-detects GPU)

name: sentry

services:
  backend:
    build:
      context: .
      dockerfile: docker/backend/Dockerfile
    ports:
      - "8080:8080"
    volumes:
      - ./backend/data:/app/data
      - hls_streams:/tmp/sentry/streams
    environment:
      - PORT=8080
      - SENTRY_DATA_DIR=/app/data
      - FACE_SERVICE_URL=http://face-service:8090
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      - face-service
    restart: unless-stopped

  face-service:
    build:
      context: .
      dockerfile: docker/face-service/Dockerfile
      args:
        GPU: "0"
    ports:
      - "8090:8090"
    volumes:
      - ./face-service/data:/app/data
    environment:
      - FACE_SERVICE_HOST=0.0.0.0
      - FACE_SERVICE_PORT=8090
      - FACE_SERVICE_DATA_DIR=/app/data
      - FACE_SERVICE_RELAY_URL=ws://backend:8080
      - FACE_SERVICE_PROVIDERS=CPUExecutionProvider
    restart: unless-stopped

  frontend:
    build:
      context: .
      dockerfile: docker/frontend/Dockerfile
    ports:
      - "5173:80"
    volumes:
      - hls_streams:/hls:ro
    depends_on:
      - backend
      - face-service
    restart: unless-stopped

volumes:
  hls_streams:
```

- [ ] **Step 3: Validate compose config**

```bash
cp .env.example .env
# Set a real JWT_SECRET value (anything non-empty works for local testing)
echo 'JWT_SECRET=local-test-secret-change-in-prod' > .env

docker compose config
```

Expected: no errors, YAML dumps the resolved configuration.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
# Do NOT git add .env — it must stay in .gitignore
grep -q '\.env' .gitignore || echo '.env' >> .gitignore
git add .gitignore
git commit -m "docker: add base docker-compose.yml (CPU) and .env.example"
```

---

### Task 5: GPU override `docker-compose.gpu.yml`

**Files:**
- Create: `docker-compose.gpu.yml`

**Interfaces:**
- Consumes: `docker-compose.yml` (Task 4).
- Produces: when merged with the base compose, the face-service is rebuilt with `GPU=1`, given NVIDIA device access, and pointed at the CUDA provider chain.

- [ ] **Step 1: Create `docker-compose.gpu.yml`**

```yaml
# docker-compose.gpu.yml  — GPU overlay for face-service
# Usage: docker compose -f docker-compose.yml -f docker-compose.gpu.yml up
# Or:    ./start.sh --gpu

services:
  face-service:
    build:
      args:
        GPU: "1"
    environment:
      - FACE_SERVICE_PROVIDERS=TensorrtExecutionProvider,CUDAExecutionProvider,CPUExecutionProvider
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

- [ ] **Step 2: Validate merged config**

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml config
```

Expected: no errors. Confirm the face-service section shows `GPU: "1"` under `build.args` and the nvidia device reservation under `deploy.resources`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.gpu.yml
git commit -m "docker: add GPU compose override for face-service"
```

---

### Task 6: `start.sh` launcher

**Files:**
- Create: `start.sh`

**Interfaces:**
- Consumes: `docker-compose.yml`, `docker-compose.gpu.yml`, `.env`.
- Produces: wrapper script that auto-detects GPU, builds and starts the stack, prints service URLs.

- [ ] **Step 1: Create `start.sh`**

```bash
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
```

- [ ] **Step 2: Make executable**

```bash
chmod +x start.sh
```

- [ ] **Step 3: Smoke-test help and config validation**

```bash
./start.sh --help
```
Expected: prints usage lines from the comment block.

```bash
# Test CPU path without actually starting (just validate compose config)
./start.sh --cpu 2>&1 | head -5   # will fail if .env missing — expected
```

If `.env` exists: `docker compose config` runs internally; the stack will start. Verify with `docker compose ps` and stop with `./start.sh --down`.

- [ ] **Step 4: Commit**

```bash
git add start.sh
git commit -m "docker: add start.sh launcher with auto GPU/CPU detection"
```

---

### Task 7: Dev mode — `backend/.air.toml` and `dev.sh`

**Files:**
- Create: `backend/.air.toml`
- Create: `dev.sh`

**Interfaces:**
- Produces: `dev.sh` starts all three server processes (backend with `air`, face-service with `watchmedo`, frontend with Vite) in parallel; traps Ctrl-C to kill all. Mobile runs separately via `npx expo start`.

- [ ] **Step 1: Install `air` (one-time, not in any file)**

Run this once on the host machine:
```bash
go install github.com/air-verse/air@latest
```
`air` lands at `$(go env GOPATH)/bin/air` (usually `~/go/bin/air`). Confirm `air -v` works.

- [ ] **Step 2: Create `backend/.air.toml`**

```toml
# backend/.air.toml — live reload config for Go backend
root = "."
tmp_dir = "tmp"

[build]
  cmd        = "go build -o ./tmp/backend ."
  bin        = "./tmp/backend"
  include_ext = ["go"]
  exclude_dir = ["tmp", "data"]
  delay      = 500

[log]
  time = true

[color]
  main    = "magenta"
  watcher = "cyan"
  build   = "yellow"
  runner  = "green"

[misc]
  clean_on_exit = true
```

- [ ] **Step 3: Install `watchdog` into the face-service venv (one-time)**

```bash
face-service/.venv/bin/pip install watchdog
```

Verify:
```bash
face-service/.venv/bin/watchmedo --version
```

- [ ] **Step 4: Create `dev.sh`**

```bash
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
```

- [ ] **Step 5: Make executable and verify**

```bash
chmod +x dev.sh
# Dry-run prerequisite check
bash -n dev.sh   # syntax check
```

- [ ] **Step 6: Commit**

```bash
git add backend/.air.toml dev.sh
git commit -m "dev: add air config and dev.sh hot-reload launcher"
```

---

### Task 8: `RUNNING.md` — comprehensive guide

**Files:**
- Create: `RUNNING.md`

**Interfaces:**
- Consumes: all files from Tasks 1–7.
- Produces: a self-contained guide covering every run mode.

- [ ] **Step 1: Create `RUNNING.md`**

```markdown
# Running Sentry

This guide covers every way to run the Sentry home monitoring system.

---

## Quick Reference

| Mode | Command | Hot Reload |
|------|---------|-----------|
| Production (auto GPU) | `./start.sh` | No |
| Production (CPU only) | `./start.sh --cpu` | No |
| Development | `./dev.sh` | Yes (backend + face-service + frontend) |
| Mobile (Expo) | `cd mobile && npx expo start` | Yes (Expo Fast Refresh) |

---

## Prerequisites

### All modes
- Docker 24+ and Docker Compose v2+
- Node.js 22+ (`node --version`)
- Go 1.25+ (`go version`)

### Production (Docker)
Confirm Docker is running:
```bash
docker info
```

Copy and configure the environment file (only once):
```bash
cp .env.example .env
```

Edit `.env` and set a strong `JWT_SECRET`:
```
JWT_SECRET=your-random-secret-here
```

### GPU mode (optional but recommended on this machine)
The NVIDIA Container Toolkit must be installed so Docker can access the GPU.
Check if it is already configured:
```bash
docker info | grep -i nvidia
# Expected output contains: Runtimes: nvidia runc
```

If missing:
```bash
# On Ubuntu/Debian
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### Development mode (additional)
One-time installs:
```bash
# Go live-reload tool
go install github.com/air-verse/air@latest
# Add to PATH if not already
export PATH="$PATH:$(go env GOPATH)/bin"

# Face-service setup (creates .venv, installs GPU ORT wheel natively)
./scripts/setup-face-service.sh

# Python file-watcher for face-service hot reload
face-service/.venv/bin/pip install watchdog

# Frontend dependencies
cd frontend && npm install && cd ..

# Mobile dependencies
cd mobile && npm install && cd ..
```

---

## Production Mode (Docker)

### First build

The face-service image bakes in the ~600 MB buffalo_l model. The first build takes 3–8 minutes depending on network speed. Subsequent builds use the layer cache.

```bash
./start.sh --build        # auto-detect GPU, build images, start detached
```

Force a specific mode:
```bash
./start.sh --gpu --build  # GPU (NVIDIA CUDA EP)
./start.sh --cpu --build  # CPU only
```

### Starting and stopping

```bash
./start.sh          # start (GPU auto-detected)
./start.sh --down   # stop all containers
./start.sh --logs   # start and follow logs
```

### Service URLs

| Service | URL |
|---------|-----|
| Web dashboard | http://localhost:5173 |
| Backend API | http://localhost:8080 |
| Face service | http://localhost:8090 |

Default credentials: **admin** / **sentry123** (change after first login).

### Viewing logs

```bash
docker compose logs -f               # all services
docker compose logs -f backend       # backend only
docker compose logs -f face-service  # face-service only
docker compose logs -f frontend      # nginx access log
```

### Rebuilding after code changes

```bash
./start.sh --build         # rebuild all images
docker compose build face-service && docker compose up -d face-service  # rebuild one service
```

### Rebuilding after dependency changes

| Scenario | Action |
|----------|--------|
| Go `go.mod` / `go.sum` changed | `docker compose build backend` |
| Python `requirements.txt` changed | `docker compose build face-service` |
| `npm` `package.json` changed | `docker compose build frontend` |

### Data persistence

| Data | Location on host |
|------|-----------------|
| Cameras config, users DB | `./backend/data/` |
| Person photos, face embeddings DB | `./face-service/data/` |
| HLS segments (transient) | Docker named volume `sentry_hls_streams` |

---

## Development Mode (native, hot reload)

Dev mode runs all services natively on the host — no Docker needed. Each service hot-reloads when you save a file.

```bash
./dev.sh
```

| Service | Reload trigger | Latency |
|---------|---------------|---------|
| Go backend | Any `.go` file save in `backend/` | ~1 s (air rebuilds binary) |
| face-service | Any `.py` file save in `face-service/face_service/` | ~2 s (watchmedo restarts process) |
| Frontend | Any `.tsx`/`.ts`/`.css` save in `frontend/src/` | <100 ms (Vite HMR, browser updates in place) |

### Mobile in dev mode

Run in a separate terminal after `./dev.sh` is up:
```bash
cd mobile && npx expo start
```

Then choose your target (see Mobile sections below).

---

## Mobile — iOS Simulator

Requires macOS with Xcode installed.

```bash
cd mobile
npx expo start --ios
```

Expo opens the iOS Simulator automatically. On the login screen enter:
- **Server URL:** `http://localhost:8080`
- **Username / Password:** `admin` / `sentry123`

The simulator shares the Mac's localhost, so `localhost:8080` reaches the backend directly.

---

## Mobile — Android Emulator

Requires Android Studio with an AVD (Android Virtual Device) configured.

```bash
cd mobile
npx expo start --android
```

On the login screen the emulator uses `10.0.2.2` as its gateway to the host:
- **Server URL:** `http://10.0.2.2:8080`

> If you are running the backend in Docker, make sure port 8080 is published (it is by default in `docker-compose.yml`).

---

## Mobile — Physical Device

The device and your computer must be on the same Wi-Fi network.

**1. Find your machine's LAN IP:**
```bash
ip addr show | grep 'inet ' | grep -v 127.0.0.1
# Example: 192.168.1.42
```

**2. Start Expo:**
```bash
cd mobile
npx expo start
```

**3. Scan the QR code** in the terminal with the Expo Go app (iOS / Android).

**4. On the Sentry login screen enter:**
- **Server URL:** `http://192.168.1.42:8080` (replace with your LAN IP)

> Push notifications require a real device (not a simulator). The Expo push token is registered with the backend automatically after login when you grant notification permission.

### Changing the server URL

The server URL is stored in the device's SecureStore after the first login. To change it: log out from the Settings screen, then log in again with the new URL.

---

## Push Notifications

Push notifications flow:
1. Face-service detects a person → sends event to backend WebSocket subscriber
2. Backend looks up Expo push tokens in SQLite and calls `https://exp.host/push/send`
3. Expo delivers the notification to the physical device

Requirements:
- Physical device (not simulator)
- Granted notification permission (prompted on first launch)
- Device registered in Settings → Push Notifications

To test the end-to-end flow: add a camera, enroll a person with a photo, point the camera at that person, and watch for a notification on the device.

---

## Troubleshooting

### `JWT_SECRET is not set`
Copy `.env.example` to `.env` and fill in `JWT_SECRET`.

### Face-service fails to connect to backend
Check that `FACE_SERVICE_RELAY_URL=ws://backend:8080` is set (automatic in Docker). In dev mode the default is `ws://127.0.0.1:8080`, which is correct.

### GPU mode: `Failed to create CUDAExecutionProvider`
The NVIDIA Container Toolkit is not configured. See the GPU prerequisites section above.

### HLS stream not loading
In production Docker: verify the `sentry_hls_streams` volume is mounted in both `backend` and `frontend` containers:
```bash
docker compose exec backend ls /tmp/sentry/streams
docker compose exec frontend ls /hls
```
Both should list the same camera IDs once a stream is started.

### First build is very slow
The face-service image downloads the ~600 MB buffalo_l model. This only happens on the first build — subsequent builds use the Docker layer cache.
```bash
./start.sh --build   # wait ~5 min on first run
```
```

- [ ] **Step 2: Commit**

```bash
git add RUNNING.md
git commit -m "docs: add RUNNING.md covering Docker, dev mode, and mobile setup"
```

---

### Task 9: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Adds Docker and dev-mode sections so future Claude sessions know how to start the system in both modes.

- [ ] **Step 1: Add Docker and dev-mode sections to `CLAUDE.md`**

Add the following section after the existing "Running the System" section and before "Backend (Go)":

```markdown
## Docker (Production)

**Start all services (GPU auto-detected):**
```bash
cp .env.example .env    # set JWT_SECRET first
./start.sh --build      # first run; subsequent: ./start.sh
```

**Force mode:**
```bash
./start.sh --gpu    # CUDA EP (requires nvidia-container-toolkit)
./start.sh --cpu    # CPU-only
./start.sh --down   # stop
```

Services are available at the same ports (5173 frontend, 8080 backend, 8090 face-service). See `RUNNING.md` for the full guide including mobile setup.

**Rebuild after changes:**
```bash
docker compose build <service>   # backend | face-service | frontend
```

## Development Mode (Hot Reload)

**One-time setup:**
```bash
go install github.com/air-verse/air@latest
./scripts/setup-face-service.sh
face-service/.venv/bin/pip install watchdog
cd frontend && npm install
```

**Start all services with hot reload:**
```bash
./dev.sh
```

| Service | Tool | Reload on |
|---------|------|-----------|
| backend | `air` | `*.go` save |
| face-service | `watchmedo` | `*.py` save |
| frontend | Vite HMR | any `src/` save |

Mobile runs separately: `cd mobile && npx expo start`
```

- [ ] **Step 2: Verify CLAUDE.md reads correctly**

```bash
head -80 CLAUDE.md
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): add Docker and dev-mode sections"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| docker/backend/Dockerfile multi-stage + ffmpeg | Task 1 |
| docker/face-service/Dockerfile ARG GPU=0/1 | Task 2 |
| 3-step aarch64 ORT GPU patch | Task 2 |
| buffalo_l baked into image | Task 2 |
| LD_LIBRARY_PATH entrypoint for CUDA libs | Task 2 |
| docker/frontend/Dockerfile node→nginx | Task 3 |
| nginx.conf proxy + WS + HLS alias + SPA fallback | Task 3 |
| docker-compose.yml CPU base | Task 4 |
| .env.example + JWT_SECRET guard | Task 4 |
| docker-compose.gpu.yml NVIDIA device + GPU arg | Task 5 |
| start.sh --auto/--gpu/--cpu/--build/--down | Task 6 |
| nvidia-smi + toolkit detection in start.sh | Task 6 |
| backend/.air.toml | Task 7 |
| dev.sh with air + watchmedo + Vite | Task 7 |
| RUNNING.md: Docker GPU/CPU, dev, iOS sim, Android, physical device, push | Task 8 |
| CLAUDE.md updated | Task 9 |
| hls_streams shared volume | Tasks 4+3 |
| .dockerignore | Task 1 |

All spec requirements covered. No gaps found.

**Type/interface consistency:** `start.sh` references `docker-compose.yml` and `docker-compose.gpu.yml` — both created in Tasks 4 and 5. `dev.sh` references `face-service/.venv/bin/watchmedo` — installed in Task 7 Step 3. `backend/.air.toml` `bin` path `./tmp/backend` matches `tmp_dir = "tmp"`. Consistent throughout.
