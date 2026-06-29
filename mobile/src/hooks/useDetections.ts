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
  ts: string       // ISO timestamp of first appearance
  leftAt?: string  // ISO timestamp when person left (set after STALE_MS of no detections)
}

// Shape of a single detection object sent by the face-service over WS.
// Exported so overlay components can type-check against it.
export type RawDetection = {
  person_id: string | null
  name?: string | null
  score: number
  similarity?: number | null
  bbox: [number, number, number, number]
}

// Shape of the WebSocket message payload
type WsEvent = {
  ts: number  // Unix seconds float from face-service
  detections: RawDetection[]
}

// Internal session tracking — one entry per active person per camera
type ActiveSession = {
  detectionId: string
  leaveTimer: ReturnType<typeof setTimeout> | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MAX_DETECTIONS = 100
// Mark person as "left" after this many ms of no detections
const STALE_MS = 5000

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
  liveBboxes: RawDetection[]
} {
  const { baseUrl, token } = useAuth()

  const [detections, setDetections] = useState<Detection[]>([])
  const [liveBboxes, setLiveBboxes] = useState<RawDetection[]>([])
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Per-person session tracking. Key: `${cameraId}:${personId|"unknown"}`
  const activeSessionsRef = useRef(new Map<string, ActiveSession>())

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
    activeSessionsRef.current.forEach((session) => {
      if (session.leaveTimer) clearTimeout(session.leaveTimer)
    })
    activeSessionsRef.current.clear()
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

        const cameraName = camerasRef.current.find((c) => c.id === id)?.name ?? id
        // face-service sends ts as Unix seconds float — convert to ms for JS Date
        const firstSeenMs = Math.round(payload.ts * 1000)

        for (const det of payload.detections) {
          const personKey = `${id}:${det.person_id ?? 'unknown'}`
          const existing = activeSessionsRef.current.get(personKey)

          if (existing) {
            // Person still in scene — reset the leave timer
            if (existing.leaveTimer) clearTimeout(existing.leaveTimer)
            const { detectionId } = existing
            existing.leaveTimer = setTimeout(() => {
              if (!mountedRef.current) return
              const leftAt = new Date().toISOString()
              setDetections((prev) =>
                prev.map((d) => (d.id === detectionId ? { ...d, leftAt } : d)),
              )
              activeSessionsRef.current.delete(personKey)
            }, STALE_MS)
          } else {
            // New appearance — create a session and add one card to the log
            const detId = `${firstSeenMs}-${det.person_id ?? 'unknown'}-${Math.random().toString(36).slice(2, 7)}`
            const newEntry: Detection = {
              id: detId,
              cameraId: id,
              cameraName,
              personId: det.person_id ?? null,
              name: det.name ?? (det.person_id ? det.person_id : 'Unknown'),
              score: det.score,
              bbox: det.bbox,
              ts: new Date(firstSeenMs).toISOString(),
            }

            const leaveTimer = setTimeout(() => {
              if (!mountedRef.current) return
              const leftAt = new Date().toISOString()
              setDetections((prev) =>
                prev.map((d) => (d.id === detId ? { ...d, leftAt } : d)),
              )
              activeSessionsRef.current.delete(personKey)
            }, STALE_MS)

            activeSessionsRef.current.set(personKey, { detectionId: detId, leaveTimer })
            setDetections((prev) => [newEntry, ...prev].slice(0, MAX_DETECTIONS))
          }
        }
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

    if (staleTimerRef.current) {
      clearTimeout(staleTimerRef.current)
      staleTimerRef.current = null
    }
    setLiveBboxes([])

    activeSessionsRef.current.forEach((session) => {
      if (session.leaveTimer) clearTimeout(session.leaveTimer)
    })
    activeSessionsRef.current.clear()

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

  return { detections, clearDetections, liveBboxes }
}
