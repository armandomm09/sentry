import type { CameraWithStream, CreateCameraPayload, StreamInfo } from '../types/camera'
import type { Person, Photo, PhotoUploadResult } from '../types/person'
import type { AugConfig } from '../types/augmentation'
import type { EventPage, LabelEventResult, SentryEvent } from '../types/event'

const BASE = '/api'

function getToken(): string {
  return localStorage.getItem('sentry_token') ?? ''
}

function handleUnauthorized() {
  localStorage.removeItem('sentry_token')
  window.location.href = '/login'
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData
  const headers: Record<string, string> = isFormData
    ? { ...(init?.headers as Record<string, string> | undefined) }
    : { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) }

  const token = getToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers })

  if (res.status === 401) {
    handleUnauthorized()
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

/**
 * GET a binary route and expose it as an object URL.
 *
 * Used for authenticated media: <img>/<video> can't send an Authorization
 * header, so the bytes are fetched here and handed over as a blob. The caller
 * is responsible for URL.revokeObjectURL.
 */
async function fetchAsObjectURL(path: string): Promise<string> {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (res.status === 401) { handleUnauthorized(); throw new Error('Unauthorized') }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  }
  return URL.createObjectURL(await res.blob())
}

export const api = {
  cameras: {
    list: () => request<CameraWithStream[]>('/cameras'),
    get: (id: string) => request<{ camera: CameraWithStream; stream: StreamInfo }>(`/cameras/${id}`),
    create: (payload: CreateCameraPayload) =>
      request<{ camera: CameraWithStream; stream: StreamInfo }>('/cameras', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    update: (id: string, payload: Partial<CreateCameraPayload>) =>
      request<{ camera: CameraWithStream; stream: StreamInfo }>(`/cameras/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    delete: (id: string) => request<void>(`/cameras/${id}`, { method: 'DELETE' }),
    setFaceRecognition: (id: string, enabled: boolean) =>
      request<{ camera: CameraWithStream; stream: StreamInfo }>(`/cameras/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ face_recognition_enabled: enabled }),
      }),
    // Cameras sit on a private network the browser can't route to (and
    // snapshot_url often embeds credentials, which browsers refuse to load
    // as a resource URL) — always go through the authenticated proxy.
    fetchSnapshot: (id: string): Promise<string> => fetchAsObjectURL(`/cameras/${id}/snapshot`),
  },
  streams: {
    start: (id: string) => request<StreamInfo>(`/cameras/${id}/stream/start`, { method: 'POST' }),
    stop: (id: string) => request<StreamInfo>(`/cameras/${id}/stream/stop`, { method: 'POST' }),
    status: (id: string) => request<StreamInfo>(`/cameras/${id}/stream/status`),
    all: () => request<Record<string, StreamInfo>>('/streams'),
  },
  persons: {
    list: () => request<Person[]>('/persons'),
    get: (pid: string) => request<Person>(`/persons/${pid}`),
    create: (name: string) =>
      request<Person>('/persons', { method: 'POST', body: JSON.stringify({ name }) }),
    rename: (pid: string, name: string) =>
      request<Person>(`/persons/${pid}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    delete: (pid: string) => request<void>(`/persons/${pid}`, { method: 'DELETE' }),

    listPhotos: (pid: string) => request<Photo[]>(`/persons/${pid}/photos`),
    uploadPhotos: (pid: string, files: File[]) => {
      const fd = new FormData()
      for (const f of files) fd.append('photo', f, f.name)
      return request<PhotoUploadResult>(`/persons/${pid}/photos`, {
        method: 'POST',
        body: fd,
      })
    },
    deletePhoto: (pid: string, photoId: string) =>
      request<void>(`/persons/${pid}/photos/${photoId}`, { method: 'DELETE' }),
    fetchPhoto: (pid: string, photoId: string): Promise<string> =>
      fetchAsObjectURL(`/persons/${pid}/photos/${photoId}/raw`),
  },
  events: {
    list: (opts: { before?: number; limit?: number; cameraId?: string; unknownOnly?: boolean } = {}) => {
      const params = new URLSearchParams()
      if (opts.before !== undefined) params.set('before', String(opts.before))
      if (opts.limit !== undefined) params.set('limit', String(opts.limit))
      if (opts.cameraId) params.set('camera_id', opts.cameraId)
      if (opts.unknownOnly) params.set('unknown', '1')
      return request<EventPage>(`/events?${params.toString()}`)
    },
    get: (id: string) => request<SentryEvent>(`/events/${id}`),

    /**
     * Name an unknown sighting, enrolling its face crop for future recognition.
     * Pass exactly one of `person_id` or `new_person_name` — the API rejects both.
     */
    label: (id: string, target: { person_id: string } | { new_person_name: string }) =>
      request<LabelEventResult>(`/events/${id}/label`, {
        method: 'POST',
        body: JSON.stringify(target),
      }),

    // Thumb and clip routes are authenticated, and neither <img> nor <video>
    // can carry an Authorization header — fetch the bytes and hand back an
    // object URL instead. Callers own revoking it.
    fetchThumb: (id: string) => fetchAsObjectURL(`/events/${id}/thumb`),
    fetchClip: (id: string) => fetchAsObjectURL(`/events/${id}/clip`),
  },
  augmentation: {
    getConfig: () => request<AugConfig>('/augmentation/config'),
    setConfig: (cfg: AugConfig) =>
      request<AugConfig>('/augmentation/config', {
        method: 'PUT',
        body: JSON.stringify(cfg),
      }),
    regenerate: () =>
      request<{ augmented_embeddings_created: number }>('/augmentation/regenerate', {
        method: 'POST',
      }),
  },
}
