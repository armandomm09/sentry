import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, RotateCcw, Sliders } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import type { AugConfig } from '../../types/augmentation'
import { DEFAULT_AUG_CONFIG } from '../../types/augmentation'
import { Button } from '../ui/Button'

export function AugmentationSettings({ hasPersons }: { hasPersons: boolean }) {
  const qc = useQueryClient()
  const [guideOpen, setGuideOpen] = useState(false)

  const configQ = useQuery({
    queryKey: ['augmentation-config'],
    queryFn: () => api.augmentation.getConfig(),
  })

  const saveMut = useMutation({
    mutationFn: (cfg: AugConfig) => api.augmentation.setConfig(cfg),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['augmentation-config'] }),
  })

  const regenMut = useMutation({
    mutationFn: () => api.augmentation.regenerate(),
  })

  const cfg = configQ.data ?? DEFAULT_AUG_CONFIG
  const allDisabled =
    !cfg.flip_enabled &&
    !cfg.brightness_enabled &&
    !cfg.contrast_enabled &&
    !cfg.rotation_enabled &&
    !cfg.pixel_quality_enabled

  function patch(update: Partial<AugConfig>) {
    const next = { ...cfg, ...update }
    saveMut.mutate(next)
  }

  return (
    <div className="bg-ink-dark border border-ink-border rounded-r3 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-ink-border">
        <div className="flex items-center gap-2">
          <Sliders size={14} className="text-fg-3" strokeWidth={1.75} />
          <span className="font-sans font-semibold text-[13px] text-fg-1">
            Enrollment augmentation
          </span>
        </div>
        <button
          className="font-mono text-[10px] text-fg-3 uppercase tracking-[0.06em] flex items-center gap-1 hover:text-fg-2 transition-colors"
          onClick={() => patch(DEFAULT_AUG_CONFIG)}
        >
          <RotateCcw size={10} />
          Reset defaults
        </button>
      </div>

      <div className="p-5 flex flex-col gap-4">
        <p className="font-sans text-[12px] text-fg-3 leading-relaxed">
          When you upload a photo, Sentry generates additional embedding variants to improve
          recognition at distance and in varied lighting. Toggle types and adjust their parameters below.
        </p>

        {/* Flip */}
        <AugRow
          label="Horizontal flip"
          description="Mirrors the face — helps with slight left/right head turns."
          enabled={cfg.flip_enabled}
          onToggle={v => patch({ flip_enabled: v })}
        />

        {/* Brightness */}
        <AugRow
          label="Brightness"
          description="Simulates darker and brighter lighting conditions."
          enabled={cfg.brightness_enabled}
          onToggle={v => patch({ brightness_enabled: v })}
        >
          <ParamRow label="Steps" value={cfg.brightness_steps} min={1} max={6}
            onChange={v => patch({ brightness_steps: v })} />
          <ParamRow label="Magnitude %" value={cfg.brightness_magnitude_pct} min={5} max={50} step={5}
            onChange={v => patch({ brightness_magnitude_pct: v })} />
        </AugRow>

        {/* Contrast */}
        <AugRow
          label="Contrast"
          description="Adjusts contrast range — helps with flat or high-contrast scenes."
          enabled={cfg.contrast_enabled}
          onToggle={v => patch({ contrast_enabled: v })}
        >
          <ParamRow label="Steps" value={cfg.contrast_steps} min={1} max={6}
            onChange={v => patch({ contrast_steps: v })} />
          <ParamRow label="Magnitude %" value={cfg.contrast_magnitude_pct} min={5} max={50} step={5}
            onChange={v => patch({ contrast_magnitude_pct: v })} />
        </AugRow>

        {/* Rotation */}
        <AugRow
          label="Rotation"
          description="Small tilts left and right — handles slight head roll."
          enabled={cfg.rotation_enabled}
          onToggle={v => patch({ rotation_enabled: v })}
        >
          <ParamRow label="Steps" value={cfg.rotation_steps} min={2} max={8}
            onChange={v => patch({ rotation_steps: v })} />
          <ParamRow label="Max angle °" value={cfg.rotation_max_angle_deg} min={5} max={45} step={5}
            onChange={v => patch({ rotation_max_angle_deg: v })} />
        </AugRow>

        {/* Pixel quality */}
        <AugRow
          label="Pixel quality"
          description="Downsamples and upsamples the face to mimic how it looks from a distance."
          enabled={cfg.pixel_quality_enabled}
          onToggle={v => patch({ pixel_quality_enabled: v })}
        >
          <ParamRow label="Steps" value={cfg.pixel_quality_steps} min={1} max={6}
            onChange={v => patch({ pixel_quality_steps: v })} />
          <ParamRow label="Min scale" value={cfg.pixel_quality_min_scale} min={0.2} max={0.9} step={0.1}
            onChange={v => patch({ pixel_quality_min_scale: v })} />
        </AugRow>

        {/* Regenerate */}
        {hasPersons && (
          <div className="flex items-center justify-between pt-2 border-t border-ink-border">
            <span className="font-sans text-[12px] text-fg-3">
              Apply current settings to all enrolled people
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => regenMut.mutate()}
              disabled={regenMut.isPending}
            >
              {regenMut.isPending ? 'Regenerating…' : 'Re-generate embeddings'}
            </Button>
          </div>
        )}
        {regenMut.isSuccess && (
          <p className="font-mono text-[11px] text-fg-3">
            Done — {regenMut.data?.augmented_embeddings_created ?? 0} augmented embeddings created.
          </p>
        )}

        {/* Photo guide */}
        <div className="border-t border-ink-border pt-3">
          <button
            className="flex items-center gap-1.5 font-sans text-[12px] text-fg-3 hover:text-fg-2 transition-colors"
            onClick={() => setGuideOpen(o => !o)}
          >
            {guideOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Photo guide
            {allDisabled && (
              <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.06em] text-dim-red">
                Augmentation off — read this
              </span>
            )}
          </button>
          {guideOpen && (
            <ul className="mt-2 pl-4 flex flex-col gap-1 list-disc marker:text-fg-4">
              <li className="font-sans text-[12px] text-fg-3 leading-relaxed">
                Face centered and unobstructed — no sunglasses, hats, or scarves.
              </li>
              <li className="font-sans text-[12px] text-fg-3 leading-relaxed">
                Upload at least one frontal shot and one slight ¾-angle shot.
              </li>
              <li className="font-sans text-[12px] text-fg-3 leading-relaxed">
                Even, diffuse lighting — avoid strong shadows or bright backlighting.
              </li>
              <li className="font-sans text-[12px] text-fg-3 leading-relaxed">
                Face should fill at least ¼ of the image width.
              </li>
              {allDisabled && (
                <li className="font-sans text-[12px] text-fg-3 leading-relaxed font-semibold">
                  Augmentation is off: also take one photo from the same distance the camera sees the person.
                </li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- sub-components -------------------------------------------------------

function AugRow({
  label,
  description,
  enabled,
  onToggle,
  children,
}: {
  label: string
  description: string
  enabled: boolean
  onToggle: (v: boolean) => void
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="font-sans font-medium text-[13px] text-fg-1">{label}</span>
          <p className="font-sans text-[11px] text-fg-3 mt-0.5 leading-relaxed">{description}</p>
        </div>
        <Toggle value={enabled} onChange={onToggle} />
      </div>
      {enabled && children && (
        <div className="pl-3 border-l border-ink-border flex flex-col gap-2">{children}</div>
      )}
    </div>
  )
}

function ParamRow({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
}) {
  const [local, setLocal] = useState(value)

  // Keep local in sync if parent value changes (e.g. reset to defaults)
  useEffect(() => { setLocal(value) }, [value])

  return (
    <div className="flex items-center gap-3">
      <span className="font-sans text-[11px] text-fg-3 w-28 flex-shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onChange={e => setLocal(Number(e.target.value))}
        onPointerUp={e => onChange(Number((e.target as HTMLInputElement).value))}
        className="flex-1 accent-dim-red"
      />
      <span className="font-mono text-[11px] text-fg-2 w-10 text-right tabular-nums">
        {local}
      </span>
    </div>
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative flex-shrink-0 w-8 h-4 rounded-full transition-colors ${
        value ? 'bg-dim-red' : 'bg-ink-border'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
          value ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}
