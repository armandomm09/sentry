import type { StreamStatus } from '../../types/camera'

interface Props {
  status: StreamStatus
  size?: 'sm' | 'md'
}

const config: Record<StreamStatus, { label: string; dot: string; pill: string }> = {
  live: {
    label: 'Live',
    dot: 'bg-status-online shadow-[0_0_0_3px_rgba(56,217,119,0.18)]',
    pill: 'bg-[rgba(56,217,119,0.14)] text-[#5fe89a]',
  },
  recording: {
    label: 'Rec',
    dot: 'bg-white animate-[pulse_1.6s_ease-in-out_infinite]',
    pill: 'bg-dim-red text-white',
  },
  reconnecting: {
    label: 'Reconnecting',
    dot: 'bg-status-warn',
    pill: 'bg-[rgba(245,166,35,0.14)] text-[#f5a623]',
  },
  offline: {
    label: 'Offline',
    dot: 'bg-fg-3',
    pill: 'bg-ink-surface text-fg-3 border border-ink-border',
  },
}

export function StatusPill({ status, size = 'sm' }: Props) {
  const { label, dot, pill } = config[status] ?? config.offline
  const h = size === 'sm' ? 'h-5 px-2 text-[9px]' : 'h-6 px-2.5 text-[10px]'

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-r1 font-sans font-semibold tracking-[0.06em] uppercase ${h} ${pill}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
      {label}
    </span>
  )
}
