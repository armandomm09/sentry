import { useEffect, useState } from 'react'
import { UserRound } from 'lucide-react'
import { api } from '../../api/client'

interface Props {
  eventId: string
  /** False when the sighting has no stored crop — skips the fetch entirely. */
  hasThumb: boolean
  className?: string
  alt?: string
}

/**
 * An event's best face crop, pulled through the authenticated thumb route.
 *
 * This is the same image the label flow enrolls, so it doubles as the "photo
 * that will be added" preview.
 */
export function EventThumb({ eventId, hasThumb, className = '', alt = 'Face crop' }: Props) {
  const [src, setSrc] = useState<string>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!hasThumb) return
    let url: string | undefined
    let cancelled = false
    setFailed(false)
    api.events.fetchThumb(eventId)
      .then((blobUrl) => {
        url = blobUrl
        if (cancelled) { URL.revokeObjectURL(blobUrl); return }
        setSrc(blobUrl)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
      setSrc(undefined)
    }
  }, [eventId, hasThumb])

  if (!hasThumb || failed) {
    return (
      <div className={`flex items-center justify-center bg-ink-dark ${className}`}>
        <UserRound size={16} strokeWidth={1.75} className="text-fg-4" />
      </div>
    )
  }

  // Hold the frame while the blob loads so the row doesn't jump.
  if (!src) return <div className={`bg-ink-dark ${className}`} />

  return <img src={src} alt={alt} className={`object-cover ${className}`} />
}
