# Camera Preview Snapshots — Design

**Date:** 2026-06-30

## Goal

Show a still-image preview of each camera, sourced from the camera's HTTP
snapshot endpoint (e.g. Hikvision ISAPI
`http://user:pass@host/ISAPI/Streaming/channels/102/picture`). The preview is a
single JPEG that we refresh on an interval. Add a configurable `snapshot_url`
per camera, autocomplete it when adding a camera, and surface previews in the
web dashboard and the mobile app.

## Data model

Add `snapshot_url` (string) to the camera record across all three services.

- **Backend** `models/camera.go`: add `SnapshotURL string \`json:"snapshot_url"\``
  to `Camera` and `CreateCameraRequest`; add `SnapshotURL *string
  \`json:"snapshot_url"\`` to `UpdateCameraRequest` and apply it in the handler.
  Persists to `cameras.json` via the existing JSON store — no migration; existing
  cameras get an empty value.
- **Frontend** `types/camera.ts`: add `snapshot_url: string` to `Camera` and
  `snapshot_url?: string` to `CreateCameraPayload`.
- **Mobile** `api/client.ts`: add `snapshot_url: string` to the `Camera` type.

## Autocomplete (frontend Add Camera modal)

When the RTSP field changes and the user has not manually edited the preview
field, derive a Hikvision/ISAPI best guess:

1. Parse `user:pass@host` and channel digits from the RTSP URL.
2. Build `http://user:pass@host/ISAPI/Streaming/channels/<channel>/picture`
   (default channel `101` if none found).

The derived value is written into the editable Preview URL field. Once the user
types into that field, a `touched` flag stops further auto-overwrites.

A live preview renders directly under the field whenever it holds a valid
`http(s)://` URL, using the shared snapshot component, so the user can confirm
before saving.

## Shared snapshot rendering

- **Web** `components/camera/CameraSnapshot.tsx`: renders
  `<img src={url + '?t=' + tick}>`; a `useEffect` interval bumps `tick` every
  **5s**. On load error or empty URL it renders nothing (caller shows its
  existing fallback). Used as the feed layer in `CameraTile.tsx` when
  `snapshot_url` is set; the existing gradient/offline/reconnecting visuals
  remain as fallback and overlays.
- **Mobile** `components/CameraSnapshot.tsx`: RN `<Image>` with a cache-busting
  `uri` refreshed every 5s, with an `onError` fallback to a placeholder.

## Mobile home — list / cards toggle

- Segmented control (grid + list icons) pinned at the top of `HomeScreen`,
  matching the reference screenshot. Selection persisted in `expo-secure-store`
  under a `home_view_mode` key and restored on mount.
- **List** mode = existing `CameraCard` (unchanged).
- **Cards** mode = new `CameraPreviewCard` showing the 5s-refreshing snapshot
  (16:9) with name + status overlaid, single column.
- `FlatList` switches `renderItem` / `key` based on mode.

## Credentials caveat

Snapshot URLs embed credentials (`http://user:pass@host/...`). On the LAN this
generally works for `<img>` and RN `<Image>`. Some browsers strip inline
credentials on cross-origin image requests; if the web preview 401s, follow up
with a small authenticated backend proxy endpoint. Start with the direct
approach.

## Out of scope

- Backend snapshot proxy (only if direct embedding fails).
- Editing `snapshot_url` after creation (no edit-camera modal exists today).
- Snapshot caching / storage server-side.
