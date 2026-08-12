import { useEffect, useState } from 'react'
import { CheckCircle2, CircleAlert, UserPlus } from 'lucide-react'
import type { LabelEventResult, SentryEvent } from '../../types/event'
import { isUnknown } from '../../types/event'
import { api } from '../../api/client'
import { Button } from '../ui/Button'
import { EventThumb } from './EventThumb'
import { LabelPersonModal } from './LabelPersonModal'

interface Props {
  event: SentryEvent
  cameraName: string
}

/** Both timestamps are epoch milliseconds — the recorder stores `toMs(ts)`. */
function formatWhen(startedAt: number, endedAt: number): string {
  const start = new Date(startedAt)
  const date = start.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
  const time = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const secs = Math.round((endedAt - startedAt) / 1000)
  if (!Number.isFinite(secs) || secs <= 0) return `${date} at ${time}`
  const dur = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${date} at ${time} · seen for ${dur}`
}

/** The recorded clip, fetched as a blob because <video> can't send auth headers. */
function ClipPlayer({ eventId }: { eventId: string }) {
  const [src, setSrc] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let url: string | undefined
    let cancelled = false
    setSrc(undefined)
    setError(undefined)
    api.events.fetchClip(eventId)
      .then((blobUrl) => {
        url = blobUrl
        if (cancelled) { URL.revokeObjectURL(blobUrl); return }
        setSrc(blobUrl)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load clip')
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [eventId])

  if (error) {
    return (
      <div className="aspect-video bg-ink-dark rounded-r2 border border-ink-border flex items-center justify-center">
        <span className="font-sans text-[12px] text-fg-3">{error}</span>
      </div>
    )
  }
  if (!src) {
    return (
      <div className="aspect-video bg-ink-dark rounded-r2 border border-ink-border flex items-center justify-center">
        <span className="font-mono text-[10px] text-fg-3 uppercase tracking-[0.06em]">Loading clip…</span>
      </div>
    )
  }
  return (
    <video
      src={src}
      controls
      autoPlay
      className="w-full aspect-video bg-black rounded-r2 border border-ink-border"
    />
  )
}

export function EventDetail({ event, cameraName }: Props) {
  const [picking, setPicking] = useState(false)
  const [labeled, setLabeled] = useState<{ name: string; retro: number } | null>(null)

  // A different sighting selected in the list means the local "just labeled"
  // banner no longer applies.
  useEffect(() => { setLabeled(null) }, [event.id])

  const wasUnknown = isUnknown(event)
  const title = labeled ? labeled.name : wasUnknown ? 'Unknown person' : event.person_name || 'Known person'

  const handleLabeled = (result: LabelEventResult, personName: string) => {
    setPicking(false)
    setLabeled({ name: personName, retro: result.retro_labeled })
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-sans font-bold text-[20px] text-fg-1 tracking-tight leading-tight">{title}</h2>
        <p className="font-mono text-[11px] text-fg-3 mt-1 uppercase tracking-[0.06em]">
          {cameraName}
        </p>
      </div>

      {event.has_clip ? (
        <ClipPlayer eventId={event.id} />
      ) : (
        <div className="aspect-video bg-ink-dark rounded-r2 border border-ink-border flex flex-col items-center justify-center gap-3">
          <EventThumb
            eventId={event.id}
            hasThumb={event.has_thumb}
            className="w-24 h-24 rounded-r2 border border-ink-border"
          />
          <span className="font-sans text-[12px] text-fg-3">
            {event.clip_expired
              ? 'The clip for this sighting has expired'
              : 'No clip was recorded for this sighting'}
          </span>
        </div>
      )}

      {/* Labeling. Stays mounted after a successful label: the refetched event
          is no longer unknown, but the confirmation still needs to be read. */}
      {(wasUnknown || labeled !== null) && (
        <div className="flex items-start gap-3 p-4 rounded-r3 bg-ink-dark border border-ink-border">
          {labeled ? (
            <>
              <CheckCircle2 size={18} strokeWidth={1.75} className="text-status-online flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-sans font-semibold text-[13px] text-fg-1">Enrolled as {labeled.name}</div>
                <p className="font-sans text-[12px] text-fg-3 mt-1 leading-relaxed">
                  {labeled.retro > 0
                    ? `This face is now recognized, and ${labeled.retro} earlier ${labeled.retro === 1 ? 'sighting was' : 'sightings were'} matched to them too.`
                    : 'This face will be recognized from now on.'}
                </p>
              </div>
            </>
          ) : event.has_thumb ? (
            <>
              <EventThumb
                eventId={event.id}
                hasThumb
                className="w-14 h-14 rounded-r2 border border-ink-border flex-shrink-0"
              />
              <div className="flex-1">
                <div className="font-sans font-semibold text-[13px] text-fg-1">Not recognized</div>
                <p className="font-sans text-[12px] text-fg-3 mt-1 leading-relaxed">
                  Name this person to teach the cameras who they are.
                </p>
              </div>
              <Button variant="primary" onClick={() => setPicking(true)}>
                <UserPlus size={15} strokeWidth={1.75} />
                Who is this?
              </Button>
            </>
          ) : (
            <>
              <CircleAlert size={18} strokeWidth={1.75} className="text-fg-3 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-sans font-semibold text-[13px] text-fg-1">Not recognized</div>
                <p className="font-sans text-[12px] text-fg-3 mt-1 leading-relaxed">
                  No usable face was captured for this sighting, so it can't be enrolled.
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* Metadata */}
      <dl className="flex flex-col">
        <DetailRow label="Person" value={title} />
        <DetailRow label="Camera" value={cameraName} />
        <DetailRow label="When" value={formatWhen(event.started_at, event.ended_at)} />
        {!wasUnknown && event.similarity > 0 && (
          <DetailRow label="Match" value={`${(event.similarity * 100).toFixed(0)}% similarity`} />
        )}
      </dl>

      {picking && (
        <LabelPersonModal
          event={event}
          onClose={() => setPicking(false)}
          onLabeled={handleLabeled}
        />
      )}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-2.5 border-b border-ink-border">
      <dt className="font-sans text-[10px] font-semibold text-fg-3 uppercase tracking-[0.06em]">{label}</dt>
      <dd className="font-sans text-[13px] text-fg-1 mt-1">{value}</dd>
    </div>
  )
}
