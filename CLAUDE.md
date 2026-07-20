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

**Key env vars:** `SENTRY_DATA_DIR` (default `./data`), `SENTRY_DB_PATH`, `PORT` (default `8080`), `FACE_SERVICE_URL` (default `http://127.0.0.1:8090`), `JWT_SECRET`, `SENTRY_CLIP_RETENTION_HOURS` (default `72`), `SENTRY_EVENT_RETENTION_DAYS` (default `90`).

**Default credentials on first run:** `admin` / `sentry123`

**Architecture:**
- `main.go` wires all components. Routes under `/api` require JWT auth except `/api/auth/login` and the `/api/cameras/:id/frames` WebSocket (consumed by face-service). User management under `/api/users` additionally requires the admin role.
- `stream/` — each camera gets a `Relay` that FFmpeg-transcodes RTSP to HLS segments written to `/tmp/sentry/streams/<camera-id>/`. Frames are also fanned out to subscribers via channels for the face-service to consume.
- `face/` — `client.go` calls the Python face-service REST API; `proxy.go` reverse-proxies `/api/persons/*` and `/api/augmentation/*` to it and `/face/cameras/{id}/ws` (detection WebSocket) to the face-service's `/cameras/{id}/ws`. `SyncFromStore` + `RunSyncLoop` keep face-service's camera list in sync with `cameras.json`.
- `push/` — `listener.go` subscribes to the face-service detection WebSocket per camera and emits one notification per sighting event on `track_confirmed` (per-frame `detections` never notify); `notifier.go` evaluates each subscription's notification policy — `every` (default), `quiet_period` (suppress if the person was seen less than `known_quiet_hours`/`unknown_quiet_hours` ago; per person across cameras for knowns, per camera for unknowns), `first_of_day` (first sighting per local calendar day) — reading last-seen state from the events table, then sends batched push via the Expo Push API with `event_id` in the payload. Policy is configured per subscription via `POST /api/push/register` (`notify_known_mode`, `notify_unknown_mode`, `known_quiet_hours`, `unknown_quiet_hours`).
- `events/` — sighting events. `recorder.go` consumes track lifecycle messages (`track_confirmed`/`track_updated`/`track_ended`) dispatched by `push/listener.go`, persisting one event per confirmed track with a best-face thumbnail (`data/thumbs/`). `clips.go` copies live HLS segments from confirm time (pre-roll ≈ 10s) until track end + 5s and stitches them losslessly into `data/clips/<event_id>.mp4` (cap 2 min). `retention.go` expires clips after `SENTRY_CLIP_RETENTION_HOURS` and deletes event rows + thumbs after `SENTRY_EVENT_RETENTION_DAYS`. REST surface: `/api/events` (list/detail/thumb/clip/label — labeling enrolls the crop via the face-service and retro-labels matching unknowns).
- `storage/json_store.go` — camera config persisted to `data/cameras.json`. Cameras have an optional `snapshot_url` (HTTP JPEG endpoint) used by the frontend's per-camera snapshot preview (`CameraSnapshot.tsx`) without starting a full HLS stream.
- `db/db.go` — SQLite (`modernc.org/sqlite`) for users and push subscriptions.
- HLS segments are served statically at `/hls` → `/tmp/sentry/streams/`.

## Face Service (Python)

**Key env vars:** `FACE_SERVICE_HOST`, `FACE_SERVICE_PORT` (default `8090`), `FACE_SERVICE_DATA_DIR`, `FACE_SERVICE_MODEL` (default `buffalo_l`), `FACE_SERVICE_MATCH_THRESHOLD` (default `0.42`, enrollment only), `FACE_SERVICE_ACQUIRE_THRESHOLD` (default `0.45`), `FACE_SERVICE_KEEP_THRESHOLD` (default `0.35`), `FACE_SERVICE_PROVIDERS` (comma-separated ORT providers), `FACE_SERVICE_RELAY_URL` (default `ws://127.0.0.1:8080`).

**Architecture:**
- `server.py` — aiohttp app factory. Routes for persons CRUD, photo upload (multipart), and a per-camera detection WebSocket at `/cameras/{id}/ws`.
- `supervisor.py` — manages per-camera worker goroutines. Workers run at `idle_fps` (2fps) normally and bump to `active_fps` (8fps) when a WebSocket viewer is attached.
- `worker.py` — connects to Go's frame WebSocket, decodes JPEG frames, calls `recognizer.py`, runs the tracker, and publishes detection events to subscribers.
- `recognizer.py` — InsightFace (`buffalo_l` model). Maintains an in-memory embedding index; `bump_index_version()` triggers a rebuild. Matcher uses cosine similarity on L2-normalized 512-d ArcFace embeddings.
- `tracker.py` — IoU-based SORT tracker with a sticky-identity state machine (`pending → known | unknown`). Quality gating (face ≥ `FACE_SERVICE_MIN_VOTE_FACE_PX` px tall, det score ≥ `FACE_SERVICE_MIN_VOTE_DET_SCORE`) decides which frames may vote; identities acquire at `FACE_SERVICE_ACQUIRE_THRESHOLD` and are kept at `FACE_SERVICE_KEEP_THRESHOLD` (hysteresis); "unknown" requires `FACE_SERVICE_UNKNOWN_MIN_AGE_S` seconds and `FACE_SERVICE_UNKNOWN_MIN_VOTES` quality votes. A known track never reverts to unknown.
- `lifecycle.py` — `LifecycleEmitter` turns tracker state transitions into `track_confirmed`/`track_updated`/`track_ended` WS messages carrying the track's best face crop (JPEG, chosen by area × det score × sharpness) and its embedding. Consumed by the Go backend's event recorder.
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
npx tsc --noEmit        # typecheck (no lint/test scripts exist for mobile)
```

**Important:** This project uses Expo SDK 56. Read versioned docs at https://docs.expo.dev/versions/v56.0.0/ before modifying Expo-specific code. `mobile/AGENTS.md` repeats this warning — Expo APIs change between versions, so always consult the v56 docs rather than relying on prior knowledge.

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

Build profiles live in `mobile/eas.json` (`development` = dev client / internal, `preview` = internal, `production` = store). App versioning uses `appVersionSource: remote` — EAS auto-increments the iOS build number on production builds, so don't bump it in `app.json`. TestFlight: `eas build --profile production --platform ios` then `eas submit --profile production --platform ios` (requires an app record in App Store Connect for bundle id `com.dim.sentry`). Remote push requires an APNs key registered with EAS credentials.

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

**Fake camera sources for local dev (no real camera needed):**
```bash
python3 scripts/webcam_rtsp.py     # webcam → RTSP at rtsp://localhost:8554/<path> (auto-downloads mediamtx)
./face-service/.venv/bin/python scripts/webcam_ws.py   # webcam → WebSocket JPEG frames at ws://localhost:8765
./face-service/.venv/bin/python scripts/test_ws.py <ws-url>  # verify any frame WebSocket is sending
```
Add the resulting URL as a camera in Sentry to exercise the full pipeline.

## Data Flow: Detection → Push Notification

1. Camera RTSP stream → Go `stream/Relay` → FFmpeg → HLS segments + JPEG frame fan-out
2. Face-service `worker` consumes frames via `/api/cameras/:id/frames` WebSocket
3. Worker runs InsightFace recognition and publishes detection events to `/cameras/:id/ws`
4. Go `push/Listener` subscribes to face-service WebSocket per camera
5. On `track_confirmed`: `push/Notifier` evaluates each subscription's notification policy (every / quiet_period / first_of_day) against the events table, looks up Expo push tokens from SQLite, and sends batched push via `https://exp.host/push/send` with `event_id` in the payload
6. Mobile app receives Expo push notification; foreground banner rendered in `App.tsx`
