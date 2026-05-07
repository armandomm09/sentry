import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { Brushstroke } from '../components/ui/Brushstroke'
import { StatusPill } from '../components/ui/StatusPill'
import type { StreamStatus } from '../types/camera'

export function SystemHealth() {
  const { data: cameras = [], isLoading } = useQuery({
    queryKey: ['cameras'],
    queryFn: () => api.cameras.list(),
    refetchInterval: 5000,
  })

  const total = cameras.length
  const online = cameras.filter(c => c.stream.status === 'live' || c.stream.status === 'recording').length
  const issues = cameras.filter(c => c.stream.status === 'offline' || c.stream.status === 'reconnecting').length

  const stats = [
    { label: 'Total cameras',   value: total,  color: 'text-fg-1' },
    { label: 'Online',          value: online, color: 'text-status-online' },
    { label: 'Issues',          value: issues, color: issues > 0 ? 'text-dim-red' : 'text-fg-3' },
  ]

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 pt-6 pb-4 border-b border-ink-border">
        <h1 className="font-sans font-bold text-[28px] text-fg-1 leading-none tracking-tight">System</h1>
        <div className="h-2 mt-2 w-20 overflow-hidden"><Brushstroke /></div>
      </div>

      <div className="p-6 flex flex-col gap-6">
        {/* Stats row */}
        <div className="grid grid-cols-3 gap-4">
          {stats.map(s => (
            <div key={s.label} className="bg-ink-surface border border-ink-border rounded-r2 p-5 shadow-elev-1">
              <div className={`font-mono font-bold text-[32px] tabular-nums leading-none ${s.color}`}>{s.value}</div>
              <div className="font-sans text-[12px] text-fg-3 mt-2 uppercase tracking-[0.04em]">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Camera table */}
        <div className="bg-ink-surface border border-ink-border rounded-r2 overflow-hidden shadow-elev-1">
          <div className="px-4 py-3 border-b border-ink-border">
            <span className="font-sans text-[11px] text-fg-3 uppercase tracking-[0.04em] font-medium">Stream status</span>
          </div>
          {isLoading ? (
            <div className="px-4 py-8 text-center font-mono text-[11px] text-fg-3">Loading…</div>
          ) : cameras.length === 0 ? (
            <div className="px-4 py-8 text-center font-sans text-[13px] text-fg-3">No cameras configured.</div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-ink-border">
                  {['Name', 'Location', 'Status', 'HLS URL'].map(h => (
                    <th key={h} className="text-left px-4 py-2 font-sans text-[10px] text-fg-4 uppercase tracking-[0.06em] font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cameras.map((c, i) => (
                  <tr key={c.id} className={`border-b border-ink-border last:border-0 ${i % 2 === 1 ? 'bg-ink-darker' : ''}`}>
                    <td className="px-4 py-3 font-sans text-[13px] text-fg-1 font-medium">{c.name}</td>
                    <td className="px-4 py-3 font-sans text-[12px] text-fg-3">{c.location || '—'}</td>
                    <td className="px-4 py-3"><StatusPill status={c.stream.status as StreamStatus} /></td>
                    <td className="px-4 py-3 font-mono text-[11px] text-fg-3 truncate max-w-[200px]">
                      {c.stream.hls_url || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
