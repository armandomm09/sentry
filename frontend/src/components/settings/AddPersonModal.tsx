import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../api/client'
import type { PhotoUploadError } from '../../types/person'
import { Button } from '../ui/Button'
import { UploadDropzone } from './UploadDropzone'

interface Props {
  open: boolean
  onClose: () => void
}

export function AddPersonModal({ open, onClose }: Props) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [nameError, setNameError] = useState<string | null>(null)
  const [uploadErrors, setUploadErrors] = useState<PhotoUploadError[]>([])
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const reset = () => {
    setName('')
    setFiles([])
    setNameError(null)
    setUploadErrors([])
    setSubmitError(null)
    setSubmitting(false)
  }

  const handleClose = () => {
    if (submitting) return
    reset()
    onClose()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setNameError('Name is required')
      return
    }
    setNameError(null)
    setSubmitError(null)
    setSubmitting(true)
    try {
      const person = await api.persons.create(trimmed)
      let errors: PhotoUploadError[] = []
      if (files.length > 0) {
        const res = await api.persons.uploadPhotos(person.id, files)
        errors = res.errors
      }
      qc.invalidateQueries({ queryKey: ['persons'] })
      if (errors.length > 0) {
        // Person was created, but some photos failed — keep the modal open so the
        // user can see which ones and decide whether to retry.
        setUploadErrors(errors)
        setFiles([])
        setSubmitting(false)
        return
      }
      reset()
      onClose()
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to add person')
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={handleClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-[480px] bg-ink-surface border border-ink-border rounded-r3 shadow-elev-3 flex flex-col"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-ink-border">
          <div>
            <h2 className="font-sans font-bold text-[18px] text-fg-1 leading-tight tracking-tight">
              Add person
            </h2>
            <p className="font-sans text-[12px] text-fg-3 mt-1 leading-relaxed">
              Photos are used to extract a face embedding. Two or three clear, well-lit shots are
              enough — vary the angle if you can.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="w-7 h-7 flex items-center justify-center rounded-r1 text-fg-3 hover:text-fg-1 hover:bg-ink-raised transition-colors flex-shrink-0 ml-3 mt-0.5 cursor-pointer"
            aria-label="Close"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 flex flex-col gap-4">
          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="person-name"
              className="font-sans text-[11px] font-medium text-fg-3 uppercase tracking-[0.04em]"
            >
              Name
            </label>
            <input
              id="person-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Alex Chen"
              className={`h-9 bg-ink-dark border rounded-r1 text-fg-1 px-3 outline-none transition-all duration-[200ms] placeholder:text-fg-4 font-sans text-[13px] ${
                nameError
                  ? 'border-dim-red'
                  : 'border-ink-border focus:border-dim-red focus:shadow-[0_0_0_3px_rgba(232,58,41,0.12)]'
              }`}
            />
            {nameError && (
              <p className="font-sans text-[11px] text-dim-red">{nameError}</p>
            )}
          </div>

          {/* Photos */}
          <div className="flex flex-col gap-1.5">
            <span className="font-sans text-[11px] font-medium text-fg-3 uppercase tracking-[0.04em]">
              Initial photos (optional)
            </span>
            <UploadDropzone
              onFiles={(picked) => setFiles((prev) => [...prev, ...picked])}
              label="Drop photos here or click to browse"
            />
            {files.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {files.map((f, i) => (
                  <FilePill
                    key={`${f.name}-${i}`}
                    name={f.name}
                    onRemove={() => setFiles(files.filter((_, j) => j !== i))}
                  />
                ))}
              </div>
            )}
          </div>

          {uploadErrors.length > 0 && (
            <div className="px-3.5 py-2.5 rounded-r1 bg-[rgba(232,58,41,0.08)] border border-[rgba(232,58,41,0.35)]">
              <p className="font-sans text-[12px] text-[#ff7c6f] font-semibold mb-1">
                Some photos could not be enrolled
              </p>
              <ul className="flex flex-col gap-0.5">
                {uploadErrors.map((err, i) => (
                  <li key={i} className="font-sans text-[11px] text-[#ff9a8f]">
                    <span className="font-mono">{err.filename}</span> — {err.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {submitError && (
            <div className="px-3.5 py-2.5 rounded-r1 bg-[rgba(232,58,41,0.12)] border border-[rgba(232,58,41,0.45)]">
              <p className="font-sans text-[12px] text-[#ff7c6f]">{submitError}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-ink-border">
          <Button variant="ghost" type="button" onClick={handleClose} disabled={submitting}>
            {uploadErrors.length > 0 ? 'Close' : 'Cancel'}
          </Button>
          <Button variant="primary" type="submit" icon="plus" disabled={submitting}>
            {submitting ? 'Adding…' : files.length > 0 ? `Add with ${files.length} photo${files.length === 1 ? '' : 's'}` : 'Add person'}
          </Button>
        </div>
      </form>
    </div>
  )
}

function FilePill({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1 rounded-r1 bg-ink-dark border border-ink-border">
      <span className="font-mono text-[11px] text-fg-2 truncate max-w-[200px]">{name}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="w-5 h-5 flex items-center justify-center rounded-r1 text-fg-3 hover:text-fg-1 hover:bg-ink-raised transition-colors cursor-pointer"
      >
        <X size={12} strokeWidth={2} />
      </button>
    </span>
  )
}
