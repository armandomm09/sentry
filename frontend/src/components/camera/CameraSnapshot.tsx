import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'

interface Props {
  /** Camera whose still image to show. */
  cameraId?: string
  /** Refresh interval in ms. */
  intervalMs?: number
  className?: string
  /** Called when the image fails to load (e.g. camera unreachable / auth). */
  onError?: () => void
  /** Called on the first successful load. */
  onLoad?: () => void
}

/**
 * Renders a periodically-refreshed still image from a camera, fetched
 * through the backend's authenticated proxy (`GET /api/cameras/:id/snapshot`).
 * Cameras sit on a private network the browser can't route to directly, and
 * snapshot_url often embeds credentials, which browsers refuse to load as an
 * <img> resource — so we always fetch via the API and render a blob URL.
 */
export function CameraSnapshot({ cameraId, intervalMs = 5000, className, onError, onLoad }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [errored, setErrored] = useState(false)
  const onErrorRef = useRef(onError)
  const onLoadRef = useRef(onLoad)
  onErrorRef.current = onError
  onLoadRef.current = onLoad

  useEffect(() => {
    if (!cameraId) return
    setErrored(false)

    let cancelled = false
    let currentUrl: string | null = null

    const fetchOnce = async () => {
      try {
        const url = await api.cameras.fetchSnapshot(cameraId)
        if (cancelled) {
          URL.revokeObjectURL(url)
          return
        }
        const previous = currentUrl
        currentUrl = url
        setBlobUrl(url)
        if (previous) URL.revokeObjectURL(previous)
        onLoadRef.current?.()
      } catch {
        if (!cancelled) {
          setErrored(true)
          onErrorRef.current?.()
        }
      }
    }

    fetchOnce()
    const id = setInterval(fetchOnce, intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
      if (currentUrl) URL.revokeObjectURL(currentUrl)
    }
  }, [cameraId, intervalMs])

  if (!cameraId || errored || !blobUrl) return null

  return (
    <img
      src={blobUrl}
      alt=""
      className={className ?? 'absolute inset-0 w-full h-full object-cover'}
      onError={() => {
        setErrored(true)
        onErrorRef.current?.()
      }}
    />
  )
}

/**
 * Best-effort guess of a Hikvision/ISAPI snapshot URL from an RTSP URL.
 * `rtsp://user:pass@host:554/Streaming/Channels/102` →
 * `http://user:pass@host/ISAPI/Streaming/channels/102/picture`.
 * Returns '' when the input isn't a parseable rtsp:// URL.
 */
export function deriveSnapshotUrl(rtsp: string): string {
  const m = rtsp.trim().match(/^rtsps?:\/\/([^/]+@)?([^/:]+)(?::\d+)?(\/.*)?$/i)
  if (!m) return ''
  const creds = m[1] ?? ''
  const host = m[2]
  const path = m[3] ?? ''
  // Channel digits appear after .../Channels/<n> in most Hikvision RTSP paths.
  const ch = path.match(/channels?\/(\d+)/i)?.[1] ?? '101'
  return `http://${creds}${host}/ISAPI/Streaming/channels/${ch}/picture`
}
