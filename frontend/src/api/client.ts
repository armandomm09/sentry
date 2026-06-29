import type { CameraWithStream, CreateCameraPayload, StreamInfo } from '../types/camera'
import type { Person, Photo, PhotoUploadResult } from '../types/person'
import type { AugConfig } from '../types/augmentation'

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
    fetchPhoto: async (pid: string, photoId: string): Promise<string> => {
      const token = getToken()
      const res = await fetch(`${BASE}/persons/${pid}/photos/${photoId}/raw`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (res.status === 401) { handleUnauthorized(); throw new Error('Unauthorized') }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return URL.createObjectURL(await res.blob())
    },
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
