import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { BellOff, CloudOff } from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../api/client'
import { EventDetail } from '../components/alerts/EventDetail'
import { EventThumb } from '../components/alerts/EventThumb'
import type { SentryEvent } from '../types/event'
import { isUnknown } from '../types/event'

const PAGE_SIZE = 50

type Filter = 'all' | 'unknown'

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** `started_at` is epoch milliseconds — the recorder stores `toMs(ts)`. */
function dayLabel(ts: number): string {
  const today = startOfDay(new Date())
  if (ts >= today) return 'Today'
  if (ts >= today - 86400000) return 'Yesterday'
  return new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

export function Alerts() {
  const [filter, setFilter] = useState<Filter>('all')
  const [cameraId, setCameraId] = useState<string>('')
  const [selectedEvent, setSelectedEvent] = useState<SentryEvent | null>(null)

  const camerasQ = useQuery({ queryKey: ['cameras'], queryFn: () => api.cameras.list() })

  const eventsQ = useInfiniteQuery({
    queryKey: ['events', { unknownOnly: filter === 'unknown', cameraId }],
    queryFn: ({ pageParam }) =>
      api.events.list({
        limit: PAGE_SIZE,
        before: pageParam,
        unknownOnly: filter === 'unknown',
        cameraId: cameraId || undefined,
      }),
    initialPageParam: undefined as number | undefined,
    // next_before is null on the last page, which ends the pagination.
    getNextPageParam: (last) => last.next_before ?? undefined,
  })

  const cameraNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const c of camerasQ.data ?? []) map[c.id] = c.name
    return map
  }, [camerasQ.data])

  const events = useMemo(
    () => eventsQ.data?.pages.flatMap((p) => p.events) ?? [],
    [eventsQ.data],
  )

  // The API returns newest-first, so same-day sightings arrive consecutively.
  const sections = useMemo(() => {
    const out: { title: string; items: SentryEvent[] }[] = []
    for (const e of events) {
      const label = dayLabel(e.started_at)
      const last = out[out.length - 1]
      if (last && last.title === label) last.items.push(e)
      else out.push({ title: label, items: [e] })
    }
    return out
  }, [events])

  // Prefer the freshly fetched copy so a label applied here shows up, but keep
  // the pane populated when the sighting drops out of the list — labeling one
  // under "Unknown only" removes its row, and the confirmation has to survive.
  const selected = useMemo(
    () => (selectedEvent ? events.find((e) => e.id === selectedEvent.id) ?? selectedEvent : null),
    [events, selectedEvent],
  )

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <h1 className="font-sans font-bold text-[22px] text-fg-1 tracking-tight">Alerts</h1>
        <p className="font-sans text-[13px] text-fg-3 mt-1">
          Every confirmed sighting your cameras recorded. Name the unrecognized ones to enroll them.
        </p>

        <div className="flex items-center gap-2 mt-4">
          {(['all', 'unknown'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`h-8 px-3.5 rounded-full font-sans text-[12px] font-semibold transition-colors cursor-pointer ${
                filter === f
                  ? 'bg-dim-red text-white'
                  : 'bg-ink-surface text-fg-3 border border-ink-border hover:text-fg-1'
              }`}
            >
              {f === 'all' ? 'All' : 'Unknown only'}
            </button>
          ))}

          <select
            value={cameraId}
            onChange={(e) => setCameraId(e.target.value)}
            className="h-8 px-2.5 rounded-r1 bg-ink-surface border border-ink-border font-sans text-[12px] text-fg-2 outline-none cursor-pointer focus:border-dim-red"
          >
            <option value="">All cameras</option>
            {(camerasQ.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Master–detail */}
      <div className="flex-1 min-h-0 flex gap-4 px-6 pb-6">
        {/* List */}
        <div className="w-[380px] flex-shrink-0 bg-ink-surface border border-ink-border rounded-r3 overflow-y-auto">
          {eventsQ.isLoading ? (
            <p className="font-mono text-[10px] text-fg-3 uppercase tracking-[0.06em] p-4">Loading…</p>
          ) : eventsQ.isError ? (
            <EmptyState
              icon={<CloudOff size={28} strokeWidth={1.5} className="text-fg-4" />}
              title={eventsQ.error instanceof Error ? eventsQ.error.message : 'Failed to load alerts'}
              body="Check that the backend is reachable."
            />
          ) : events.length === 0 ? (
            <EmptyState
              icon={<BellOff size={28} strokeWidth={1.5} className="text-fg-4" />}
              title="No alerts yet"
              body={
                filter === 'unknown'
                  ? 'No unrecognized faces have been seen.'
                  : 'Sightings from your cameras will appear here.'
              }
            />
          ) : (
            <>
              {sections.map((section) => (
                <div key={section.title}>
                  <div className="px-4 py-2 font-mono text-[10px] text-fg-3 uppercase tracking-[0.06em] bg-ink-dark/40 sticky top-0 backdrop-blur-sm">
                    {section.title}
                  </div>
                  {section.items.map((e) => (
                    <EventRow
                      key={e.id}
                      event={e}
                      cameraName={cameraNames[e.camera_id] ?? 'Unknown camera'}
                      selected={e.id === selectedEvent?.id}
                      onSelect={() => setSelectedEvent(e)}
                    />
                  ))}
                </div>
              ))}
              {eventsQ.hasNextPage && (
                <button
                  onClick={() => void eventsQ.fetchNextPage()}
                  disabled={eventsQ.isFetchingNextPage}
                  className="w-full py-3 font-sans text-[12px] font-semibold text-fg-3 hover:text-fg-1 transition-colors cursor-pointer"
                >
                  {eventsQ.isFetchingNextPage ? 'Loading…' : 'Load older'}
                </button>
              )}
            </>
          )}
        </div>

        {/* Detail */}
        <div className="flex-1 min-w-0 bg-ink-surface border border-ink-border rounded-r3 overflow-y-auto p-5">
          {selected ? (
            <EventDetail
              key={selected.id}
              event={selected}
              cameraName={cameraNames[selected.camera_id] ?? 'Unknown camera'}
            />
          ) : (
            <div className="h-full flex items-center justify-center">
              <span className="font-sans text-[13px] text-fg-3">
                Select a sighting to see its clip and label it.
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function EventRow({
  event, cameraName, selected, onSelect,
}: { event: SentryEvent; cameraName: string; selected: boolean; onSelect: () => void }) {
  const unknown = isUnknown(event)
  const name = unknown ? 'Unknown person' : event.person_name || 'Known person'
  const time = new Date(event.started_at).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })

  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left border-b border-ink-border transition-colors cursor-pointer ${
        selected ? 'bg-ink-raised' : 'hover:bg-ink-raised/60'
      }`}
    >
      <EventThumb
        eventId={event.id}
        hasThumb={event.has_thumb}
        className="w-11 h-11 rounded-r2 border border-ink-border flex-shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          {unknown && <span className="w-1.5 h-1.5 rounded-full bg-status-warn flex-shrink-0" />}
          <span className={`font-sans text-[13px] truncate ${unknown ? 'text-status-warn' : 'text-fg-1'}`}>
            {name}
          </span>
        </div>
        <div className="font-mono text-[10px] text-fg-3 mt-0.5 truncate uppercase tracking-[0.06em]">
          {cameraName}
        </div>
      </div>
      <span className="font-mono text-[10px] text-fg-3 tabular-nums flex-shrink-0">{time}</span>
    </button>
  )
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-8 py-16 gap-3">
      {icon}
      <div className="font-sans font-semibold text-[14px] text-fg-1">{title}</div>
      <div className="font-sans text-[12px] text-fg-3">{body}</div>
    </div>
  )
}
