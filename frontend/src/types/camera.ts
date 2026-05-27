export type StreamStatus = 'live' | 'recording' | 'offline' | 'reconnecting'

export interface Camera {
  id: string
  name: string
  location: string
  rtsp_url: string
  auto_reconnect: boolean
  face_recognition_enabled: boolean
  created_at: string
}

export interface StreamInfo {
  camera_id: string
  status: StreamStatus
  hls_url?: string
  started_at?: string
  error?: string
}

export interface CameraWithStream extends Camera {
  stream: StreamInfo
}

export interface CreateCameraPayload {
  name: string
  location: string
  rtsp_url: string
  auto_reconnect: boolean
  face_recognition_enabled?: boolean
}
