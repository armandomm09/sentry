# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Services Overview

Sentry is a home monitoring system composed of four services:

| Service | Port | Language | Purpose |
|---------|------|----------|---------|
| `backend/` | 8080 | Go (Gin) | RTSP→HLS streaming, auth, REST API, push dispatch |
| `face-service/` | 8090 | Python (aiohttp) | InsightFace recognition, person enrollment, detection WebSocket |
| `frontend/` | 5173 | React + Vite | Web dashboard |
| `mobile/` | — | Expo (React Native) | iOS/Android app with push notifications |

## Running the System

**Start all services at once:**
```bash
./run.sh
```

**Individual services:**
```bash
# Backend
cd backend && go run .

# Face service (requires venv set up via ./scripts/setup-face-service.sh)
cd face-service && .venv/bin/python -m face_service

# Frontend
cd frontend && npm run dev

# Mobile
cd mobile && npx expo start
```

**First-time face service setup:**
```bash
./scripts/setup-face-service.sh
```

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

## Backend (Go)

**Build & test:**
```bash
cd backend
go build ./...
go test ./...
go vet ./...
```

**Key env vars:** `SENTRY_DATA_DIR` (default `./data`), `SENTRY_DB_PATH`, `PORT` (default `8080`), `FACE_SERVICE_URL` (default `http://127.0.0.1:8090`), `JWT_SECRET`.

**Default credentials on first run:** `admin` / `sentry123`

**Architecture:**
- `main.go` wires all components. Routes under `/api` require JWT auth except `/api/auth/login` and the `/api/cameras/:id/frames` WebSocket (consumed by face-service).
- `stream/` — each camera gets a `Relay` that FFmpeg-transcodes RTSP to HLS segments written to `/tmp/sentry/streams/<camera-id>/`. Frames are also fanned out to subscribers via channels for the face-service to consume.
- `face/` — `client.go` calls the Python face-service REST API; `proxy.go` reverse-proxies `/api/persons/*` to it and `/face/cameras/{id}/ws` (detection WebSocket) to the face-service's `/cameras/{id}/ws`. `SyncFromStore` + `RunSyncLoop` keep face-service's camera list in sync with `cameras.json`.
- `push/` — `listener.go` subscribes to the face-service detection WebSocket per camera; `notifier.go` batches and sends via Expo Push API.
- `storage/json_store.go` — camera config persisted to `data/cameras.json`.
- `db/db.go` — SQLite (`modernc.org/sqlite`) for users and push subscriptions.
- HLS segments are served statically at `/hls` → `/tmp/sentry/streams/`.

## Face Service (Python)

**Key env vars:** `FACE_SERVICE_HOST`, `FACE_SERVICE_PORT` (default `8090`), `FACE_SERVICE_DATA_DIR`, `FACE_SERVICE_MODEL` (default `buffalo_l`), `FACE_SERVICE_MATCH_THRESHOLD` (default `0.42`), `FACE_SERVICE_PROVIDERS` (comma-separated ORT providers), `FACE_SERVICE_RELAY_URL` (default `ws://127.0.0.1:8080`).

**Architecture:**
- `server.py` — aiohttp app factory. Routes for persons CRUD, photo upload (multipart), and a per-camera detection WebSocket at `/cameras/{id}/ws`.
- `supervisor.py` — manages per-camera worker goroutines. Workers run at `idle_fps` (2fps) normally and bump to `active_fps` (8fps) when a WebSocket viewer is attached.
- `worker.py` — connects to Go's frame WebSocket, decodes JPEG frames, calls `recognizer.py`, runs the tracker, and publishes detection events to subscribers.
- `recognizer.py` — InsightFace (`buffalo_l` model). Maintains an in-memory embedding index; `bump_index_version()` triggers a rebuild. Matcher uses cosine similarity on L2-normalized 512-d ArcFace embeddings.
- `tracker.py` — IoU-based SORT tracker with per-track majority-vote identity cache. Smooths recognition over time and suppresses ghost detections from lost tracks.
- `augmentation.py` — generates embedding variants from a single enrollment photo (flips, rotations, brightness shifts) to improve robustness across multiple lighting conditions.
- `persons.py` / `db.py` — person+photo store backed by SQLite at `data/face.db`.
- GPU: OnnxRuntime provider order is TensorRT → CUDA → CoreML → CPU; the recognizer silently skips unsupported providers.

**Face service setup flags:**
```bash
./scripts/setup-face-service.sh           # auto-detect platform
./scripts/setup-face-service.sh --mode gpu  # force GPU (CUDA) install
./scripts/setup-face-service.sh --mode cpu  # force CPU-only install
```

## Frontend (React)

**Commands:**
```bash
cd frontend
npm run dev       # dev server on :5173
npm run build     # tsc + vite build
```

**Stack:** React 19, React Router v7, TanStack Query v5, Zustand, Tailwind CSS, hls.js, Lucide icons.

**Structure:** `src/pages/` for route-level views, `src/components/` for shared UI, `src/store/` for Zustand state, `src/api/` for API calls, `src/types/` for TypeScript types.

Auth token stored in `localStorage` as `sentry_token`. `RequireAuth` wrapper in `App.tsx` guards all non-login routes.

## Mobile (Expo)

**Commands:**
```bash
cd mobile
npx expo start          # dev server
npx expo start --android
npx expo start --ios
```

**Important:** This project uses Expo SDK 56. Read versioned docs at https://docs.expo.dev/versions/v56.0.0/ before modifying Expo-specific code.

**Stack:** Expo 56, React Native 0.85.3, React Navigation (bottom tabs + native stack), `expo-notifications` for push, `expo-secure-store` for token persistence.

**Structure:** `src/context/AuthContext.tsx` manages auth state, `src/navigation/AppNavigator.tsx` is the root navigator, `src/screens/` for screen components, `src/theme/tokens.ts` for design tokens.

Push tokens are registered with the backend (`POST /api/push/register`) with per-subscription preferences for known/unknown person notifications and per-camera filtering.

**Running on a physical iPhone (paid Apple Developer account + EAS):**

The app uses Continuous Native Generation — `ios/` and `android/` are gitignored and regenerated from `app.json` by EAS on every build. Expo Go cannot run this app (SDK 56 + native modules), so use an EAS **development build**:

```bash
npx eas-cli login                                    # once
npx eas-cli device:create                            # register the iPhone (once per device)
npx eas-cli build --profile development --platform ios
# install the resulting build on the phone, then:
cd mobile && npx expo start --dev-client             # hot reload on device
```

Build profiles live in `mobile/eas.json` (`development` = dev client / internal, `preview` = internal, `production` = store). TestFlight: `eas build --profile production --platform ios` then `eas submit --profile production --platform ios` (requires an app record in App Store Connect for bundle id `com.dim.sentry`). Remote push requires an APNs key registered with EAS credentials.

## Testing

**Backend:**
```bash
cd backend && go test ./...
```
Note: there are currently no `*_test.go` files, so this is a no-op until tests are added.

**Face service — manual end-to-end (webcam, no Go backend needed):**
```bash
./face-service/.venv/bin/python tests/manual/webcam_recognize.py
# Flags: --camera-index 1 --threshold 0.4 --fps 12
# Press q or Esc to exit
```
Use this to isolate whether a recognition failure is in the face-service or in the RTSP/FFmpeg/HLS pipeline. `tests/ci/` is reserved for future headless tests.

## Data Flow: Detection → Push Notification

1. Camera RTSP stream → Go `stream/Relay` → FFmpeg → HLS segments + JPEG frame fan-out
2. Face-service `worker` consumes frames via `/api/cameras/:id/frames` WebSocket
3. Worker runs InsightFace recognition and publishes detection events to `/cameras/:id/ws`
4. Go `push/Listener` subscribes to face-service WebSocket per camera
5. On detection: `push/Notifier` looks up Expo push tokens from SQLite and sends batched push via `https://exp.host/push/send`
6. Mobile app receives Expo push notification; foreground banner rendered in `App.tsx`
