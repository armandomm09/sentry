# Mobile Face Detection Overlay — Design Spec
**Date:** 2026-06-29  
**Status:** Approved

## Problem

The mobile app's `CameraDetailScreen` shows a live MJPEG stream but **neither bounding boxes nor detection event cards appear**. Both fail for the same root cause:

1. `useDetections` connects to `/api/face/cameras/:id/ws` — a route that does not exist on the Go backend (only `/persons/*` is proxied to the face-service). The WebSocket connection is rejected, so no detection events reach the app at all.
2. Because no events arrive, the card log is empty and no live bboxes are available.
3. `LiveStreamView` also has no overlay layer, so even if events did arrive they could not be displayed on the video.

## Goals

- Show real-time bounding boxes + name labels directly on the live video.
- Fix the broken detection WebSocket route (unblocks both the card log and bboxes).
- No new npm dependencies.
- Restore the detection card log (currently showing nothing) and add live bbox overlay.

## Architecture

### Backend — WS proxy route

Add one new authenticated WebSocket route:

```
GET /api/face/cameras/:id/ws
```

Registered in `main.go` inside the `authed` group. Implemented in `face/proxy.go` (alongside the existing HTTP reverse-proxy). The handler:

1. Verifies the camera exists in the store.
2. Dials the face-service at `ws://<faceURL>/cameras/:id/ws` using `gorilla/websocket`.
3. Upgrades the incoming mobile connection to WebSocket.
4. Runs two goroutines that copy messages in each direction (mobile→face-service, face-service→mobile) until either side closes.
5. Cleans up both connections on exit.

Auth is enforced by the existing `jwtMgr.RequireAuth()` middleware — no change needed there.

### Mobile — `useDetections` extension

Add two fields to `RawDetection`:
```ts
frame_w: number
frame_h: number
```
(Already included in the face-service's `detections` WS payload; currently not parsed.)

Add `similarity?: number | null` to `RawDetection` (also already in the payload).

New return value from `useDetections`:
```ts
liveBboxes: RawDetection[]   // detections from the most recent WS event; clears after 2500 ms
```

Implementation: on each WS message, if `payload.detections.length > 0`, store them in a ref and set a `setTimeout(2500)` to clear them. The timeout is reset on every new event. This runs inside the existing per-camera socket `onmessage` handler.

The existing `detections: Detection[]` (card log) is unchanged.

### Mobile — `DetectionOverlay` component

New file: `src/components/DetectionOverlay.tsx`

Props:
```ts
type Props = {
  detections: RawDetection[]   // from useDetections liveBboxes
  containerWidth: number
  containerHeight: number
}
```

For each detection:
- A `<View>` with `position: 'absolute'`, `borderWidth: 1.5`, `borderColor` green (`#38d977`) for known / red (`#e83a29`) for unknown, no fill.
- Position computed as `x1 * containerWidth`, `y1 * containerHeight`, `(x2-x1) * containerWidth`, `(y2-y1) * containerHeight`.
- A label `<View>` (`<Text>`) positioned just above the box: shows name (or "Unknown") + similarity % if known, score % if unknown.

No `react-native-svg` needed — standard `<View>` / `<Text>` with absolute positioning.

**Coordinate mapping:** Camera frames are natively 16:9 and the container has `aspectRatio: 16/9`. With `resizeMode="cover"`, the image fills the container with no cropping (matching aspect ratios). Bboxes therefore map directly:
```
x_px = bbox[0] * containerWidth
y_px = bbox[1] * containerHeight
w_px = (bbox[2] - bbox[0]) * containerWidth
h_px = (bbox[3] - bbox[1]) * containerHeight
```
No letterbox offset calculation required.

Container dimensions are obtained via `onLayout` on the outer `<View>` inside `LiveStreamView`.

### Mobile — `LiveStreamView` changes

New optional props:
```ts
showDetections?: boolean
liveBboxes?: RawDetection[]
```

When `showDetections` is true and `liveBboxes` is provided:
- The outer container `<View>` gets `onLayout` to capture `containerWidth` / `containerHeight`.
- `<DetectionOverlay>` is rendered as an `absoluteFill` sibling to `<Image>`.

### Mobile — `CameraDetailScreen` changes

The screen already calls `useDetections([cameraId], cameras)`. It will destructure `liveBboxes` from the hook and pass it to `LiveStreamView`:

```tsx
<LiveStreamView
  cameraId={cameraId}
  cameraName={cameraName}
  showDetections={camera?.face_recognition_enabled ?? false}
  liveBboxes={liveBboxes}
/>
```

`camera` is fetched from the cameras list already loaded in the screen.

## Data Flow

```
Mobile app
  └─ useDetections → WS → /api/face/cameras/:id/ws (backend, authed)
                              └─ WS proxy → face-service :8090 /cameras/:id/ws
                                               └─ detection events (JSON)
  Detection events arrive → useDetections.onmessage
    ├─ append to detections[] (card log, unchanged)
    └─ set liveBboxes (current frame, cleared after 2500 ms)

LiveStreamView
  ├─ <Image> (MJPEG frame, unchanged)
  └─ <DetectionOverlay> (absoluteFill, renders liveBboxes as colored boxes)
```

## Files Changed

| File | Change |
|------|--------|
| `backend/face/proxy.go` | Add `CameraWS` handler (WS bridge) |
| `backend/main.go` | Register `authed.GET("/face/cameras/:id/ws", faceProxy.CameraWS(...))` |
| `mobile/src/hooks/useDetections.ts` | Add `frame_w`/`frame_h`/`similarity` to `RawDetection`; expose `liveBboxes` |
| `mobile/src/components/DetectionOverlay.tsx` | New component |
| `mobile/src/components/LiveStreamView.tsx` | Accept `showDetections` + `liveBboxes`; render overlay; capture layout |
| `mobile/src/screens/CameraDetailScreen.tsx` | Pass `showDetections` + `liveBboxes` to `LiveStreamView` |

## Out of Scope

- Timestamp synchronization (not needed — mobile MJPEG latency is <1 s)
- Web overlay changes (already working)
- HomeScreen / grid-view overlays
