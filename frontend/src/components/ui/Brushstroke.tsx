interface Props {
  className?: string
  opacity?: number
}

export function Brushstroke({ className = '', opacity = 1 }: Props) {
  return (
    <svg
      viewBox="0 0 800 60"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={`w-full h-full block ${className}`}
      style={{ color: '#e83a29', opacity }}
    >
      <defs>
        <linearGradient id="b-edge" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0"    stopColor="currentColor" stopOpacity="0" />
          <stop offset="0.04" stopColor="currentColor" stopOpacity="0.85" />
          <stop offset="0.5"  stopColor="currentColor" stopOpacity="1" />
          <stop offset="0.96" stopColor="currentColor" stopOpacity="0.85" />
          <stop offset="1"    stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d="M 12 38 C 90 16, 220 8, 360 6 C 500 4, 640 12, 770 24 C 720 31, 600 33, 460 32 C 320 31, 180 33, 30 44 Z"
        fill="url(#b-edge)"
      />
      <path
        d="M 80 28 C 200 18, 380 14, 560 18 C 620 19, 680 21, 720 23 C 660 25, 540 26, 400 25 C 260 24, 140 26, 80 30 Z"
        fill="currentColor"
        opacity="0.18"
      />
    </svg>
  )
}
