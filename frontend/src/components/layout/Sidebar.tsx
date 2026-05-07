import { Activity, Bell, LayoutGrid, Settings2, Video } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { Brushstroke } from '../ui/Brushstroke'

const nav = [
  { to: '/',        icon: LayoutGrid, label: 'Cameras' },
  { to: '/health',  icon: Activity,   label: 'System' },
  { to: '/alerts',  icon: Bell,       label: 'Alerts' },
  { to: '/settings',icon: Settings2,  label: 'Settings' },
]

export function Sidebar() {
  return (
    <aside className="w-[200px] flex-shrink-0 bg-ink-dark border-r border-ink-border flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-ink-border">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-dim-red rounded-r1 flex items-center justify-center flex-shrink-0">
            <Video size={15} strokeWidth={2} className="text-white" />
          </div>
          <div>
            <div className="font-sans font-extrabold text-[15px] leading-none text-fg-1 tracking-tight">
              Sentry
            </div>
            <div className="font-mono text-[10px] text-fg-4 mt-0.5 tracking-[0.04em] uppercase">by DIM</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 flex flex-col gap-0.5">
        {nav.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `group flex items-center gap-2.5 px-3 h-9 rounded-r1 transition-all duration-[120ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] text-[13px] font-medium relative ${
                isActive
                  ? 'bg-ink-surface text-fg-1'
                  : 'text-fg-3 hover:bg-ink-surface hover:text-fg-2'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon size={16} strokeWidth={1.75} className={isActive ? 'text-dim-red' : ''} />
                {label}
                {isActive && (
                  <span className="absolute bottom-0 left-3 right-3 h-[3px] overflow-hidden">
                    <Brushstroke />
                  </span>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-ink-border">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-ink-raised border border-ink-border flex items-center justify-center">
            <Settings2 size={12} strokeWidth={1.75} className="text-fg-3" />
          </div>
          <span className="font-mono text-[10px] text-fg-4 uppercase tracking-[0.04em]">v0.1.0</span>
        </div>
      </div>
    </aside>
  )
}
