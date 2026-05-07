/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // DIM brand
        'dim-red':       '#e83a29',
        'dim-red-hover': '#ff4d3a',
        'dim-red-press': '#c4301f',
        // Surfaces
        'ink-deeper':  '#1a1718',
        'ink-dark':    '#231f20',
        'ink-surface': '#2a2627',
        'ink-raised':  '#332e2f',
        'ink-border':  '#3a3536',
        'ink-border-strong': '#4a4445',
        // Foreground
        'fg-1': '#f5f2f0',
        'fg-2': '#c4bdbb',
        'fg-3': '#8a8281',
        'fg-4': '#5a5354',
        // Status
        'status-online':  '#38d977',
        'status-warn':    '#f5a623',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
      },
      borderRadius: {
        'r1': '4px',
        'r2': '6px',
        'r3': '8px',
        'r4': '12px',
      },
      boxShadow: {
        'elev-1': '0 1px 0 rgba(255,255,255,0.025) inset, 0 2px 6px rgba(0,0,0,0.25), 0 4px 14px rgba(0,0,0,0.18)',
        'elev-2': '0 1px 0 rgba(255,255,255,0.03) inset, 0 4px 14px rgba(0,0,0,0.30), 0 12px 36px rgba(0,0,0,0.24)',
        'elev-3': '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.38), 0 24px 64px rgba(0,0,0,0.32)',
        'elev-rec': '0 0 0 1px rgba(232,58,41,0.35), 0 0 14px 2px rgba(232,58,41,0.30), 0 0 36px 8px rgba(232,58,41,0.18)',
      },
      animation: {
        'rec-pulse': 'rec-pulse 1.6s ease-in-out infinite',
        'sweep': 'sweep 1.8s linear infinite',
      },
      keyframes: {
        'rec-pulse': {
          '0%, 100%': { opacity: '0.35', transform: 'scale(0.85)' },
          '50%': { opacity: '0.05', transform: 'scale(1.15)' },
        },
        'sweep': {
          '0%': { left: '-60%' },
          '100%': { left: '100%' },
        },
      },
      transitionDuration: {
        fast: '120ms',
        base: '200ms',
        slow: '320ms',
      },
      transitionTimingFunction: {
        'ease-out-custom': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
    },
  },
  plugins: [],
}
