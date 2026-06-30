import { useEffect, useRef, useState } from 'react'

interface Props {
  /** HTTP(S) snapshot URL. Empty/invalid renders nothing (caller shows fallback). */
  url?: string
  /** Refresh interval in ms. */
  intervalMs?: number
  className?: string
  /** Called when the image fails to load (e.g. bad URL / auth). */
  onError?: () => void
  /** Called on the first successful load. */
  onLoad?: () => void
}

/**
 * Renders a periodically-refreshed still image from a camera snapshot endpoint.
 * The snapshot URL returns a single JPEG, so we cache-bust with `?t=<tick>` and
 * bump the tick on an interval. While an error is active nothing is rendered so
 * the caller can fall back to its own placeholder visuals.
 */
export function CameraSnapshot({ url, intervalMs = 5000, className, onError, onLoad }: Props) {
  const [tick, setTick] = useState(() => Date.now())
  const [errored, setErrored] = useState(false)

  // Reset error state whenever the URL changes so a corrected URL can recover.
  useEffect(() => {
    setErrored(false)
    setTick(Date.now())
  }, [url])

  useEffect(() => {
    if (!url) return
    const id = setInterval(() => setTick(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [url, intervalMs])

  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  if (!url || errored) return null

  const sep = url.includes('?') ? '&' : '?'
  return (
    <img
      src={`${url}${sep}t=${tick}`}
      alt=""
      className={className ?? 'absolute inset-0 w-full h-full object-cover'}
      onError={() => {
        setErrored(true)
        onErrorRef.current?.()
      }}
      onLoad={() => onLoad?.()}
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
