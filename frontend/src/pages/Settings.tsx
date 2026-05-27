import { Brushstroke } from '../components/ui/Brushstroke'
import { FaceRecognitionSection } from '../components/settings/FaceRecognitionSection'

export function Settings() {
  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="px-6 pt-6 pb-4 border-b border-ink-border">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="font-sans font-bold text-[28px] text-fg-1 leading-none tracking-tight">
              Settings
            </h1>
            <div className="h-2 mt-2 w-24 overflow-hidden">
              <Brushstroke />
            </div>
          </div>
          <div className="font-mono text-[11px] text-fg-3 tabular-nums pb-1 uppercase tracking-[0.06em]">
            Sentry configuration
          </div>
        </div>
      </div>

      {/* Sections (stacked — add more here as the feature set grows) */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-[1080px] mx-auto px-6 py-6 flex flex-col gap-8">
          <FaceRecognitionSection />
        </div>
      </div>
    </div>
  )
}
