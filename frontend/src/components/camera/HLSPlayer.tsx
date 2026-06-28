import Hls from 'hls.js'
import { Maximize2, Minimize2, Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  src: string
  className?: string
  /** Populated with a getter for the HLS wall-clock time (Unix seconds) of the
   *  frame currently on screen. Requires EXT-X-PROGRAM-DATE-TIME in the manifest
   *  (added by the `program_date_time` HLS flag in the Go backend). Returns null
   *  until the first segment with PDT is loaded. */
  playbackTimeRef?: React.MutableRefObject<(() => number | null) | null>
}

export function HLSPlayer({ src, className = '', playbackTimeRef }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const hideTimer = useRef<number | null>(null)

  const [state, setState] = useState<'loading' | 'playing' | 'paused' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [muted, setMuted] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [showChrome, setShowChrome] = useState(true)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)

  // --- HLS lifecycle ---
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    setState('loading')
    setErrorMsg(null)

    if (Hls.isSupported()) {
      const hls = new Hls({
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 6,
        lowLatencyMode: true,
        backBufferLength: 10,
      })
      hlsRef.current = hls
      hls.loadSource(src)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => setState('paused'))
      })
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad()
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError()
        } else {
          setState('error')
          setErrorMsg(data.details || 'fatal stream error')
        }
      })
      // Track the live edge so we can estimate the video's wall-clock time.
      // Updated every time hls.js re-fetches the manifest (~every 2s for live).
      // Formula: content at stream-pos V was live at wallTime + (V - streamPos).
      // This works without EXT-X-PROGRAM-DATE-TIME as a reliable fallback.
      let liveEdge = { streamPos: 0, wallTime: 0 }
      hls.on(Hls.Events.LEVEL_DETAILS_LOADED, (_e, data) => {
        if (data.details.live) {
          liveEdge = { streamPos: data.details.edge, wallTime: Date.now() / 1000 }
        }
      })

      if (playbackTimeRef) {
        playbackTimeRef.current = () => {
          const v = videoRef.current
          if (!v) return null
          // Primary: PDT from the manifest (EXT-X-PROGRAM-DATE-TIME), most accurate.
          const d = hls.playingDate
          if (d) return d.getTime() / 1000
          // Fallback: derive from the live-edge position we recorded above.
          if (liveEdge.wallTime > 0) {
            return liveEdge.wallTime + (v.currentTime - liveEdge.streamPos)
          }
          return null
        }
      }
      return () => {
        hls.destroy()
        hlsRef.current = null
        if (playbackTimeRef) playbackTimeRef.current = null
      }
    }
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src
      video.play().catch(() => setState('paused'))
      return
    }
    setState('error')
    setErrorMsg('HLS not supported in this browser')
  }, [src])

  // --- Latency polling (distance from live edge) ---
  useEffect(() => {
    const id = window.setInterval(() => {
      const v = videoRef.current
      if (!v || v.readyState < 2) return
      const buffered = v.buffered
      if (!buffered.length) return
      const liveEdge = buffered.end(buffered.length - 1)
      setLatencyMs(Math.max(0, Math.round((liveEdge - v.currentTime) * 1000)))
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  // --- Fullscreen tracking ---
  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === wrapRef.current)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // --- Auto-hide chrome ---
  const bumpChrome = useCallback(() => {
    setShowChrome(true)
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setShowChrome(false)
    }, 2500)
  }, [])

  useEffect(() => {
    bumpChrome()
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current)
    }
  }, [bumpChrome])

  // --- Controls ---
  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      // Snap to live edge when resuming so we don't drift behind.
      const hls = hlsRef.current
      if (hls && hls.liveSyncPosition != null) v.currentTime = hls.liveSyncPosition
      v.play().catch(() => {})
    } else {
      v.pause()
    }
  }, [])

  const toggleMute = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.muted = !v.muted
    setMuted(v.muted)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (!wrapRef.current) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      wrapRef.current.requestFullscreen().catch(() => {})
    }
  }, [])

  const snapToLive = useCallback(() => {
    const v = videoRef.current
    const hls = hlsRef.current
    if (!v) return
    if (hls && hls.liveSyncPosition != null) v.currentTime = hls.liveSyncPosition
    if (v.paused) v.play().catch(() => {})
  }, [])

  // --- Video event wiring ---
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onPlay = () => { setState('playing'); bumpChrome() }
    const onPause = () => { setState('paused'); setShowChrome(true) }
    const onWaiting = () => setState('loading')
    const onPlaying = () => setState('playing')
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('waiting', onWaiting)
    v.addEventListener('playing', onPlaying)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('waiting', onWaiting)
      v.removeEventListener('playing', onPlaying)
    }
  }, [bumpChrome])

  const isPlaying = state === 'playing'
  const isLoading = state === 'loading'
  const isError = state === 'error'
  // "live" if within 4s of live edge
  const isLive = latencyMs != null && latencyMs < 4000

  return (
    <div
      ref={wrapRef}
      className={`relative w-full h-full bg-black select-none group ${className}`}
      onMouseMove={bumpChrome}
      onMouseLeave={() => isPlaying && setShowChrome(false)}
    >
      <video
        ref={videoRef}
        className="w-full h-full object-contain bg-black cursor-pointer"
        playsInline
        muted={muted}
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
      />

      {/* Top-left: LIVE / latency badge */}
      <div
        className={`absolute top-3 left-3 flex items-center gap-2 transition-opacity duration-200 ${
          showChrome || !isPlaying ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <button
          onClick={snapToLive}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/55 backdrop-blur-sm border border-white/10 hover:border-white/20 transition"
          title={isLive ? 'On live edge' : 'Jump to live'}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isLive ? 'bg-status-online animate-pulse' : 'bg-status-warn'
            }`}
          />
          <span className="font-sans text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-1">
            {isLive ? 'Live' : 'Behind'}
          </span>
        </button>
        {latencyMs != null && (
          <span className="font-mono tabular-nums text-[10px] text-fg-2 px-1.5 py-1 rounded-md bg-black/55 backdrop-blur-sm border border-white/10">
            {(latencyMs / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      {/* Center spinner */}
      {isLoading && !isError && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-10 h-10 rounded-full border-2 border-white/15 border-t-dim-red animate-spin" />
        </div>
      )}

      {/* Center play overlay (when paused) */}
      {!isPlaying && !isLoading && !isError && (
        <button
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center bg-black/40 transition"
        >
          <span className="w-16 h-16 rounded-full bg-dim-red/90 flex items-center justify-center shadow-lg">
            <Play className="w-7 h-7 text-white translate-x-0.5" strokeWidth={2.25} />
          </span>
        </button>
      )}

      {/* Error overlay */}
      {isError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70">
          <span className="font-sans text-[11px] uppercase tracking-[0.12em] text-status-error font-semibold">
            Stream error
          </span>
          {errorMsg && (
            <span className="font-mono text-[11px] text-fg-3 max-w-[80%] text-center truncate">
              {errorMsg}
            </span>
          )}
        </div>
      )}

      {/* Bottom control bar */}
      <div
        className={`absolute inset-x-0 bottom-0 flex items-center gap-2 px-3 py-2.5 transition-opacity duration-200 ${
          showChrome || !isPlaying ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          background: 'linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0) 100%)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <IconBtn onClick={togglePlay} title={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 translate-x-px" />}
        </IconBtn>
        <IconBtn onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
          {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </IconBtn>
        <div className="flex-1" />
        <IconBtn onClick={toggleFullscreen} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
          {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </IconBtn>
      </div>
    </div>
  )
}

function IconBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-8 h-8 flex items-center justify-center rounded-md text-fg-1 hover:bg-white/10 active:bg-white/15 transition"
    >
      {children}
    </button>
  )
}
