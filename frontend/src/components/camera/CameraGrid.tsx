import { Layers, Plus, Settings } from 'lucide-react'
import { useState } from 'react'
import type { CameraWithStream } from '../../types/camera'
import { Button } from '../ui/Button'
import { CameraTile } from './CameraTile'

interface Props {
  cameras: CameraWithStream[]
  onOpen: (camera: CameraWithStream) => void
  onAddCamera: () => void
}

type Filter = 'all' | 'live' | 'recording' | 'issues'

export function CameraGrid({ cameras, onOpen, onAddCamera }: Props) {
  const [filter, setFilter] = useState<Filter>('all')

  const filters: { id: Filter; label: string; count: number }[] = [
    { id: 'all',       label: 'All cameras', count: cameras.length },
    { id: 'live',      label: 'Live',        count: cameras.filter(c => c.stream.status === 'live' || c.stream.status === 'recording').length },
    { id: 'recording', label: 'Recording',   count: cameras.filter(c => c.stream.status === 'recording').length },
    { id: 'issues',    label: 'Issues',      count: cameras.filter(c => c.stream.status === 'offline' || c.stream.status === 'reconnecting').length },
  ]

  const visible = cameras.filter((c) => {
    switch (filter) {
      case 'live':      return c.stream.status === 'live' || c.stream.status === 'recording'
      case 'recording': return c.stream.status === 'recording'
      case 'issues':    return c.stream.status === 'offline' || c.stream.status === 'reconnecting'
      default:          return true
    }
  })

  return (
    <div className="flex flex-col gap-5 p-6">
      {/* Filter bar + controls */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1 bg-ink-dark border border-ink-border rounded-r1 p-0.5">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`inline-flex items-center gap-2 h-[30px] px-3 rounded font-sans text-xs font-medium transition-all duration-[120ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] ${
                filter === f.id
                  ? 'bg-ink-raised text-fg-1'
                  : 'text-fg-3 hover:text-fg-2'
              }`}
            >
              {f.label}
              <span className={`font-mono text-[10px] tabular-nums ${filter === f.id ? 'text-fg-2' : 'text-fg-4'}`}>
                {f.count}
              </span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" icon="layers">
            Layout
          </Button>
          <Button variant="primary" size="sm" icon="plus" onClick={onAddCamera}>
            Add camera
          </Button>
        </div>
      </div>

      {/* Grid */}
      {visible.length > 0 ? (
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
          {visible.map((c) => (
            <CameraTile key={c.id} camera={c} onOpen={onOpen} />
          ))}
        </div>
      ) : cameras.length === 0 ? (
        /* Empty state */
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <div className="w-16 h-16 rounded-r3 bg-ink-surface border border-ink-border flex items-center justify-center">
            <Layers size={28} strokeWidth={1.25} className="text-fg-4" />
          </div>
          <div>
            <p className="font-sans text-fg-2 text-sm">No cameras yet.</p>
            <button
              onClick={onAddCamera}
              className="font-sans text-sm text-dim-red hover:text-dim-red-hover transition-colors mt-1 font-semibold"
            >
              Add your first camera
            </button>
            <span className="font-sans text-sm text-fg-3"> to start monitoring.</span>
          </div>
        </div>
      ) : (
        <div className="py-16 text-center">
          <p className="font-sans text-fg-3 text-sm">No cameras match this filter.</p>
        </div>
      )}
    </div>
  )
}
