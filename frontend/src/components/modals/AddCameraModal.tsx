import { X } from 'lucide-react'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { Button } from '../ui/Button'
import { CameraSnapshot, deriveSnapshotUrl } from '../camera/CameraSnapshot'

interface Props {
  open: boolean
  onClose: () => void
}

interface FieldProps {
  label: string
  placeholder?: string
  value: string
  onChange: (v: string) => void
  hint?: string
  mono?: boolean
  error?: string
}

function Field({ label, placeholder, value, onChange, hint, mono, error }: FieldProps) {
  const [focused, setFocused] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <label className="font-sans text-[11px] font-medium text-fg-3 uppercase tracking-[0.04em]">
        {label}
      </label>
      <input
        className={`h-9 bg-ink-dark border rounded-r1 text-fg-1 px-3 outline-none transition-all duration-[200ms] placeholder:text-fg-4 ${
          mono ? 'font-mono text-[12px]' : 'font-sans text-[13px]'
        } ${
          error
            ? 'border-dim-red'
            : focused
            ? 'border-dim-red shadow-[0_0_0_3px_rgba(232,58,41,0.12)]'
            : 'border-ink-border'
        }`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {hint && !error && <p className="font-sans text-[11px] text-fg-3 leading-relaxed">{hint}</p>}
      {error && <p className="font-sans text-[11px] text-dim-red">{error}</p>}
    </div>
  )
}

export function AddCameraModal({ open, onClose }: Props) {
  const qc = useQueryClient()
  const [rtspUrl, setRtspUrl]       = useState('')
  const [snapshotUrl, setSnapshot]  = useState('')
  const [snapshotTouched, setTouched] = useState(false)
  const [name, setName]             = useState('')
  const [location, setLocation]     = useState('')
  const [autoReconnect, setAR]      = useState(true)
  const [errors, setErrors]         = useState<Record<string, string>>({})

  // Update RTSP and, unless the user has edited the preview field, re-derive the
  // snapshot URL from it (Hikvision/ISAPI best guess).
  const handleRtspChange = (v: string) => {
    setRtspUrl(v)
    if (!snapshotTouched) setSnapshot(deriveSnapshotUrl(v))
  }

  const handleSnapshotChange = (v: string) => {
    setTouched(true)
    setSnapshot(v)
  }

  const previewable = /^https?:\/\//i.test(snapshotUrl.trim())

  const mutation = useMutation({
    mutationFn: () =>
      api.cameras.create({
        name,
        location,
        rtsp_url: rtspUrl,
        snapshot_url: snapshotUrl.trim() || undefined,
        auto_reconnect: autoReconnect,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cameras'] })
      handleClose()
    },
  })

  const validate = () => {
    const e: Record<string, string> = {}
    if (!rtspUrl.trim()) e.rtspUrl = 'Stream URL is required'
    else if (!rtspUrl.startsWith('rtsp://') && !rtspUrl.startsWith('ws://') && !rtspUrl.startsWith('wss://'))
      e.rtspUrl = 'Must start with rtsp://, ws://, or wss://'
    if (!name.trim()) e.name = 'Name is required'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return
    mutation.mutate()
  }

  const handleClose = () => {
    setRtspUrl(''); setSnapshot(''); setTouched(false)
    setName(''); setLocation(''); setAR(true); setErrors({})
    onClose()
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={handleClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-[460px] bg-ink-surface border border-ink-border rounded-r3 shadow-elev-3 flex flex-col"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-ink-border">
          <div>
            <h2 className="font-sans font-bold text-[18px] text-fg-1 leading-tight tracking-tight">
              Add camera
            </h2>
            <p className="font-sans text-[12px] text-fg-3 mt-1 leading-relaxed">
              Connect a camera via RTSP or a WebSocket source. Sentry begins monitoring once the stream is active.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="w-7 h-7 flex items-center justify-center rounded-r1 text-fg-3 hover:text-fg-1 hover:bg-ink-raised transition-colors flex-shrink-0 ml-3 mt-0.5"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 flex flex-col gap-3.5">
          <Field
            label="Stream URL"
            placeholder="rtsp://admin@192.168.1.42/live"
            value={rtspUrl}
            onChange={handleRtspChange}
            mono
            hint="Accepts rtsp:// for IP cameras or ws:// for WebSocket sources (e.g. webcam test server)."
            error={errors.rtspUrl}
          />

          <Field
            label="Preview URL"
            placeholder="http://admin:pass@192.168.1.42/ISAPI/Streaming/channels/101/picture"
            value={snapshotUrl}
            onChange={handleSnapshotChange}
            mono
            hint="HTTP snapshot endpoint, auto-filled from the stream URL. Used for the still preview; edit if your camera differs."
          />

          {previewable && (
            <div
              className="relative w-full overflow-hidden rounded-r1 border border-ink-border bg-ink-dark"
              style={{ aspectRatio: '16/9' }}
            >
              <CameraSnapshot url={snapshotUrl.trim()} />
              <div className="absolute bottom-1.5 left-1.5 font-mono text-[10px] text-white/75 bg-black/55 backdrop-blur-sm px-1.5 py-0.5 rounded-r1">
                live preview
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Name"
              placeholder="Front door"
              value={name}
              onChange={setName}
              error={errors.name}
            />
            <Field
              label="Location"
              placeholder="Entrance"
              value={location}
              onChange={setLocation}
            />
          </div>

          {/* Auto-reconnect toggle */}
          <div className="flex items-center justify-between px-3.5 py-3 bg-ink-dark border border-ink-border rounded-r1">
            <div>
              <div className="font-sans font-semibold text-[13px] text-fg-1">Auto-reconnect</div>
              <div className="font-sans text-[11px] text-fg-3 mt-0.5">Reconnect automatically when the stream is lost.</div>
            </div>
            <button
              type="button"
              onClick={() => setAR(!autoReconnect)}
              className="relative flex-shrink-0 ml-4 transition-all duration-[200ms]"
              style={{
                width: 36, height: 20, borderRadius: 999,
                background: autoReconnect ? '#e83a29' : '#332e2f',
                border: autoReconnect ? '1px solid transparent' : '1px solid #3a3536',
              }}
            >
              <span
                className="absolute top-0.5 transition-all duration-[200ms] rounded-full"
                style={{
                  width: 14, height: 14,
                  left: autoReconnect ? 18 : 2,
                  background: autoReconnect ? '#fff' : '#c4bdbb',
                }}
              />
            </button>
          </div>

          {mutation.isError && (
            <div className="px-3.5 py-2.5 rounded-r1 bg-[rgba(232,58,41,0.12)] border border-[rgba(232,58,41,0.45)]">
              <p className="font-sans text-[12px] text-[#ff7c6f]">{mutation.error.message}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-ink-border">
          <Button variant="ghost" type="button" onClick={handleClose}>Cancel</Button>
          <Button variant="primary" type="submit" icon="plus" disabled={mutation.isPending}>
            {mutation.isPending ? 'Adding…' : 'Add camera'}
          </Button>
        </div>
      </form>
    </div>
  )
}
