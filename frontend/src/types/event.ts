/** A persisted sighting from the events log (`/api/events`). */
export interface SentryEvent {
  id: string
  camera_id: string
  /** Set when the face-service recognized the person live. */
  person_id: string | null
  person_name: string
  similarity: number
  started_at: number
  ended_at: number
  /** Set when an operator named this sighting after the fact. */
  labeled_person_id: string | null
  has_thumb: boolean
  has_clip: boolean
  clip_expired: boolean
}

export interface EventPage {
  events: SentryEvent[]
  /** Cursor for the next page; null when this is the last page. */
  next_before: number | null
}

export interface LabelEventResult {
  labeled_person_id: string
  /** Other past unknown sightings the backend matched to the same face. */
  retro_labeled: number
}

/** A sighting is unknown until either the recognizer or an operator names it. */
export function isUnknown(e: SentryEvent): boolean {
  return !e.person_id && !e.labeled_person_id
}
