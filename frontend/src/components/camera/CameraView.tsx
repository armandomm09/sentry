import { ArrowLeft, Download, Pause, Play, Settings2, Trash2 } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { CameraWithStream } from '../../types/camera'
import { api } from '../../api/client'
import { Button } from '../ui/Button'
import { StatusPill } from '../ui/StatusPill'
import { HLSPlayer } from './HLSPlayer'

interface Props {
  camera: CameraWithStream
  onBack: () => void
}

interface KVRowProps {
  label: string
  value: string
  mono?: boolean
}

function KVRow({ label, value, mono }: KVRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-ink-border last:border-0">
      <span className="font-sans text-[11px] text-fg-3 uppercase tracking-[0.04em] flex-shrink-0">{label}</span>
      <span className={`text-[12px] text-fg-1 font-medium truncate min-w-0 text-right ${mono ? 'font-mono tabular-nums' : 'font-sans'}`}>
        {value}
      </span>
    </div>
  )
}

export function CameraView({ camera, onBack }: Props) {
  const qc = useQueryClient()
  const status = camera.stream.status
  const isLive = status === 'live' || status === 'recording'

  const startStream = useMutation({
    mutationFn: () => api.streams.start(camera.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cameras'] }),
  })

  const stopStream = useMutation({
    mutationFn: () => api.streams.stop(camera.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cameras'] }),
  })

  const deleteCamera = useMutation({
    mutationFn: () => api.cameras.delete(camera.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cameras'] })
      onBack()
    },
  })

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-ink-border">
        <Button variant="ghost" size="sm" icon="arrow-left" onClick={onBack}>
          Back
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="font-sans font-bold text-[22px] text-fg-1 leading-tight tracking-tight truncate">
            {camera.name}
          </h1>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="font-sans text-[12px] text-fg-3">{camera.location}</span>
            <span className="text-fg-4">·</span>
            <span className="font-mono text-[11px] text-fg-3">{camera.id.slice(0, 8)}</span>
            <StatusPill status={status} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isLive ? (
            <Button
              variant="secondary"
              size="sm"
              icon="pause"
              onClick={() => stopStream.mutate()}
              disabled={stopStream.isPending}
            >
              Pause
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon="play"
              onClick={() => startStream.mutate()}
              disabled={startStream.isPending}
            >
              Start stream
            </Button>
          )}
          <Button variant="secondary" size="sm" icon="download">Snapshot</Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 grid grid-cols-[1fr_300px] gap-0 overflow-hidden">
        {/* Feed */}
        <div className="flex flex-col p-6 gap-4 overflow-auto">
          <div
            className="rounded-r3 overflow-hidden bg-black border border-ink-border shadow-elev-2 relative"
            style={{ aspectRatio: '16/9' }}
          >
            {isLive && camera.stream.hls_url ? (
              <HLSPlayer src={camera.stream.hls_url} />
            ) : (
              <div
                className="w-full h-full flex flex-col items-center justify-center gap-3"
                style={{
                  background:
                    status === 'reconnecting'
                      ? 'repeating-linear-gradient(45deg, #1a1718 0 6px, #231f20 6px 12px)'
                      : 'radial-gradient(ellipse at 30% 40%, rgba(80,90,70,0.55), transparent 60%), linear-gradient(135deg,#1c1f1a 0%,#0e0c0c 70%)',
                }}
              >
                {status === 'reconnecting' ? (
                  <>
                    <div className="relative overflow-hidden h-1 w-1/2">
                      <div className="absolute h-full w-2/5 animate-[sweep_1.8s_linear_infinite]">
                        <svg viewBox="0 0 800 60" preserveAspectRatio="none" className="w-full h-full" style={{ color: '#e83a29' }}>
                          <path d="M 12 38 C 90 16, 220 8, 360 6 C 500 4, 640 12, 770 24 C 720 31, 600 33, 460 32 C 320 31, 180 33, 30 44 Z" fill="currentColor" />
                        </svg>
                      </div>
                    </div>
                    <span className="font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-status-warn">
                      Reconnecting…
                    </span>
                  </>
                ) : (
                  <span className="font-sans text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3">
                    Stream offline
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Side panel */}
        <div className="border-l border-ink-border flex flex-col overflow-auto">
          <div className="px-5 py-4 border-b border-ink-border">
            <h3 className="font-sans font-semibold text-[13px] text-fg-1 uppercase tracking-[0.04em]">
              Camera details
            </h3>
          </div>
          <div className="px-5 py-2 flex-1">
            <KVRow label="Name"     value={camera.name} />
            <KVRow label="Location" value={camera.location || '—'} />
            <KVRow label="RTSP URL" value={camera.rtsp_url} mono />
            <KVRow label="Status"   value={status} />
            <KVRow label="Auto-reconnect" value={camera.auto_reconnect ? 'enabled' : 'disabled'} />
            <KVRow label="Added"    value={new Date(camera.created_at).toLocaleDateString()} />
          </div>

          {/* Actions */}
          <div className="px-5 py-4 border-t border-ink-border flex flex-col gap-2">
            <Button variant="ghost" size="sm" icon="settings-2" className="justify-start w-full">
              Stream settings
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon="trash-2"
              className="justify-start w-full"
              onClick={() => {
                if (confirm(`Remove "${camera.name}"?`)) deleteCamera.mutate()
              }}
              disabled={deleteCamera.isPending}
            >
              Remove camera
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
