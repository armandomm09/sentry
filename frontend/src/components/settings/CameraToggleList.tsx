import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Video } from 'lucide-react'
import { api } from '../../api/client'
import type { CameraWithStream } from '../../types/camera'
import { StatusPill } from '../ui/StatusPill'

interface Props {
  cameras: CameraWithStream[]
  /** If true, render the toggles but in a slightly muted state — there are no
   *  people enrolled, so face-rec will produce only unmatched detections. */
  disabled?: boolean
}

export function CameraToggleList({ cameras, disabled }: Props) {
  return (
    <ul className="flex flex-col divide-y divide-ink-border -my-2">
      {cameras.map(cam => (
        <CameraRow key={cam.id} camera={cam} muted={disabled} />
      ))}
    </ul>
  )
}

function CameraRow({ camera, muted }: { camera: CameraWithStream; muted?: boolean }) {
  const qc = useQueryClient()
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.cameras.setFaceRecognition(camera.id, enabled),
    onMutate: async (enabled) => {
      await qc.cancelQueries({ queryKey: ['cameras'] })
      const prev = qc.getQueryData<CameraWithStream[]>(['cameras'])
      if (prev) {
        qc.setQueryData<CameraWithStream[]>(['cameras'],
          prev.map(c => c.id === camera.id ? { ...c, face_recognition_enabled: enabled } : c)
        )
      }
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['cameras'], ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['cameras'] }),
  })

  const enabled = camera.face_recognition_enabled
  const stream = camera.stream

  return (
    <li className="flex items-center gap-3 py-3">
      <div className="w-9 h-9 rounded-r2 bg-ink-surface border border-ink-border flex items-center justify-center flex-shrink-0">
        <Video size={15} strokeWidth={1.75} className="text-fg-3" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-sans font-semibold text-[13px] text-fg-1 truncate">
            {camera.name}
          </span>
          <StatusPill status={stream.status} />
        </div>
        <div className="font-mono text-[10px] text-fg-3 mt-0.5 truncate uppercase tracking-[0.04em]">
          {camera.location || '—'}
        </div>
      </div>

      <Toggle
        on={enabled}
        muted={muted}
        pending={toggle.isPending}
        onChange={(v) => toggle.mutate(v)}
        label={enabled ? 'Face recognition enabled' : 'Face recognition disabled'}
      />
    </li>
  )
}

function Toggle({
  on, onChange, label, muted, pending,
}: { on: boolean; onChange: (v: boolean) => void; label: string; muted?: boolean; pending?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      disabled={pending}
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      className={`relative flex-shrink-0 cursor-pointer transition-all duration-[200ms] ${
        muted && !on ? 'opacity-60' : ''
      } ${pending ? 'opacity-70' : ''}`}
      style={{
        width: 36, height: 20, borderRadius: 999,
        background: on ? '#e83a29' : '#332e2f',
        border: on ? '1px solid transparent' : '1px solid #3a3536',
      }}
    >
      <span
        className="absolute top-0.5 transition-all duration-[200ms] rounded-full"
        style={{
          width: 14, height: 14,
          left: on ? 18 : 2,
          background: on ? '#fff' : '#c4bdbb',
        }}
      />
    </button>
  )
}
