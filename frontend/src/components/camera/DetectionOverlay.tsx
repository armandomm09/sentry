/**
 * SVG overlay that draws bounding boxes + names on top of the HLS video.
 *
 * Connects to the face-service WebSocket at /face/cameras/{cameraId}/ws.
 * The mere presence of this connection signals "viewer attached" to face-service,
 * which automatically bumps the worker from idle FPS to active FPS. Closing the
 * WS (component unmount) drops it back to idle.
 *
 * Coordinate mapping: detection events carry frame_w/frame_h (the dimensions the
 * worker processed) and normalized bboxes in [0, 1]. We replicate object-contain
 * letterboxing inside our own bounds so boxes stay aligned with what the user
 * sees in the <video> element, without needing access to that element.
 */

import { useEffect, useRef, useState } from 'react'

interface Detection {
  bbox: [number, number, number, number] // x1, y1, x2, y2 normalized
  score: number
  person_id: string | null
  name: string | null
  similarity: number | null
}

interface DetectionEvent {
  type: 'detections' | 'hello' | 'error'
  camera_id?: string
  ts?: number
  frame_w?: number
  frame_h?: number
  detections?: Detection[]
  message?: string
}

interface Props {
  cameraId: string
  /** When false the overlay renders nothing and does not open a WebSocket. */
  enabled: boolean
}

// Drop detections older than this so the boxes don't linger when face-rec stalls.
const STALE_MS = 2500

export function DetectionOverlay({ cameraId, enabled }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ w: 0, h: 0 })
  const [event, setEvent] = useState<DetectionEvent | null>(null)
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('closed')

  // -- size tracking (own element) --
  useEffect(() => {
    if (!wrapRef.current) return
    const el = wrapRef.current
    const update = () => setBounds({ w: el.clientWidth, h: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // -- WebSocket lifecycle --
  useEffect(() => {
    if (!enabled) return
    setStatus('connecting')

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${window.location.host}/face/cameras/${cameraId}/ws`

    let ws: WebSocket | null = null
    let retryTimer: number | undefined
    let stopped = false

    const connect = () => {
      ws = new WebSocket(url)
      ws.onopen = () => setStatus('open')
      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data) as DetectionEvent
          if (data.type === 'detections') {
            setEvent(data)
          } else if (data.type === 'error') {
            setStatus('error')
          }
        } catch {
          /* ignore malformed frames */
        }
      }
      ws.onerror = () => setStatus('error')
      ws.onclose = () => {
        setStatus('closed')
        if (stopped) return
        // Backoff and reconnect — face-service may have restarted, or the camera
        // toggled face-rec off and back on.
        retryTimer = window.setTimeout(connect, 2000)
      }
    }

    connect()
    return () => {
      stopped = true
      if (retryTimer) window.clearTimeout(retryTimer)
      if (ws) {
        ws.onclose = null
        ws.close()
      }
    }
  }, [cameraId, enabled])

  // -- stale eviction --
  useEffect(() => {
    if (!event) return
    const t = window.setTimeout(() => {
      // After STALE_MS without a new event, clear detections to avoid leaving
      // ghost boxes on the feed.
      setEvent((prev) => (prev === event ? { ...prev, detections: [] } : prev))
    }, STALE_MS)
    return () => window.clearTimeout(t)
  }, [event])

  if (!enabled) return null

  const detections = event?.detections ?? []
  const frameW = event?.frame_w ?? 0
  const frameH = event?.frame_h ?? 0

  // Compute the rect inside `bounds` that the video actually occupies under
  // object-contain. Until we know the frame aspect we just fall back to the
  // full bounds — boxes will appear once the first event arrives.
  const rect = computeContainRect(bounds.w, bounds.h, frameW, frameH)

  return (
    <div
      ref={wrapRef}
      className="absolute inset-0 pointer-events-none"
      aria-hidden="true"
    >
      {/* Status pill — only show when actively connecting or errored */}
      {status !== 'open' && status !== 'closed' && (
        <div className="absolute top-3 right-3 px-2 py-1 rounded-md bg-black/55 backdrop-blur-sm border border-white/10">
          <span className="font-mono text-[10px] uppercase tracking-[0.10em] text-status-warn">
            {status === 'connecting' ? 'connecting…' : 'face service error'}
          </span>
        </div>
      )}

      {/* Boxes + labels */}
      <svg
        className="absolute inset-0 w-full h-full"
        viewBox={`0 0 ${Math.max(bounds.w, 1)} ${Math.max(bounds.h, 1)}`}
        preserveAspectRatio="none"
      >
        {detections.map((d, i) => {
          const x = rect.offsetX + d.bbox[0] * rect.width
          const y = rect.offsetY + d.bbox[1] * rect.height
          const w = (d.bbox[2] - d.bbox[0]) * rect.width
          const h = (d.bbox[3] - d.bbox[1]) * rect.height
          const matched = !!d.name
          const stroke = matched ? '#38d977' : '#e83a29'

          return (
            <g key={i}>
              <rect
                x={x} y={y} width={w} height={h}
                fill="none"
                stroke={stroke}
                strokeWidth={1.5}
                rx={2}
                opacity={0.95}
              />
              {/* corner ticks for that operational look */}
              <CornerTicks x={x} y={y} w={w} h={h} color={stroke} />
              {/* Label */}
              <LabelBadge
                x={x}
                y={y}
                text={matched ? d.name! : 'Unknown'}
                sub={matched
                  ? d.similarity != null ? `${Math.round(d.similarity * 100)}%` : ''
                  : `${Math.round(d.score * 100)}%`
                }
                matched={matched}
              />
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function computeContainRect(boundsW: number, boundsH: number, frameW: number, frameH: number) {
  if (frameW <= 0 || frameH <= 0 || boundsW <= 0 || boundsH <= 0) {
    return { offsetX: 0, offsetY: 0, width: boundsW, height: boundsH }
  }
  const frameAspect = frameW / frameH
  const boundsAspect = boundsW / boundsH
  if (frameAspect > boundsAspect) {
    const width = boundsW
    const height = boundsW / frameAspect
    return { offsetX: 0, offsetY: (boundsH - height) / 2, width, height }
  }
  const height = boundsH
  const width = boundsH * frameAspect
  return { offsetX: (boundsW - width) / 2, offsetY: 0, width, height }
}

function CornerTicks({ x, y, w, h, color }: { x: number; y: number; w: number; h: number; color: string }) {
  const len = Math.max(6, Math.min(w, h) * 0.16)
  const t = 1.5
  // four L-shaped ticks
  return (
    <g stroke={color} strokeWidth={t} fill="none">
      <path d={`M${x},${y + len} L${x},${y} L${x + len},${y}`} />
      <path d={`M${x + w - len},${y} L${x + w},${y} L${x + w},${y + len}`} />
      <path d={`M${x},${y + h - len} L${x},${y + h} L${x + len},${y + h}`} />
      <path d={`M${x + w - len},${y + h} L${x + w},${y + h} L${x + w},${y + h - len}`} />
    </g>
  )
}

function LabelBadge({
  x, y, text, sub, matched,
}: { x: number; y: number; text: string; sub: string; matched: boolean }) {
  // Approximate width from char count — SVG text width isn't measurable without
  // a render pass. Slight over-allocation looks fine in practice.
  const padX = 6
  const charW = 6.2
  const textW = Math.max(48, text.length * charW + (sub ? sub.length * charW + 8 : 0))
  const w = textW + padX * 2
  const h = 18
  const above = y >= h + 4
  const labelY = above ? y - h - 4 : y + 4
  const bg = matched ? '#38d977' : '#e83a29'
  const fg = '#0c0c0c'
  return (
    <g transform={`translate(${x}, ${labelY})`}>
      <rect width={w} height={h} rx={2} fill={bg} opacity={0.96} />
      <text
        x={padX}
        y={12}
        fontSize={10.5}
        fontFamily="Inter, system-ui, sans-serif"
        fontWeight={700}
        fill={fg}
        letterSpacing={0.2}
      >
        {text}
        {sub && (
          <tspan dx={6} fontWeight={500} opacity={0.7}>
            {sub}
          </tspan>
        )}
      </text>
    </g>
  )
}
