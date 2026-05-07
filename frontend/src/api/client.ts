import type { CameraWithStream, CreateCameraPayload, StreamInfo } from '../types/camera'

const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
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
  },
  streams: {
    start: (id: string) => request<StreamInfo>(`/cameras/${id}/stream/start`, { method: 'POST' }),
    stop: (id: string) => request<StreamInfo>(`/cameras/${id}/stream/stop`, { method: 'POST' }),
    status: (id: string) => request<StreamInfo>(`/cameras/${id}/stream/status`),
    all: () => request<Record<string, StreamInfo>>('/streams'),
  },
}
