# Sentry Dockerization Design

**Date:** 2026-06-30  
**Status:** Approved

## Goal

Dockerize the Sentry home monitoring system for easy deployment, with GPU-first face-service support and a native hot-reload dev mode.

## Platform

- Host: Linux aarch64 (DGX Spark, NVIDIA GB10)
- Docker 29.2.1, Compose v5
- GPU: NVIDIA GB10 — aarch64 ORT GPU wheel has non-trivial install (3-step patch)

## Approach: Compose Override Files

A base `docker-compose.yml` (CPU, always works) plus a `docker-compose.gpu.yml` override that adds the NVIDIA device reservation and `GPU=1` build arg to the face-service. A `start.sh` wrapper auto-detects `nvidia-smi` and picks the right combination. Dev mode is a native `dev.sh` script (no Docker) using standard hot-reload tooling.

## File Layout

```
sentry/
├── docker/
│   ├── backend/
│   │   └── Dockerfile          # multi-stage: golang:1.25 → debian-slim + ffmpeg
│   ├── face-service/
│   │   └── Dockerfile          # python:3.12-slim, ARG GPU=0/1 branch
│   └── frontend/
│       ├── Dockerfile          # node build → nginx:alpine
│       └── nginx.conf          # proxy /api /hls /face, serve static assets
├── docker-compose.yml          # production base (all services, CPU face-service)
├── docker-compose.gpu.yml      # override: GPU=1 build arg + nvidia device
├── .dockerignore               # per-service ignores
├── start.sh                    # ./start.sh [--gpu|--cpu|--auto]
├── dev.sh                      # native hot-reload dev launcher
└── RUNNING.md                  # complete guide: docker, dev, mobile
```

## Services

### backend

- **Build**: two-stage — `golang:1.25-bookworm` compiles binary, `debian:bookworm-slim` runs it with `ffmpeg` installed via apt
- **Port**: 8080
- **Volumes**:
  - `./backend/data:/app/data` — cameras.json, sentry.db
  - `hls_streams:/tmp/sentry/streams` — HLS segments shared with frontend nginx
- **Env**: `SENTRY_DATA_DIR`, `FACE_SERVICE_URL=http://face-service:8090`, `JWT_SECRET`
- **Health check**: `GET /api/cameras` (requires auth → 401 means backend is up)

### face-service

- **Build**: `python:3.12-slim` base with `ARG GPU=0`
  - `GPU=0`: installs `onnxruntime==1.19.2` from PyPI (CPU EP)
  - `GPU=1`: replicates the 3-step aarch64 patch from `setup-face-service.sh` (GPU wheel → CPU __init__.py → patch .so → install cudnn/cublas pip packages)
- **Model pre-bake**: `buffalo_l` downloaded during `docker build` into `/root/.insightface` baked into the image layer — startup is instant, no network needed at runtime
- **Port**: 8090
- **Volumes**:
  - `./face-service/data:/app/data` — face.db, photos/
  - `insightface_models:/root/.insightface` — model cache (declared but pre-populated in image)
- **Env**: `FACE_SERVICE_HOST=0.0.0.0`, `FACE_SERVICE_RELAY_URL=ws://backend:8080`
- **GPU override** (`docker-compose.gpu.yml`):
  ```yaml
  build:
    args:
      GPU: "1"
  deploy:
    resources:
      reservations:
        devices:
          - driver: nvidia
            count: 1
            capabilities: [gpu]
  ```

### frontend

- **Build**: two-stage — `node:22-alpine` runs `npm run build`, `nginx:alpine` serves `dist/`
- **Port**: 80 (mapped to host 5173 for familiarity)
- **nginx.conf**: proxies `/api` and `/hls` to `backend:8080`, `/face` to `face-service:8090` (with `/face` prefix strip), serves static assets for everything else; mounts `hls_streams` volume at `/hls` for direct file serving
- **No volume mounts at runtime** — static assets are baked into the image

### Volumes

| Name | Purpose |
|------|---------|
| `hls_streams` | HLS segments written by backend, served by nginx |
| `backend_data` | cameras.json + sentry.db (optional named vol, or host bind) |
| `faceservice_data` | face.db + photos (optional named vol, or host bind) |
| `insightface_models` | buffalo_l model files |

## start.sh Logic

```
./start.sh            # --auto: nvidia-smi detects GPU → picks compose files
./start.sh --gpu      # force GPU (docker-compose.yml + docker-compose.gpu.yml)
./start.sh --cpu      # force CPU (docker-compose.yml only)
./start.sh --build    # add --build flag to docker compose up
./start.sh --down     # docker compose down
```

Auto-detect: `nvidia-smi -L &>/dev/null` → GPU present → use GPU override.

## Dev Mode (dev.sh — native, no Docker)

| Service | Tool | How |
|---------|------|-----|
| backend | `air` | `go install github.com/air-verse/air@latest` once; `air` in `backend/` watches `**/*.go` |
| face-service | `watchmedo` | `pip install watchdog` in venv; restarts on `face_service/**/*.py` change |
| frontend | Vite HMR | `npm run dev` — already works, zero change |
| mobile | Expo | `npx expo start` — always native |

`dev.sh` starts all four (backend + face-service + frontend) in parallel, traps Ctrl-C to kill all, prints URLs.

## nginx.conf Key Rules

```nginx
location /api  { proxy_pass http://backend:8080; }
location /hls  { alias /hls/; }          # direct file serve from shared volume
location /face {
    rewrite ^/face(/.*)?$ $1 break;
    proxy_pass http://face-service:8090;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";  # WebSocket support
}
location /     { try_files $uri /index.html; }  # SPA fallback
```

## RUNNING.md Coverage

1. First-time setup (clone, volumes, build)
2. Production — GPU mode (default)
3. Production — CPU mode
4. Development mode (hot reload, native)
5. Mobile — iOS Simulator
6. Mobile — Android Emulator
7. Mobile — Physical device (LAN IP setup, where to set `EXPO_PUBLIC_API_URL`)
8. Push notification testing
9. Rebuilding after dependency changes

## Open Questions / Constraints

- `JWT_SECRET` must be set via `.env` file (not committed); `start.sh` warns if missing
- First `docker build` for face-service GPU is slow (~5 min) due to model download baked in; subsequent builds use layer cache
- `nvidia-container-toolkit` must be installed on host for GPU mode — `start.sh` checks and warns
- Mobile never runs in Docker; it always connects to the host machine's IP over LAN
