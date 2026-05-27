import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Trash2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '../../api/client'
import type { Person, PhotoUploadError } from '../../types/person'
import { UploadDropzone } from './UploadDropzone'

interface Props {
  person: Person
}

export function PersonCard({ person }: Props) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(person.name)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [uploadErrors, setUploadErrors] = useState<PhotoUploadError[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const photosQ = useQuery({
    queryKey: ['persons', person.id, 'photos'],
    queryFn: () => api.persons.listPhotos(person.id),
  })

  const rename = useMutation({
    mutationFn: (name: string) => api.persons.rename(person.id, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['persons'] })
      setEditing(false)
    },
  })

  const del = useMutation({
    mutationFn: () => api.persons.delete(person.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['persons'] }),
  })

  const upload = useMutation({
    mutationFn: (files: File[]) => api.persons.uploadPhotos(person.id, files),
    onSuccess: (res) => {
      setUploadErrors(res.errors)
      qc.invalidateQueries({ queryKey: ['persons'] })
      qc.invalidateQueries({ queryKey: ['persons', person.id, 'photos'] })
    },
  })

  const deletePhoto = useMutation({
    mutationFn: (photoId: string) => api.persons.deletePhoto(person.id, photoId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['persons'] })
      qc.invalidateQueries({ queryKey: ['persons', person.id, 'photos'] })
    },
  })

  const photos = photosQ.data ?? []

  const handleRename = () => {
    const trimmed = draftName.trim()
    if (!trimmed || trimmed === person.name) {
      setEditing(false)
      setDraftName(person.name)
      return
    }
    rename.mutate(trimmed)
  }

  return (
    <div className="bg-ink-surface border border-ink-border rounded-r3 overflow-hidden flex flex-col">
      {/* Header row */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-ink-border">
        {/* Avatar = first photo, or initial */}
        <Avatar person={person} firstPhotoId={photos[0]?.id} />

        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRename()
                  if (e.key === 'Escape') { setEditing(false); setDraftName(person.name) }
                }}
                className="flex-1 bg-ink-dark border border-dim-red rounded-r1 h-7 px-2 font-sans text-[13px] text-fg-1 outline-none shadow-[0_0_0_3px_rgba(232,58,41,0.12)]"
              />
              <IconButton title="Save" onClick={handleRename}>
                <Check size={14} strokeWidth={2} />
              </IconButton>
              <IconButton
                title="Cancel"
                onClick={() => { setEditing(false); setDraftName(person.name) }}
              >
                <X size={14} strokeWidth={2} />
              </IconButton>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-sans font-semibold text-[14px] text-fg-1 truncate">
                {person.name}
              </span>
              <button
                title="Rename"
                onClick={() => setEditing(true)}
                className="text-fg-4 hover:text-fg-1 transition-colors cursor-pointer"
                aria-label="Rename person"
              >
                <Pencil size={12} strokeWidth={1.75} />
              </button>
            </div>
          )}
          <div className="font-mono text-[10px] text-fg-3 mt-0.5 tabular-nums uppercase tracking-[0.06em]">
            {person.photo_count} {person.photo_count === 1 ? 'photo' : 'photos'}
          </div>
        </div>

        {/* Delete */}
        {confirmDelete ? (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => del.mutate()}
              disabled={del.isPending}
              className="font-sans text-[11px] font-semibold text-dim-red hover:text-dim-red-hover px-2 h-7 rounded-r1 border border-ink-border bg-[rgba(232,58,41,0.08)] cursor-pointer transition-colors"
            >
              {del.isPending ? 'Removing…' : 'Confirm'}
            </button>
            <IconButton title="Cancel" onClick={() => setConfirmDelete(false)}>
              <X size={14} strokeWidth={2} />
            </IconButton>
          </div>
        ) : (
          <IconButton title="Delete person" onClick={() => setConfirmDelete(true)} danger>
            <Trash2 size={14} strokeWidth={1.75} />
          </IconButton>
        )}
      </div>

      {/* Photo strip */}
      <div className="px-4 py-3">
        {photosQ.isLoading ? (
          <div className="h-16 flex items-center">
            <span className="font-mono text-[10px] text-fg-3 uppercase tracking-[0.06em]">
              Loading photos…
            </span>
          </div>
        ) : photos.length === 0 ? (
          <div className="h-16 flex items-center">
            <span className="font-sans text-[12px] text-fg-3">
              No photos yet — add at least one to enroll this person.
            </span>
          </div>
        ) : (
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {photos.map(p => (
              <PhotoThumb
                key={p.id}
                src={api.persons.photoUrl(person.id, p.id)}
                alt={`${person.name} photo`}
                onDelete={() => deletePhoto.mutate(p.id)}
                pending={deletePhoto.isPending && deletePhoto.variables === p.id}
              />
            ))}
          </div>
        )}
      </div>

      {/* Upload */}
      <div className="px-4 pb-4">
        <UploadDropzone
          inputRef={fileInputRef}
          onFiles={(files) => {
            setUploadErrors([])
            upload.mutate(files)
          }}
          uploading={upload.isPending}
          compact
        />
        {uploadErrors.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {uploadErrors.map((err, i) => (
              <p key={i} className="font-sans text-[11px] text-dim-red">
                <span className="font-mono">{err.filename}</span> — {err.error}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Avatar({ person, firstPhotoId }: { person: Person; firstPhotoId?: string }) {
  if (firstPhotoId) {
    return (
      <img
        src={api.persons.photoUrl(person.id, firstPhotoId)}
        alt={person.name}
        className="w-10 h-10 rounded-full object-cover bg-ink-dark border border-ink-border flex-shrink-0"
      />
    )
  }
  const initial = (person.name.trim()[0] || '?').toUpperCase()
  return (
    <div className="w-10 h-10 rounded-full bg-ink-raised border border-ink-border flex items-center justify-center flex-shrink-0">
      <span className="font-sans font-bold text-[14px] text-fg-2">{initial}</span>
    </div>
  )
}

function PhotoThumb({
  src, alt, onDelete, pending,
}: { src: string; alt: string; onDelete: () => void; pending: boolean }) {
  return (
    <div className="relative w-16 h-16 rounded-r2 overflow-hidden flex-shrink-0 group bg-ink-dark border border-ink-border">
      <img src={src} alt={alt} className="w-full h-full object-cover" />
      <button
        onClick={onDelete}
        disabled={pending}
        title="Remove photo"
        aria-label="Remove photo"
        className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
      >
        <Trash2 size={14} strokeWidth={1.75} className="text-fg-1" />
      </button>
    </div>
  )
}

function IconButton({
  children, onClick, title, danger,
}: { children: React.ReactNode; onClick: () => void; title: string; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`w-7 h-7 flex items-center justify-center rounded-r1 transition-colors cursor-pointer ${
        danger
          ? 'text-fg-3 hover:text-dim-red hover:bg-[rgba(232,58,41,0.12)]'
          : 'text-fg-3 hover:text-fg-1 hover:bg-ink-raised'
      }`}
    >
      {children}
    </button>
  )
}
