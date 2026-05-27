import { useQuery } from '@tanstack/react-query'
import { ScanFace } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api/client'
import { Button } from '../ui/Button'
import { AddPersonModal } from './AddPersonModal'
import { CameraToggleList } from './CameraToggleList'
import { PersonCard } from './PersonCard'

export function FaceRecognitionSection() {
  const [addOpen, setAddOpen] = useState(false)

  const personsQ = useQuery({
    queryKey: ['persons'],
    queryFn: () => api.persons.list(),
  })

  const camerasQ = useQuery({
    queryKey: ['cameras'],
    queryFn: () => api.cameras.list(),
    refetchInterval: 5000,
  })

  const persons = personsQ.data ?? []
  const cameras = camerasQ.data ?? []
  const activeCameraCount = cameras.filter(c => c.face_recognition_enabled).length

  return (
    <section className="flex flex-col gap-5">
      {/* Section header */}
      <div className="flex items-start justify-between">
        <div className="flex gap-3.5">
          <div className="w-10 h-10 rounded-r2 bg-ink-surface border border-ink-border flex items-center justify-center flex-shrink-0">
            <ScanFace size={18} strokeWidth={1.75} className="text-dim-red" />
          </div>
          <div>
            <h2 className="font-sans font-bold text-[18px] text-fg-1 leading-tight tracking-tight">
              Face recognition
            </h2>
            <p className="font-sans text-[12px] text-fg-3 mt-1 leading-relaxed max-w-[640px]">
              Enroll people and Sentry will identify them in real time on the cameras you enable.
              Detection runs continuously at low rate for alerts and bumps up automatically while
              you watch a live feed.
            </p>
          </div>
        </div>

        {/* KPIs */}
        <div className="flex items-stretch gap-2 flex-shrink-0">
          <Kpi label="People" value={persons.length} accent={persons.length > 0} />
          <Kpi label="Cameras" value={activeCameraCount} accent={activeCameraCount > 0} />
        </div>
      </div>

      {/* People panel */}
      <div className="bg-ink-dark border border-ink-border rounded-r3 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-ink-border">
          <div className="flex items-center gap-2">
            <span className="font-sans font-semibold text-[13px] text-fg-1">People</span>
            <span className="font-mono text-[10px] text-fg-3 tabular-nums uppercase tracking-[0.06em]">
              {persons.length} enrolled
            </span>
          </div>
          <Button variant="primary" size="sm" icon="plus" onClick={() => setAddOpen(true)}>
            Add person
          </Button>
        </div>

        <div className="p-5">
          {personsQ.isLoading ? (
            <PanelStatus message="Loading people…" />
          ) : personsQ.isError ? (
            <PanelStatus message="Could not reach the face service" error />
          ) : persons.length === 0 ? (
            <EmptyPeople onAdd={() => setAddOpen(true)} />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {persons.map(p => (
                <PersonCard key={p.id} person={p} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Cameras panel */}
      <div className="bg-ink-dark border border-ink-border rounded-r3 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-ink-border">
          <div className="flex items-center gap-2">
            <span className="font-sans font-semibold text-[13px] text-fg-1">Cameras</span>
            <span className="font-mono text-[10px] text-fg-3 tabular-nums uppercase tracking-[0.06em]">
              {activeCameraCount} of {cameras.length} active
            </span>
          </div>
          <span className="font-mono text-[10px] text-fg-4 uppercase tracking-[0.06em]">
            Toggle per camera
          </span>
        </div>

        <div className="p-5">
          {camerasQ.isLoading ? (
            <PanelStatus message="Loading cameras…" />
          ) : cameras.length === 0 ? (
            <PanelStatus message="No cameras yet. Add one from the Cameras page." />
          ) : (
            <CameraToggleList cameras={cameras} disabled={persons.length === 0} />
          )}
          {persons.length === 0 && cameras.length > 0 && (
            <p className="font-sans text-[11px] text-fg-3 mt-3 leading-relaxed">
              Enable face recognition after adding at least one person — otherwise detections will fire but never match.
            </p>
          )}
        </div>
      </div>

      <AddPersonModal open={addOpen} onClose={() => setAddOpen(false)} />
    </section>
  )
}

function Kpi({ label, value, accent }: { label: string; value: number; accent: boolean }) {
  return (
    <div className="bg-ink-dark border border-ink-border rounded-r2 px-4 py-2 flex flex-col items-end min-w-[88px]">
      <span
        className={`font-mono font-semibold text-[20px] leading-none tabular-nums ${
          accent ? 'text-fg-1' : 'text-fg-3'
        }`}
      >
        {value}
      </span>
      <span className="font-sans text-[9px] uppercase tracking-[0.10em] text-fg-3 mt-1">
        {label}
      </span>
    </div>
  )
}

function PanelStatus({ message, error }: { message: string; error?: boolean }) {
  return (
    <div className="py-10 flex items-center justify-center">
      <span
        className={`font-mono text-[11px] uppercase tracking-[0.06em] ${
          error ? 'text-dim-red' : 'text-fg-3'
        }`}
      >
        {message}
      </span>
    </div>
  )
}

function EmptyPeople({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="py-10 flex flex-col items-center text-center">
      <div className="w-14 h-14 rounded-full bg-ink-surface border border-ink-border flex items-center justify-center mb-4">
        <ScanFace size={22} strokeWidth={1.5} className="text-fg-3" />
      </div>
      <p className="font-sans font-semibold text-[14px] text-fg-1">No one enrolled yet</p>
      <p className="font-sans text-[12px] text-fg-3 mt-1 max-w-[360px] leading-relaxed">
        Add a person and upload a few clear photos of their face. Sentry uses them to match faces
        in the live feed.
      </p>
      <div className="mt-4">
        <Button variant="primary" size="sm" icon="plus" onClick={onAdd}>
          Add the first person
        </Button>
      </div>
    </div>
  )
}
