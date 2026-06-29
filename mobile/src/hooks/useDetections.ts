import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import type { Camera } from '../api/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Detection = {
  id: string
  cameraId: string
  cameraName: string
  personId: string | null
  name: string
  score: number
  bbox: [number, number, number, number]
  ts: string
}

// Shape of a single detection object sent by the face-service over WS
type RawDetection = {
  person_id: string | null
  name?: string | null
  score: number
  bbox: [number, number, number, number]
}

// Shape of the WebSocket message payload
type WsEvent = {
  ts: string
  detections: RawDetection[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MAX_DETECTIONS = 100

function toWsUrl(httpUrl: string, path: string): string {
  return httpUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') + path
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useDetections(
  cameraIds: string[],
  cameras: Camera[],
): {
  detections: Detection[]
  clearDetections: () => void
} {
  const { baseUrl, token } = useAuth()

  const [detections, setDetections] = useState<Detection[]>([])

  // Map from cameraId → WebSocket
  const socketsRef = useRef<Map<string, WebSocket>>(new Map())
  // Map from cameraId → reconnect timer
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const mountedRef = useRef(true)

  // Keep a stable ref to cameras so WS callbacks don't capture stale lists
  const camerasRef = useRef<Camera[]>(cameras)
  useEffect(() => {
    camerasRef.current = cameras
  }, [cameras])

  // Keep a stable ref to the current cameraIds set for reconnect checks
  const cameraIdsRef = useRef<string[]>(cameraIds)

  const clearDetections = useCallback(() => {
    setDetections([])
  }, [])

  const connectCamera = useCallback(
    (id: string) => {
      if (!baseUrl || !token) return

      const url = toWsUrl(baseUrl, `/api/face/cameras/${id}/ws`)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws = new (WebSocket as any)(url, [], {
        headers: { Authorization: `Bearer ${token}` },
      }) as WebSocket

      socketsRef.current.set(id, ws)

      ws.onmessage = (event: MessageEvent) => {
        if (!mountedRef.current) return

        let payload: WsEvent
        try {
          payload = JSON.parse(event.data as string) as WsEvent
        } catch {
          return
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

      ws.onerror = () => {
        // Error will be followed by onclose; no separate action needed
      }

      ws.onclose = () => {
        if (!mountedRef.current) return
        // Reconnect only if this cameraId is still in the active set
        if (!cameraIdsRef.current.includes(id)) return

        const timer = setTimeout(() => {
          if (mountedRef.current && cameraIdsRef.current.includes(id)) {
            connectCamera(id)
          }
        }, 2000)
        timersRef.current.set(id, timer)
      }
    },
    [baseUrl, token],
  )

  // Teardown helper: close all sockets and clear all timers
  const teardownAll = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer))
    timersRef.current.clear()

    socketsRef.current.forEach((ws) => {
      ws.onclose = null
      ws.onerror = null
      ws.close()
    })
    socketsRef.current.clear()
  }, [])

  useEffect(() => {
    mountedRef.current = true
    cameraIdsRef.current = cameraIds

    // Tear down all previous sockets before re-establishing
    teardownAll()

    cameraIds.forEach((id) => {
      connectCamera(id)
    })

    return () => {
      mountedRef.current = false
      teardownAll()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    // Stringify so effect re-runs only when the actual IDs change, not on every array reference
    // eslint-disable-next-line react-hooks/exhaustive-deps
    JSON.stringify(cameraIds),
    connectCamera,
    teardownAll,
  ])

  return { detections, clearDetections }
}
