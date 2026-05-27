export interface Person {
  id: string
  name: string
  created_at: string
  photo_count: number
}

export interface Photo {
  id: string
  person_id: string
  photo_path: string
  created_at: string
}

export interface PhotoUploadError {
  filename: string
  error: string
}

export interface PhotoUploadResult {
  added: Photo[]
  errors: PhotoUploadError[]
}
