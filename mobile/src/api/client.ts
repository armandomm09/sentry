// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Camera = {
  id: string
  name: string
  location: string
  rtsp_url: string
  face_recognition: boolean
  auto_reconnect: boolean
}

export type StreamStatus = {
  status: 'live' | 'reconnecting'
  hls_url: string
  error?: string
}

export type StreamMap = Record<string, StreamStatus>

export type Person = {
  id: string
  name: string
  photo_count: number
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
    const json = (await res.json()) as { message?: string }
    if (json.message) message = json.message
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
  const res = await fetch(`${baseUrl}/api/push/subscribe`, {
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
