import { useEffect } from 'react'
import { AlertTriangle, CheckCircle2, X } from 'lucide-react'
import { useMonitor } from '../../store/monitor'
import { cn } from '../../lib/utils'

export function Toast(): JSX.Element | null {
  const toast = useMonitor((s) => s.toast)
  const dismiss = useMonitor((s) => s.dismissToast)

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => dismiss(), 2600)
    return () => window.clearTimeout(timer)
  }, [toast, dismiss])

  if (!toast) return null

  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 animate-rise">
      <div
        className={cn(
          'pointer-events-auto flex items-center gap-2 rounded-xl border px-3.5 py-2 text-body shadow-glass backdrop-blur-xl',
          toast.tone === 'danger'
            ? 'border-state-danger/30 bg-state-danger/10 text-state-danger'
            : toast.tone === 'warn'
              ? 'border-state-warn/30 bg-state-warn/10 text-state-warn'
              : 'border-accent-cyan/30 bg-ink-800/90 text-accent-cyan'
        )}
      >
        {toast.tone === 'ok' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
        <span className="text-fg-hi">{toast.text}</span>
        <button
          type="button"
          onClick={dismiss}
          className="ml-1 rounded p-0.5 text-fg-lo transition-colors hover:text-fg-hi"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  )
}
