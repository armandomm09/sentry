# Mobile Face Detection Overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken detection WebSocket route in the Go backend, then render real-time face-detection bounding boxes on top of the mobile live stream.

**Architecture:** The Go backend gets a new authenticated WS proxy route (`GET /api/face/cameras/:id/ws`) that bridges the mobile client to the face-service's per-camera detection WebSocket. The mobile `useDetections` hook is extended to expose the current frame's detections (`liveBboxes`) in addition to the existing log list. A new `DetectionOverlay` component uses absolute-positioned `<View>`/`<Text>` to draw colored boxes and name labels over the live JPEG frame.

**Tech Stack:** Go 1.21, gorilla/websocket v1.5.3, Gin, Expo SDK 56, React Native 0.85.3 (TypeScript).

## Global Constraints

- No new npm packages — use only `react-native` built-ins already in the project.
- No new Go dependencies — `gorilla/websocket` is already in `go.mod`.
- Mobile code lives under `mobile/src/`; backend code under `backend/`.
- The `Camera` type in `mobile/src/api/client.ts` uses `face_recognition: boolean` (not `face_recognition_enabled`).
- Go working directory for all `go` commands: `backend/`.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/face/proxy.go` | Modify | Add `CameraChecker` interface + `CameraWS` handler |
| `backend/main.go` | Modify | Register `GET /api/face/cameras/:id/ws` in the `authed` group |
| `mobile/src/hooks/useDetections.ts` | Modify | Export `RawDetection`; add `similarity`; expose `liveBboxes` |
| `mobile/src/components/DetectionOverlay.tsx` | Create | Render bbox rectangles + labels over the video |
| `mobile/src/components/LiveStreamView.tsx` | Modify | Accept `showDetections` + `liveBboxes`; capture layout; render overlay |
| `mobile/src/screens/CameraDetailScreen.tsx` | Modify | Destructure `liveBboxes`; find `camera`; pass props to `LiveStreamView` |

---

## Task 1: Backend WebSocket Proxy

**Files:**
- Modify: `backend/face/proxy.go`
- Modify: `backend/main.go`

**Interfaces:**
- Produces: `func (p *Proxy) CameraWS(store CameraChecker) gin.HandlerFunc` — registered at `GET /api/face/cameras/:id/ws` (auth protected)

- [ ] **Step 1: Add `CameraChecker` interface and `CameraWS` to `face/proxy.go`**

Open `backend/face/proxy.go`. After the closing brace of `RunSyncLoop`, append:

```go
// CameraChecker is the subset of *storage.JSONStore used by CameraWS.
type CameraChecker interface {
	Get(id string) (*models.Camera, bool)
}

var faceWSUpgrader = websocket.Upgrader{
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 256 * 1024,
}

// CameraWS proxies the face-service per-camera detection WebSocket to the caller.
// The route must be registered behind jwtMgr.RequireAuth() — auth is not checked here.
func (p *Proxy) CameraWS(store CameraChecker) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		if _, ok := store.Get(id); !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "camera not found"})
			return
		}

		// Convert base URL from http:// → ws:// (or https: → wss:)
		base := p.client.BaseURL()
		wsBase := strings.Replace(base, "https://", "wss://", 1)
		wsBase = strings.Replace(wsBase, "http://", "ws://", 1)
		faceWS := wsBase + "/cameras/" + id + "/ws"

		upstream, _, err := websocket.DefaultDialer.Dial(faceWS, nil)
		if err != nil {
			log.Printf("[face-ws] dial %s: %v", faceWS, err)
			c.JSON(http.StatusBadGateway, gin.H{"error": "face-service unavailable"})
			return
		}
		defer upstream.Close()

		downstream, err := faceWSUpgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			// Upgrade writes its own error response.
			return
		}
		defer downstream.Close()

		done := make(chan struct{}, 2)

		// face-service → mobile
		go func() {
			defer func() { done <- struct{}{} }()
			for {
				mt, msg, err := upstream.ReadMessage()
				if err != nil {
					return
				}
				if err := downstream.WriteMessage(mt, msg); err != nil {
					return
				}
			}
		}()

		// mobile → face-service (detects client disconnect)
		go func() {
			defer func() { done <- struct{}{} }()
			for {
				if _, _, err := downstream.ReadMessage(); err != nil {
					return
				}
			}
		}()

		<-done
	}
}
```

The existing import block already has `"strings"`, `"log"`, `"net/http"`, and `"github.com/gin-gonic/gin"`. Add `"github.com/gorilla/websocket"` to the import block.

- [ ] **Step 2: Register the route in `main.go`**

In `backend/main.go`, inside the `authed` block, after the `authed.GET("/streams", ...)` line and before the persons proxy lines, add:

```go
// Face-service detection WebSocket — proxied and auth-protected
authed.GET("/face/cameras/:id/ws", faceProxy.CameraWS(store))
```

- [ ] **Step 3: Build the backend to verify no compile errors**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/backend && go build ./...
```

Expected: no output (clean build).

- [ ] **Step 4: Smoke-test the new route manually**

With the system running (`./run.sh` from the project root), pick a camera ID from the dashboard. Run:

```bash
# Replace <ID> and <TOKEN> with a real camera ID and a valid JWT
curl -v -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Authorization: Bearer <TOKEN>" \
  http://localhost:8080/api/face/cameras/<ID>/ws
```

Expected: HTTP 101 Switching Protocols (not 404 or 401). Detection JSON lines will print to stdout as faces are detected.

- [ ] **Step 5: Commit**

```bash
git add backend/face/proxy.go backend/main.go
git commit -m "feat(backend): proxy face-service detection WS at /api/face/cameras/:id/ws"
```

---

## Task 2: Extend `useDetections` with `liveBboxes`

**Files:**
- Modify: `mobile/src/hooks/useDetections.ts`

**Interfaces:**
- Produces:
  - `export type RawDetection` — now exported, with new optional field `similarity?: number | null`
  - Hook return type gains `liveBboxes: RawDetection[]`

- [ ] **Step 1: Export `RawDetection` and add `similarity`**

Replace the existing `RawDetection` type (lines 20–25 of the current file):

```ts
// Shape of a single detection object sent by the face-service over WS.
// Exported so overlay components can type-check against it.
export type RawDetection = {
  person_id: string | null
  name?: string | null
  score: number
  similarity?: number | null
  bbox: [number, number, number, number]
}
```

- [ ] **Step 2: Add `liveBboxes` state and stale-clear timer ref**

Inside the `useDetections` function body, after the existing `const [detections, ...]` line, add:

```ts
const [liveBboxes, setLiveBboxes] = useState<RawDetection[]>([])
const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
```

- [ ] **Step 3: Update `ws.onmessage` to populate `liveBboxes`**

The current `onmessage` handler (around line 88) skips the event when `payload.detections.length === 0`. Change it so the live bbox update happens for every event (both empty and non-empty), but only set bboxes when there are detections:

Replace the current `ws.onmessage` handler body with:

```ts
ws.onmessage = (event: MessageEvent) => {
  if (!mountedRef.current) return

  let payload: WsEvent
  try {
    payload = JSON.parse(event.data as string) as WsEvent
  } catch {
    return
  }

  // Update live bbox state (clears after 2500 ms with no new detections)
  if (Array.isArray(payload.detections) && payload.detections.length > 0) {
    setLiveBboxes(payload.detections)
    if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
    staleTimerRef.current = setTimeout(() => {
      setLiveBboxes([])
      staleTimerRef.current = null
    }, 2500)
  }

  if (!Array.isArray(payload.detections) || payload.detections.length === 0) return

  const cameraName =
    camerasRef.current.find((c) => c.id === id)?.name ?? id

  const newEntries: Detection[] = payload.detections.map((det) => ({
    id: `${payload.ts}-${det.person_id ?? 'unknown'}-${Math.random().toString(36).slice(2, 7)}`,
    cameraId: id,
    cameraName,
    personId: det.person_id ?? null,
    name: det.name ?? (det.person_id ? det.person_id : 'Unknown'),
    score: det.score,
    bbox: det.bbox,
    ts: payload.ts,
  }))

  setDetections((prev) => [...newEntries, ...prev].slice(0, MAX_DETECTIONS))
}
```

- [ ] **Step 4: Clear stale timer in `teardownAll`**

Inside the existing `teardownAll` callback, after `timersRef.current.clear()`, add:

```ts
if (staleTimerRef.current) {
  clearTimeout(staleTimerRef.current)
  staleTimerRef.current = null
}
setLiveBboxes([])
```

- [ ] **Step 5: Return `liveBboxes` from the hook**

Change the return statement at the bottom of the hook from:

```ts
return { detections, clearDetections }
```

to:

```ts
return { detections, clearDetections, liveBboxes }
```

Also update the function's return type annotation:

```ts
export function useDetections(
  cameraIds: string[],
  cameras: Camera[],
): {
  detections: Detection[]
  clearDetections: () => void
  liveBboxes: RawDetection[]
}
```

- [ ] **Step 6: Commit**

```bash
git add mobile/src/hooks/useDetections.ts
git commit -m "feat(mobile): expose liveBboxes from useDetections, export RawDetection type"
```

---

## Task 3: `DetectionOverlay` Component

**Files:**
- Create: `mobile/src/components/DetectionOverlay.tsx`

**Interfaces:**
- Consumes: `RawDetection` from `../hooks/useDetections`
- Produces: `export default function DetectionOverlay(props: Props): React.JSX.Element | null`

  Props:
  ```ts
  type Props = {
    detections: RawDetection[]
    containerWidth: number
    containerHeight: number
  }
  ```

- [ ] **Step 1: Create the file**

Create `mobile/src/components/DetectionOverlay.tsx`:

```tsx
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { RawDetection } from '../hooks/useDetections'

type Props = {
  detections: RawDetection[]
  containerWidth: number
  containerHeight: number
}

const KNOWN_COLOR = '#38d977'
const UNKNOWN_COLOR = '#e83a29'

export default function DetectionOverlay({
  detections,
  containerWidth,
  containerHeight,
}: Props): React.JSX.Element | null {
  if (!detections.length) return null

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {detections.map((det, i) => {
        const [x1, y1, x2, y2] = det.bbox
        const left = x1 * containerWidth
        const top = y1 * containerHeight
        const width = (x2 - x1) * containerWidth
        const height = (y2 - y1) * containerHeight

        const isKnown = det.person_id !== null
        const color = isKnown ? KNOWN_COLOR : UNKNOWN_COLOR
        const label = isKnown ? (det.name ?? 'Known') : 'Unknown'
        const pct = isKnown
          ? det.similarity != null
            ? `${Math.round(det.similarity * 100)}%`
            : ''
          : `${Math.round(det.score * 100)}%`

        return (
          <View
            key={i}
            style={[styles.box, { left, top, width, height, borderColor: color }]}
          >
            <View style={[styles.labelBg, { backgroundColor: color }]}>
              <Text style={styles.labelText}>
                {label}
                {pct ? `  ${pct}` : ''}
              </Text>
            </View>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    borderWidth: 1.5,
    borderRadius: 2,
  },
  labelBg: {
    position: 'absolute',
    top: -20,
    left: -1,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 2,
  },
  labelText: {
    color: '#000000',
    fontSize: 10,
    fontWeight: '700',
  },
})
```

- [ ] **Step 2: Commit**

```bash
git add mobile/src/components/DetectionOverlay.tsx
git commit -m "feat(mobile): add DetectionOverlay component for face bbox rendering"
```

---

## Task 4: Overlay Integration in `LiveStreamView`

**Files:**
- Modify: `mobile/src/components/LiveStreamView.tsx`

**Interfaces:**
- Consumes:
  - `DetectionOverlay` from `./DetectionOverlay`
  - `RawDetection` from `../hooks/useDetections`
- Produces: Updated `Props` with two new optional fields:
  ```ts
  showDetections?: boolean
  liveBboxes?: RawDetection[]
  ```

- [ ] **Step 1: Update the file**

Replace the entire contents of `mobile/src/components/LiveStreamView.tsx` with:

```tsx
import React, { useState } from 'react'
import {
  ActivityIndicator,
  Image,
  LayoutChangeEvent,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'

import { useCameraStream } from '../hooks/useCameraStream'
import tokens from '../theme/tokens'
import DetectionOverlay from './DetectionOverlay'
import type { RawDetection } from '../hooks/useDetections'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
type Props = {
  cameraId: string
  cameraName: string
  showDetections?: boolean
  liveBboxes?: RawDetection[]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function LiveStreamView({
  cameraId,
  cameraName,
  showDetections = false,
  liveBboxes = [],
}: Props): React.JSX.Element {
  const { frameUri, connected, error } = useCameraStream(cameraId)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  const handleLayout = (e: LayoutChangeEvent) => {
    setContainerSize({
      width: e.nativeEvent.layout.width,
      height: e.nativeEvent.layout.height,
    })
  }

  return (
    <View style={styles.container} onLayout={handleLayout}>
      {/* Loading state */}
      {frameUri === null && error === null && (
        <View style={styles.centered}>
          <ActivityIndicator color="#ffffff" size="large" />
        </View>
      )}

      {/* Error state */}
      {error !== null && (
        <View style={styles.centered}>
          <Ionicons name="wifi-outline" size={40} color={tokens.colors.textMuted} />
          <Text style={styles.errorText}>Connection lost</Text>
        </View>
      )}

      {/* Live frame */}
      {frameUri !== null && (
        <Image
          key={cameraId}
          source={{ uri: frameUri }}
          style={styles.image}
          resizeMode="cover"
        />
      )}

      {/* Detection overlay */}
      {showDetections && containerSize.width > 0 && (
        <DetectionOverlay
          detections={liveBboxes}
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
        />
      )}

      {/* Status pill */}
      <View style={styles.overlay}>
        <View style={styles.pill}>
          <View
            style={[
              styles.dot,
              { backgroundColor: connected ? tokens.colors.online : tokens.colors.danger },
            ]}
          />
          <Text style={styles.cameraName}>{cameraName}</Text>
        </View>
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  container: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#000000',
  },
  centered: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    color: tokens.colors.textMuted,
    fontSize: tokens.fontSize.sm,
    marginTop: 8,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  pill: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 20,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cameraName: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
})
```

- [ ] **Step 2: Commit**

```bash
git add mobile/src/components/LiveStreamView.tsx
git commit -m "feat(mobile): wire DetectionOverlay into LiveStreamView"
```

---

## Task 5: Wire `CameraDetailScreen`

**Files:**
- Modify: `mobile/src/screens/CameraDetailScreen.tsx`

**Interfaces:**
- Consumes:
  - `liveBboxes` from `useDetections` (Task 2)
  - `LiveStreamView` now accepts `showDetections` + `liveBboxes` (Task 4)

- [ ] **Step 1: Update `CameraDetailScreen.tsx`**

Replace the entire file with:

```tsx
import React, { useCallback, useEffect, useState } from 'react'
import {
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'

import type { HomeStackParamList } from '../navigation/types'
import type { Camera } from '../api/client'
import { getCameras } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useDetections } from '../hooks/useDetections'
import type { Detection } from '../hooks/useDetections'
import tokens from '../theme/tokens'
import LiveStreamView from '../components/LiveStreamView'
import DetectionCard from '../components/DetectionCard'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Props = NativeStackScreenProps<HomeStackParamList, 'CameraDetailScreen'>

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
export default function CameraDetailScreen({ route, navigation }: Props): React.JSX.Element {
  const { cameraId, cameraName } = route.params
  const { baseUrl, token } = useAuth()

  const [cameras, setCameras] = useState<Camera[]>([])

  useEffect(() => {
    navigation.setOptions({ title: cameraName })
  }, [navigation, cameraName])

  useEffect(() => {
    if (!baseUrl || !token) return
    void getCameras(baseUrl, token)
      .then(setCameras)
      .catch(() => {
        // Non-fatal; camera name resolution degrades gracefully
      })
  }, [baseUrl, token])

  const { detections, liveBboxes } = useDetections([cameraId], cameras)

  const camera = cameras.find((c) => c.id === cameraId)

  const renderItem = useCallback(
    ({ item }: { item: Detection }) => <DetectionCard detection={item} />,
    [],
  )

  const keyExtractor = useCallback((item: Detection) => item.id, [])

  const ListHeader = (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>Detections</Text>
      <Text style={styles.sectionCount}>{detections.length} events</Text>
    </View>
  )

  const ListEmpty = (
    <View style={styles.emptyState}>
      <Text style={styles.emptyText}>No detections yet</Text>
    </View>
  )

  return (
    <View style={styles.container}>
      <FlatList<Detection>
        data={detections}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={
          <>
            <LiveStreamView
              cameraId={cameraId}
              cameraName={cameraName}
              showDetections={camera?.face_recognition ?? false}
              liveBboxes={liveBboxes}
            />
            {ListHeader}
          </>
        }
        ListEmptyComponent={ListEmpty}
        contentContainerStyle={styles.listContent}
      />
    </View>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.colors.bg,
  },
  sectionHeader: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: tokens.colors.text,
  },
  sectionCount: {
    fontSize: 13,
    color: tokens.colors.textMuted,
    marginTop: 2,
  },
  listContent: {
    paddingBottom: 16,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 32,
  },
  emptyText: {
    fontSize: 15,
    color: tokens.colors.textMuted,
  },
})
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /home/armandomm09/monitoreo_hogar/sentry/mobile && npx tsc --noEmit 2>&1 | head -40
```

Expected: no errors. If you see an error about `LayoutChangeEvent` not found, add `LayoutChangeEvent` to the react-native imports in `LiveStreamView.tsx` (it should already be there from Task 4).

- [ ] **Step 3: Commit**

```bash
git add mobile/src/screens/CameraDetailScreen.tsx
git commit -m "feat(mobile): wire detection overlay — bbox + card log now functional"
```

---

## End-to-End Verification

After all tasks are complete:

1. Start the full system: `./run.sh` from the repo root.
2. Open the mobile app and navigate to a camera that has face recognition enabled.
3. Walk in front of the camera. Within ~1 s you should see:
   - Green box (known person) or red box (unknown) drawn directly on the video frame.
   - Name + similarity % label above the box.
   - The box disappears ~2.5 s after the face leaves frame.
   - The detection card log below the video starts accumulating events.
4. Navigate away and back — the WebSocket reconnects automatically.

---

## Self-Review

**Spec coverage:**
- ✅ Backend WS proxy route — Task 1
- ✅ Card log restored (it was broken for the same reason as bboxes; fixed by Task 1 + Task 2) — Tasks 1–2
- ✅ `liveBboxes` exposed by hook — Task 2
- ✅ `DetectionOverlay` component — Task 3
- ✅ Overlay rendered in `LiveStreamView` — Task 4
- ✅ `CameraDetailScreen` wired — Task 5
- ✅ No new npm dependencies — only `react-native` built-ins used
- ✅ `face_recognition` (not `face_recognition_enabled`) used in Task 5

**Placeholder scan:** None found.

**Type consistency:**
- `RawDetection` exported in Task 2; imported in Tasks 3 and 4. ✅
- `liveBboxes: RawDetection[]` returned in Task 2; consumed in Task 5 and passed to `LiveStreamView` in Task 4. ✅
- `DetectionOverlay` props (`detections`, `containerWidth`, `containerHeight`) defined in Task 3; caller in Task 4 passes exact same names. ✅
- `LiveStreamView` new props (`showDetections`, `liveBboxes`) defined in Task 4; caller in Task 5 passes exact same names. ✅
