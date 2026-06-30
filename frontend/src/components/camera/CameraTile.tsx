import { Maximize2, MoreHorizontal, VideoOff } from 'lucide-react'
import { useState } from 'react'
import type { CameraWithStream } from '../../types/camera'
import { StatusPill } from '../ui/StatusPill'
import { CameraSnapshot } from './CameraSnapshot'

interface Props {
  camera: CameraWithStream
  onOpen: (camera: CameraWithStream) => void
}

export function CameraTile({ camera, onOpen }: Props) {
  const [hover, setHover] = useState(false)
  const status = camera.stream.status
  const isOffline = status === 'offline'
  const isReconnecting = status === 'reconnecting'
  const isLive = status === 'live' || status === 'recording'

  const feedBg = isOffline || isReconnecting
    ? 'repeating-linear-gradient(45deg, #1a1718 0 6px, #231f20 6px 12px)'
    : `radial-gradient(ellipse at 30% 40%, rgba(80,90,70,0.55), transparent 60%),
       radial-gradient(ellipse at 70% 70%, rgba(120,110,90,0.35), transparent 55%),
       linear-gradient(135deg, #1c1f1a 0%, #0e0c0c 70%)`

  const borderColor = hover
    ? 'border-ink-border-strong shadow-elev-2'
    : status === 'recording'
    ? 'border-ink-border shadow-elev-rec'
    : 'border-ink-border shadow-elev-1'

  const topInset = hover || status === 'recording'
    ? 'shadow-[inset_0_1px_0_#e83a29]'
    : ''

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onOpen(camera)}
      className={`group bg-ink-surface border rounded-r2 overflow-hidden cursor-pointer transition-all duration-[200ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] ${borderColor} ${topInset} ${isOffline ? 'opacity-85' : ''}`}
    >
      {/* Feed */}
      <div
        className="relative overflow-hidden"
        style={{ aspectRatio: '16/9', background: feedBg }}
      >
        {/* Snapshot preview (refreshes every 5s); falls back to gradient on error/empty */}
        {!isOffline && camera.snapshot_url && (
          <CameraSnapshot url={camera.snapshot_url} />
        )}

        {/* Scan line */}
        {isLive && (
          <div className="absolute left-0 right-0 top-[32%] h-px bg-white/[0.06]" />
        )}

        {/* Offline overlay */}
        {isOffline && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-fg-3">
            <VideoOff size={22} strokeWidth={1.5} />
            <span className="font-sans text-[10px] font-medium uppercase tracking-[0.08em]">Offline</span>
          </div>
        )}

        {/* Reconnecting sweep */}
        {isReconnecting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <div className="relative overflow-hidden h-1" style={{ width: '60%' }}>
              <div className="absolute h-full w-2/5 animate-[sweep_1.8s_linear_infinite]">
                <svg viewBox="0 0 800 60" preserveAspectRatio="none" className="w-full h-full" style={{ color: '#e83a29' }}>
                  <path d="M 12 38 C 90 16, 220 8, 360 6 C 500 4, 640 12, 770 24 C 720 31, 600 33, 460 32 C 320 31, 180 33, 30 44 Z" fill="currentColor" />
                </svg>
              </div>
            </div>
            <span className="font-sans text-[10px] font-medium uppercase tracking-[0.08em] text-status-warn">Reconnecting</span>
          </div>
        )}

        {/* Top HUD */}
        <div className="absolute top-2 left-2 right-2 flex justify-between items-center">
          <StatusPill status={status} />
          {isLive && (
            <span className="font-mono text-[10px] font-medium text-white/85 bg-black/55 backdrop-blur-sm px-1.5 py-1 rounded-r1 tabular-nums">
              {new Date().toLocaleTimeString('en-US', { hour12: false })}
            </span>
          )}
        </div>

        {/* Quick actions on hover */}
        {hover && isLive && (
          <div className="absolute bottom-2 right-2 flex gap-1.5">
            {[Maximize2, MoreHorizontal].map((Icon, i) => (
              <button
                key={i}
                onClick={(e) => { e.stopPropagation(); if (i === 0) onOpen(camera) }}
                className="w-[26px] h-[26px] rounded-r1 bg-black/55 backdrop-blur-sm border border-white/10 text-white flex items-center justify-center hover:bg-black/75 transition-colors"
              >
                <Icon size={13} strokeWidth={1.75} />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Meta strip */}
      <div className="px-3 py-2.5 flex items-center justify-between gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="font-sans font-semibold text-[13px] text-fg-1 leading-tight truncate">
            {camera.name}
          </div>
          <div className="font-sans text-[11px] text-fg-3 mt-0.5 truncate">
            {camera.location} · <span className="font-mono">{camera.id.slice(0, 8)}</span>
          </div>
        </div>
        <div className={`font-mono text-[10px] tabular-nums flex-shrink-0 ${isOffline ? 'text-dim-red' : 'text-fg-3'}`}>
          {isOffline || isReconnecting ? 'offline' : '24fps'}
        </div>
      </div>
    </div>
  )
}
