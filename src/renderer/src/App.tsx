import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { TaskDetailDrawer } from './components/tasks/TaskDetailDrawer'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Toast } from './components/ui/Toast'
import { Dashboard } from './pages/Dashboard'
import { Tasks } from './pages/Tasks'
import { Analytics } from './pages/Analytics'
import { Adapters } from './pages/Adapters'
import { AdapterSettings } from './pages/Settings'
import { useMonitor } from './store/monitor'

export default function App(): JSX.Element {
  const page = useMonitor((s) => s.page)
  const snapshot = useMonitor((s) => s.snapshot)
  const [booting, setBooting] = useState(true)

  useEffect(() => {
    let disposed = false

    const bootstrap = async (): Promise<void> => {
      const [initial, settings, adapters] = await Promise.all([
        window.monitor.getSnapshot(),
        window.monitor.getSettings(),
        window.monitor.getAdapters()
      ])
      if (disposed) return
      const store = useMonitor.getState()
      if (initial) store.setSnapshot(initial)
      store.setSettings(settings)
      store.setAdapters(adapters)
      setBooting(false)
    }

    void bootstrap()
    const unsubscribe = window.monitor.onSnapshot((next) => {
      useMonitor.getState().setSnapshot(next)
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TitleBar />
        {/* scrollbar-gutter 固定滚动条槽位：侧边栏折叠改变宽度时不会因
            滚动条出现/消失导致换行变化，页面也就不会上下跳动 */}
        <main className="flex-1 overflow-y-auto px-7 pb-10 pt-6 [scrollbar-gutter:stable]">
          <div className="mx-auto w-full max-w-[1440px]">
            {booting && !snapshot ? (
              <div className="flex h-[60vh] items-center justify-center gap-2 text-fg-lo">
                <Loader2 size={16} className="animate-spin" />
                <span className="text-body">正在加载本机采集数据…</span>
              </div>
            ) : (
              <div key={page} className="animate-rise">
                <ErrorBoundary resetKey={page}>
                  {page === 'dashboard' && <Dashboard />}
                  {page === 'tasks' && <Tasks />}
                  {page === 'analytics' && <Analytics />}
                  {page === 'adapters' && <Adapters />}
                  {page === 'settings' && <AdapterSettings />}
                </ErrorBoundary>
              </div>
            )}
          </div>
        </main>
      </div>
      <TaskDetailDrawer />
      <Toast />
    </div>
  )
}
