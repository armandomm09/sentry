import { create } from 'zustand'
import type { CameraWithStream } from '../types/camera'

interface SentryStore {
  selectedCameraId: string | null
  setSelectedCamera: (id: string | null) => void

  addCameraOpen: boolean
  setAddCameraOpen: (open: boolean) => void

  // Local optimistic cache used alongside react-query
  cameras: CameraWithStream[]
  setCameras: (cameras: CameraWithStream[]) => void
}

export const useStore = create<SentryStore>((set) => ({
  selectedCameraId: null,
  setSelectedCamera: (id) => set({ selectedCameraId: id }),

  addCameraOpen: false,
  setAddCameraOpen: (open) => set({ addCameraOpen: open }),

  cameras: [],
  setCameras: (cameras) => set({ cameras }),
}))
