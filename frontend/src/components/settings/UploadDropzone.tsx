import { ImagePlus, UploadCloud } from 'lucide-react'
import { useState, type RefObject } from 'react'

interface Props {
  inputRef?: RefObject<HTMLInputElement | null>
  onFiles: (files: File[]) => void
  uploading?: boolean
  /** compact = single-row variant used inside person cards */
  compact?: boolean
  /** label override */
  label?: string
}

const ACCEPT = 'image/jpeg,image/png,image/webp,image/bmp'

export function UploadDropzone({ inputRef, onFiles, uploading, compact, label }: Props) {
  const [hover, setHover] = useState(false)

  const handlePicked = (list: FileList | null) => {
    if (!list || list.length === 0) return
    const files = Array.from(list).filter(f => f.type.startsWith('image/'))
    if (files.length === 0) return
    onFiles(files)
  }

  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setHover(true) }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault()
        setHover(false)
        handlePicked(e.dataTransfer.files)
      }}
      className={`group flex items-center gap-3 rounded-r2 border border-dashed cursor-pointer transition-colors ${
        compact ? 'h-12 px-3' : 'h-28 px-4 flex-col justify-center text-center'
      } ${
        hover
          ? 'border-dim-red bg-[rgba(232,58,41,0.06)]'
          : 'border-ink-border bg-ink-dark hover:border-ink-border-strong'
      } ${uploading ? 'opacity-60 pointer-events-none' : ''}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          handlePicked(e.target.files)
          e.target.value = ''  // allow re-selecting the same file
        }}
      />
      {compact ? (
        <>
          <ImagePlus
            size={16}
            strokeWidth={1.75}
            className={`flex-shrink-0 ${hover ? 'text-dim-red' : 'text-fg-3 group-hover:text-fg-2'}`}
          />
          <span className="font-sans text-[12px] text-fg-2 flex-1">
            {uploading
              ? 'Uploading…'
              : label ?? 'Add photos — drop here or click to choose'}
          </span>
          <span className="font-mono text-[10px] text-fg-4 uppercase tracking-[0.06em] hidden sm:inline">
            JPG · PNG · WebP
          </span>
        </>
      ) : (
        <>
          <UploadCloud
            size={22}
            strokeWidth={1.5}
            className={hover ? 'text-dim-red' : 'text-fg-3 group-hover:text-fg-2'}
          />
          <div className="font-sans text-[13px] text-fg-1">
            {uploading ? 'Uploading…' : label ?? 'Drop photos here or click to browse'}
          </div>
          <div className="font-mono text-[10px] text-fg-4 uppercase tracking-[0.06em]">
            JPG · PNG · WebP — multiple OK
          </div>
        </>
      )}
    </label>
  )
}
