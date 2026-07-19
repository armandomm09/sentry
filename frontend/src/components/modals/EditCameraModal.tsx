import { X } from 'lucide-react'
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { Button } from '../ui/Button'
import type { CameraWithStream } from '../../types/camera'

interface Props {
  camera: CameraWithStream
  open: boolean
  onClose: () => void
}

function Field({
  label, value, onChange, mono, placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  mono?: boolean
  placeholder?: string
}) {
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
          focused
            ? 'border-dim-red shadow-[0_0_0_3px_rgba(232,58,41,0.12)]'
            : 'border-ink-border'
        }`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
    </div>
  )
}

export function EditCameraModal({ camera, open, onClose }: Props) {
  const qc = useQueryClient()
  const [name, setName] = useState(camera.name)
  const [location, setLocation] = useState(camera.location)
  const [rtspUrl, setRtspUrl] = useState(camera.rtsp_url)
  const [snapshotUrl, setSnapshotUrl] = useState(camera.snapshot_url ?? '')

  const mutation = useMutation({
    mutationFn: () =>
      api.cameras.update(camera.id, {
        name,
        location,
        rtsp_url: rtspUrl,
        snapshot_url: snapshotUrl.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cameras'] })
      onClose()
    },
  })

  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); mutation.mutate() }}
        onClick={(e) => e.stopPropagation()}
        className="w-[460px] bg-ink-surface border border-ink-border rounded-r3 shadow-elev-3 flex flex-col"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-ink-border">
          <div>
            <h2 className="font-sans font-bold text-[18px] text-fg-1 leading-tight tracking-tight">
              Edit camera
            </h2>
            <p className="font-sans text-[12px] text-fg-3 mt-1">
              Update stream and preview URLs or rename this camera.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-r1 text-fg-3 hover:text-fg-1 hover:bg-ink-raised transition-colors flex-shrink-0 ml-3 mt-0.5"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 flex flex-col gap-3.5">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" value={name} onChange={setName} placeholder="Front door" />
            <Field label="Location" value={location} onChange={setLocation} placeholder="Entrance" />
          </div>
          <Field
            label="Stream URL"
            value={rtspUrl}
            onChange={setRtspUrl}
            mono
            placeholder="rtsp://admin@192.168.1.42/live"
          />
          <Field
            label="Preview URL"
            value={snapshotUrl}
            onChange={setSnapshotUrl}
            mono
            placeholder="http://admin:pass@192.168.1.42/ISAPI/Streaming/channels/101/picture"
          />

          {mutation.isError && (
            <div className="px-3.5 py-2.5 rounded-r1 bg-[rgba(232,58,41,0.12)] border border-[rgba(232,58,41,0.45)]">
              <p className="font-sans text-[12px] text-[#ff7c6f]">{mutation.error.message}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-ink-border">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" icon="check" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>
    </div>
  )
}
