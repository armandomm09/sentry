import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function toWsUrl(httpUrl: string, path: string): string {
  return httpUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') + path
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useCameraStream(cameraId: string | null): {
  frameUri: string | null
  connected: boolean
  error: string | null
} {
  const { baseUrl, token } = useAuth()

  const [frameUri, setFrameUri] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Stable refs so callbacks don't capture stale values
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  // Track current cameraId in a ref so reconnect callbacks can verify it hasn't changed
  const currentCameraIdRef = useRef<string | null>(cameraId)

  const connect = useCallback(() => {
    if (!baseUrl || !token || !currentCameraIdRef.current) return

    const url = toWsUrl(baseUrl, `/api/cameras/${currentCameraIdRef.current}/ws`)

    // React Native WebSocket supports a 3rd options argument for custom headers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ws = new (WebSocket as any)(url, [], {
      headers: { Authorization: `Bearer ${token}` },
    }) as WebSocket

    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      if (!mountedRef.current) return
      setConnected(true)
      setError(null)
    }

    ws.onmessage = (event: MessageEvent) => {
      if (!mountedRef.current) return
      const bytes = new Uint8Array(event.data as ArrayBuffer)
      // Convert binary to base64 without spreading large arrays on the stack
      let binary = ''
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i])
      }
      const base64 = btoa(binary)
      setFrameUri(`data:image/jpeg;base64,${base64}`)
    }

    ws.onerror = () => {
      if (!mountedRef.current) return
      setError('WebSocket error')
      setConnected(false)
    }

    ws.onclose = () => {
      if (!mountedRef.current) return
      setConnected(false)
      // Reconnect only if still mounted and cameraId hasn't changed
      const snapshotCameraId = currentCameraIdRef.current
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current && currentCameraIdRef.current === snapshotCameraId) {
          connect()
        }
      }, 2000)
    }
  }, [baseUrl, token])

  useEffect(() => {
    mountedRef.current = true
    currentCameraIdRef.current = cameraId

    // Clear stale socket + timer from previous cameraId
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.onclose = null // prevent old onclose from triggering reconnect
      wsRef.current.onerror = null
      wsRef.current.close()
      wsRef.current = null
    }

    // Reset state when cameraId changes
    setFrameUri(null)
    setConnected(false)
    setError(null)

    if (cameraId) {
      connect()
    }

    return () => {
      mountedRef.current = false
      currentCameraIdRef.current = null
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.onerror = null
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [cameraId, connect])

  return { frameUri, connected, error }
}
