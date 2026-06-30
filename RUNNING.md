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
