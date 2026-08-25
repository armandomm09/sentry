import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, UserRound, X } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api/client'
import type { LabelEventResult, SentryEvent } from '../../types/event'
import { Button } from '../ui/Button'
import { EventThumb } from './EventThumb'

interface Props {
  event: SentryEvent
  onClose: () => void
  onLabeled: (result: LabelEventResult, personName: string) => void
}

/**
 * Assigns an unrecognized sighting to a person, enrolling its face crop.
 *
 * The crop leads the dialog because enrolling a bad frame quietly degrades
 * future recognition — the operator should see the exact photo before
 * committing. That preview is the event thumbnail, which is the same file the
 * backend uploads to the face-service, so it cannot drift from what is added.
 */
export function LabelPersonModal({ event, onClose, onLabeled }: Props) {
  const qc = useQueryClient()
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const personsQ = useQuery({
    queryKey: ['persons'],
    queryFn: () => api.persons.list(),
  })

  const label = useMutation({
    mutationFn: ({ target }: { target: { person_id: string } | { new_person_name: string }; name: string }) =>
      api.events.label(event.id, target),
    onSuccess: (result, vars) => {
      // The crop became a new enrollment photo, and past unknowns may have been
      // relabeled — both the roster and the sighting log are now stale.
      qc.invalidateQueries({ queryKey: ['persons'] })
      qc.invalidateQueries({ queryKey: ['events'] })
      onLabeled(result, vars.name)
    },
  })

  const persons = personsQ.data ?? []
  const busy = label.isPending
  const trimmed = newName.trim()

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => { if (!busy) onClose() }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[460px] max-h-[85vh] bg-ink-surface border border-ink-border rounded-r3 shadow-elev-3 flex flex-col"
      >
        {/* Header — the crop that will be enrolled */}
        <div className="flex items-start gap-4 px-5 py-4 border-b border-ink-border">
          <EventThumb
            eventId={event.id}
            hasThumb={event.has_thumb}
            alt="Face crop that will be enrolled"
            className="w-20 h-20 rounded-r2 border border-ink-border flex-shrink-0"
          />
          <div className="flex-1 min-w-0">
            <h2 className="font-sans font-bold text-[18px] text-fg-1 leading-tight tracking-tight">
              Who is this?
            </h2>
            <p className="font-sans text-[12px] text-fg-3 mt-1 leading-relaxed">
              This exact photo is added to their profile and used to recognize them from now on.
              Past unrecognized sightings of the same face are relabeled too.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="w-7 h-7 flex items-center justify-center rounded-r1 text-fg-3 hover:text-fg-1 hover:bg-ink-raised transition-colors flex-shrink-0 cursor-pointer"
            aria-label="Close"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        {/* Existing people */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <span className="font-sans text-[11px] font-medium text-fg-3 uppercase tracking-[0.04em]">
            Enrolled people
          </span>

          {personsQ.isLoading ? (
            <p className="font-mono text-[10px] text-fg-3 uppercase tracking-[0.06em] py-4">Loading…</p>
          ) : persons.length === 0 ? (
            <p className="font-sans text-[12px] text-fg-3 py-3">
              Nobody is enrolled yet — add the first person below.
            </p>
          ) : (
            <div className="flex flex-col gap-1 mt-2">
              {persons.map((p) => (
                <button
                  key={p.id}
                  disabled={busy}
                  onClick={() => label.mutate({ target: { person_id: p.id }, name: p.name })}
                  className="flex items-center gap-3 px-2.5 py-2 rounded-r2 text-left hover:bg-ink-raised transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
                >
                  <div className="w-8 h-8 rounded-full bg-ink-dark border border-ink-border flex items-center justify-center flex-shrink-0">
                    <UserRound size={15} strokeWidth={1.75} className="text-fg-3" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-sans text-[13px] text-fg-1 truncate">{p.name}</div>
                    <div className="font-mono text-[10px] text-fg-3 tabular-nums uppercase tracking-[0.06em]">
                      {p.photo_count} {p.photo_count === 1 ? 'photo' : 'photos'}
                    </div>
                  </div>
                  {busy && label.variables?.name === p.name && (
                    <span className="font-mono text-[10px] text-fg-3 uppercase tracking-[0.06em]">Saving…</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* New person */}
          <div className="mt-4 pt-4 border-t border-ink-border">
            {creating ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (trimmed) label.mutate({ target: { new_person_name: trimmed }, name: trimmed })
                }}
                className="flex items-center gap-2"
              >
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Name"
                  disabled={busy}
                  className="flex-1 h-9 bg-ink-dark border border-ink-border rounded-r1 px-3 font-sans text-[13px] text-fg-1 outline-none placeholder:text-fg-4 focus:border-dim-red focus:shadow-[0_0_0_3px_rgba(232,58,41,0.12)] transition-all"
                />
                <Button variant="primary" type="submit" disabled={busy || !trimmed}>
                  {busy ? 'Adding…' : 'Add'}
                </Button>
                <Button variant="ghost" type="button" disabled={busy} onClick={() => { setCreating(false); setNewName('') }}>
                  Cancel
                </Button>
              </form>
            ) : (
              <button
                onClick={() => setCreating(true)}
                disabled={busy}
                className="inline-flex items-center gap-2 font-sans text-[13px] font-semibold text-dim-red hover:text-dim-red-hover transition-colors cursor-pointer disabled:opacity-50"
              >
                <Plus size={15} strokeWidth={2} />
                New person
              </button>
            )}
          </div>

          {label.isError && (
            <div className="mt-4 px-3.5 py-2.5 rounded-r1 bg-[rgba(232,58,41,0.12)] border border-[rgba(232,58,41,0.45)]">
              <p className="font-sans text-[12px] text-[#ff7c6f]">
                {label.error instanceof Error ? label.error.message : 'Failed to label sighting'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
