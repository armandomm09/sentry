import * as Icons from 'lucide-react'
import type { ButtonHTMLAttributes, ComponentType } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: string
  iconRight?: boolean
}

const variantStyles: Record<Variant, string> = {
  primary:   'bg-dim-red text-white hover:bg-dim-red-hover active:bg-dim-red-press active:translate-y-px',
  secondary: 'bg-ink-surface text-fg-1 border border-ink-border hover:bg-ink-raised',
  ghost:     'bg-transparent text-fg-2 hover:bg-ink-surface hover:text-fg-1',
  danger:    'bg-transparent text-dim-red border border-ink-border hover:bg-[rgba(232,58,41,0.12)] hover:border-dim-red',
}

const sizeStyles: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-[13px] gap-2',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight = false,
  children,
  className = '',
  ...rest
}: Props) {
  const IconComponent = icon
    ? ((Icons as unknown as Record<string, ComponentType<{ size?: number; strokeWidth?: number }>>)[toPascal(icon)] ?? null)
    : null

  return (
    <button
      className={`inline-flex items-center rounded-r1 font-sans font-semibold transition-all duration-[120ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] cursor-pointer select-none ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...rest}
    >
      {IconComponent && !iconRight && <IconComponent size={size === 'sm' ? 13 : 15} strokeWidth={1.75} />}
      {children}
      {IconComponent && iconRight && <IconComponent size={size === 'sm' ? 13 : 15} strokeWidth={1.75} />}
    </button>
  )
}

function toPascal(s: string) {
  return s
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}
