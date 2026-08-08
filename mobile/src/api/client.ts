// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Camera = {
  id: string
  name: string
  location: string
  rtsp_url: string
  snapshot_url: string
  face_recognition_enabled: boolean
  auto_reconnect: boolean
}

export type StreamStatus = {
  status: 'live' | 'reconnecting'
  hls_url: string
  error?: string
}

export type StreamMap = Record<string, StreamStatus>

/** Fields accepted when creating a camera. Update sends the same shape, partial. */
export type CameraPayload = {
  name: string
  location: string
  rtsp_url: string
  snapshot_url?: string
  auto_reconnect: boolean
  face_recognition_enabled?: boolean
}

export type Person = {
  id: string
  name: string
  photo_count: number
}

export type Photo = {
  id: string
  person_id: string
  photo_path: string
  created_at: string
}

export type PhotoUploadResult = {
  added: Photo[]
  errors: { filename: string; error: string }[]
}

/** A persisted sighting from the events log (`/api/events`). */
export type SentryEvent = {
  id: string
  camera_id: string
  person_id: string | null
  person_name: string
  similarity: number
  started_at: number
  ended_at: number
  labeled_person_id: string | null
  has_thumb: boolean
  has_clip: boolean
  clip_expired: boolean
}

export type EventPage = {
  events: SentryEvent[]
  /** Cursor for the next page; null when this is the last page. */
  next_before: number | null
}

export type PushRegistration = {
  expo_push_token: string
  camera_ids: string[]
  notify_known: boolean
  notify_unknown: boolean
}

export type PushSubscription = {
  expo_push_token: string
  camera_ids: string[]
  notify_known: boolean
  notify_unknown: boolean
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function authHeaders(token: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.ok) {
    // 204 No Content — return void cast
    if (res.status === 204) {
      return undefined as T
    }
    return (await res.json()) as T
  }

  let message = 'Request failed'
  try {
    // The Go API reports failures as {"error": ...}; the face-service proxy and
    // auth endpoints use {"message": ...}. Accept either.
    const json = (await res.json()) as { message?: string; error?: string }
    if (json.error) message = json.error
    else if (json.message) message = json.message
  } catch {
    // ignore parse errors — use fallback
  }
  throw new Error(message)
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------
export async function getCameras(baseUrl: string, token: string): Promise<Camera[]> {
  const res = await fetch(`${baseUrl}/api/cameras`, {
    headers: authHeaders(token),
  })
  return handleResponse<Camera[]>(res)
}

export async function getStreams(baseUrl: string, token: string): Promise<StreamMap> {
  const res = await fetch(`${baseUrl}/api/streams`, {
    headers: authHeaders(token),
  })
  return handleResponse<StreamMap>(res)
}

export async function getPersons(baseUrl: string, token: string): Promise<Person[]> {
  const res = await fetch(`${baseUrl}/api/persons`, {
    headers: authHeaders(token),
  })
  return handleResponse<Person[]>(res)
}

export async function registerPush(
  baseUrl: string,
  token: string,
  payload: PushRegistration,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/push/register`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  })
  return handleResponse<void>(res)
}

export async function getPushSubscription(
  baseUrl: string,
  token: string,
): Promise<PushSubscription | null> {
  const res = await fetch(`${baseUrl}/api/push/subscription`, {
    headers: authHeaders(token),
  })

  // 404 means no subscription exists
  if (res.status === 404) {
    return null
  }

  return handleResponse<PushSubscription>(res)
}

export async function deletePushSubscription(baseUrl: string, token: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/push/subscription`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
  return handleResponse<void>(res)
}

// ---------------------------------------------------------------------------
// Cameras — write operations
// ---------------------------------------------------------------------------
export async function createCamera(
  baseUrl: string,
  token: string,
  payload: CameraPayload,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/cameras`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  })
  return handleResponse<void>(res)
}

export async function updateCamera(
  baseUrl: string,
  token: string,
  id: string,
  payload: Partial<CameraPayload>,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/cameras/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  })
  return handleResponse<void>(res)
}

export async function deleteCamera(baseUrl: string, token: string, id: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/cameras/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
  return handleResponse<void>(res)
}

export async function startStream(baseUrl: string, token: string, id: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/cameras/${encodeURIComponent(id)}/stream/start`, {
    method: 'POST',
    headers: authHeaders(token),
  })
  return handleResponse<void>(res)
}

export async function stopStream(baseUrl: string, token: string, id: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/cameras/${encodeURIComponent(id)}/stream/stop`, {
    method: 'POST',
    headers: authHeaders(token),
  })
  return handleResponse<void>(res)
}

// ---------------------------------------------------------------------------
// Persons — write operations and photos
// ---------------------------------------------------------------------------
export async function createPerson(
  baseUrl: string,
  token: string,
  name: string,
): Promise<Person> {
  const res = await fetch(`${baseUrl}/api/persons`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ name }),
  })
  return handleResponse<Person>(res)
}

export async function renamePerson(
  baseUrl: string,
  token: string,
  personId: string,
  name: string,
): Promise<Person> {
  const res = await fetch(`${baseUrl}/api/persons/${encodeURIComponent(personId)}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ name }),
  })
  return handleResponse<Person>(res)
}

export async function deletePerson(
  baseUrl: string,
  token: string,
  personId: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/persons/${encodeURIComponent(personId)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  })
  return handleResponse<void>(res)
}

export async function getPhotos(
  baseUrl: string,
  token: string,
  personId: string,
): Promise<Photo[]> {
  const res = await fetch(`${baseUrl}/api/persons/${encodeURIComponent(personId)}/photos`, {
    headers: authHeaders(token),
  })
  return handleResponse<Photo[]>(res)
}

/**
 * Uploads picked images as multipart/form-data.
 *
 * React Native's FormData takes `{ uri, name, type }` in place of a File and
 * streams the local file itself, so picked images never have to be read into
 * JS memory. Content-Type is deliberately omitted — RN must set the multipart
 * boundary itself.
 */
export async function uploadPhotos(
  baseUrl: string,
  token: string,
  personId: string,
  assets: { uri: string; fileName?: string | null; mimeType?: string | null }[],
): Promise<PhotoUploadResult> {
  const form = new FormData()
  assets.forEach((asset, i) => {
    form.append('photo', {
      uri: asset.uri,
      name: asset.fileName ?? `photo-${String(i + 1)}.jpg`,
      type: asset.mimeType ?? 'image/jpeg',
    } as unknown as Blob)
  })

  const res = await fetch(`${baseUrl}/api/persons/${encodeURIComponent(personId)}/photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  return handleResponse<PhotoUploadResult>(res)
}

export async function deletePhoto(
  baseUrl: string,
  token: string,
  personId: string,
  photoId: string,
): Promise<void> {
  const res = await fetch(
    `${baseUrl}/api/persons/${encodeURIComponent(personId)}/photos/${encodeURIComponent(photoId)}`,
    { method: 'DELETE', headers: authHeaders(token) },
  )
  return handleResponse<void>(res)
}

/** URL of a photo's raw bytes. Needs an Authorization header to fetch. */
export function photoUrl(baseUrl: string, personId: string, photoId: string): string {
  return `${baseUrl}/api/persons/${encodeURIComponent(personId)}/photos/${encodeURIComponent(photoId)}/raw`
}

// ---------------------------------------------------------------------------
// Events — the persisted sighting log behind "past alerts"
// ---------------------------------------------------------------------------
export async function getEvents(
  baseUrl: string,
  token: string,
  opts: { before?: number; limit?: number; cameraId?: string; unknownOnly?: boolean } = {},
): Promise<EventPage> {
  const params = new URLSearchParams()
  if (opts.before !== undefined) params.set('before', String(opts.before))
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  if (opts.cameraId) params.set('camera_id', opts.cameraId)
  if (opts.unknownOnly) params.set('unknown', '1')

  const res = await fetch(`${baseUrl}/api/events?${params.toString()}`, {
    headers: authHeaders(token),
  })
  return handleResponse<EventPage>(res)
}

/** URL of an event's thumbnail. Needs an Authorization header to fetch. */
export function eventThumbUrl(baseUrl: string, eventId: string): string {
  return `${baseUrl}/api/events/${encodeURIComponent(eventId)}/thumb`
}
