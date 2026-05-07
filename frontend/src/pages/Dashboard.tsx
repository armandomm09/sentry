import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../api/client'
import { CameraGrid } from '../components/camera/CameraGrid'
import { CameraView } from '../components/camera/CameraView'
import { AddCameraModal } from '../components/modals/AddCameraModal'
import { useStore } from '../store/useStore'
import type { CameraWithStream } from '../types/camera'
import { Brushstroke } from '../components/ui/Brushstroke'

export function Dashboard() {
  const [selectedCamera, setSelectedCamera] = useState<CameraWithStream | null>(null)
  const { addCameraOpen, setAddCameraOpen } = useStore()

  const { data: cameras = [], isLoading, isError } = useQuery({
    queryKey: ['cameras'],
    queryFn: () => api.cameras.list(),
    refetchInterval: 5000,
  })

  const online = cameras.filter(c => c.stream.status === 'live' || c.stream.status === 'recording').length

  if (selectedCamera) {
    const live = cameras.find(c => c.id === selectedCamera.id) ?? selectedCamera
    return (
      <>
        <CameraView camera={live} onBack={() => setSelectedCamera(null)} />
        <AddCameraModal open={addCameraOpen} onClose={() => setAddCameraOpen(false)} />
      </>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="px-6 pt-6 pb-4 border-b border-ink-border">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="font-sans font-bold text-[28px] text-fg-1 leading-none tracking-tight">
              Cameras
            </h1>
            <div className="h-2 mt-2 w-24 overflow-hidden">
              <Brushstroke />
            </div>
          </div>
          <div className="font-mono text-[11px] text-fg-3 tabular-nums pb-1">
            {isLoading ? (
              <span>Loading…</span>
            ) : isError ? (
              <span className="text-dim-red">Backend unreachable</span>
            ) : (
              <span>
                <span className="text-status-online font-semibold">{online}</span>
                {' '}of {cameras.length} cameras online
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-32">
            <div className="font-mono text-[11px] text-fg-3 uppercase tracking-[0.06em]">
              Connecting…
            </div>
          </div>
        ) : (
          <CameraGrid
            cameras={cameras}
            onOpen={setSelectedCamera}
            onAddCamera={() => setAddCameraOpen(true)}
          />
        )}
      </div>

      <AddCameraModal open={addCameraOpen} onClose={() => setAddCameraOpen(false)} />
    </div>
  )
}
