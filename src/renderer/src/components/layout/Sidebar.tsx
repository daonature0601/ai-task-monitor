import {
  Activity,
  BarChart3,
  ChevronLeft,
  ListTree,
  Plug,
  Settings2
} from 'lucide-react'
import { useMonitor, type PageId } from '../../store/monitor'
import { cn } from '../../lib/utils'
import { StatusDot } from '../ui/atoms'

const NAV: Array<{ id: PageId; label: string; icon: typeof Activity; hint: string }> = [
  { id: 'dashboard', label: '概览', icon: Activity, hint: '实时任务与今日开销' },
  { id: 'tasks', label: '任务', icon: ListTree, hint: '全部任务与明细' },
  { id: 'analytics', label: '统计', icon: BarChart3, hint: '历史趋势与排行' },
  { id: 'adapters', label: '适配器', icon: Plug, hint: '采集通道与桥接' },
  { id: 'settings', label: '设置', icon: Settings2, hint: '频率、阈值与价目表' }
]

export function Sidebar(): JSX.Element {
  const page = useMonitor((s) => s.page)
  const setPage = useMonitor((s) => s.setPage)
  const collapsed = useMonitor((s) => s.collapsed)
  const toggleCollapsed = useMonitor((s) => s.toggleCollapsed)
  const snapshot = useMonitor((s) => s.snapshot)

  const running = snapshot?.summary.runningCount ?? 0
  const idle = snapshot?.summary.idleCount ?? 0
  const activeCount = running + idle
  const paused = snapshot?.paused ?? false

  return (
    <aside
      className={cn(
        'flex h-full shrink-0 flex-col border-r border-white/[0.05] bg-ink-950/45 backdrop-blur-xl transition-[width] duration-200',
        collapsed ? 'w-[68px]' : 'w-[216px]'
      )}
    >
      {/* macOS 交通灯占位：窗口按钮固定在左上角，这里留出高度与拖拽区避免重叠 */}
      <div className="drag-region h-[48px] shrink-0" />

      <div className="drag-region flex h-9 items-center gap-2.5 px-4">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] bg-gradient-to-br from-accent-cyan to-accent-violet shadow-[0_0_18px_-4px_rgba(34,211,238,0.6)]">
          <Activity size={15} className="text-ink-950" strokeWidth={2.6} />
        </div>
        <div
          className={cn(
            'min-w-0 overflow-hidden transition-opacity duration-150',
            collapsed && 'w-0 opacity-0'
          )}
        >
          <p className="truncate text-[12.5px] font-semibold tracking-tight text-fg-hi">
            AI Task Monitor
          </p>
          <p className="truncate text-[10px] text-fg-lo">本机 AI 用量监控</p>
        </div>
      </div>

      <nav className="mt-4 flex flex-1 flex-col gap-1 px-2.5">
        {NAV.map((item) => {
          const active = page === item.id
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              title={collapsed ? `${item.label} · ${item.hint}` : item.hint}
              onClick={() => setPage(item.id)}
              className={cn(
                // 用 padding 位移代替 justify-center：折叠瞬间按钮仍是全宽，
                // 居中会把图标先甩到中间再滑回来（闪烁）。padding 只会平滑移动 6px。
                'group relative flex h-[34px] items-center gap-2.5 overflow-hidden rounded-[10px] pl-2.5 pr-2.5 text-body',
                'transition-[padding,background-color,color] duration-200 ease-out',
                active
                  ? 'bg-white/[0.07] text-fg-hi'
                  : 'text-fg-mid hover:bg-white/[0.04] hover:text-fg-hi',
                collapsed && 'pl-4 pr-0'
              )}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-accent-cyan shadow-[0_0_10px_rgba(34,211,238,0.8)]" />
              )}
              <Icon size={16} strokeWidth={active ? 2.2 : 1.9} className="shrink-0" />
              <span
                className={cn(
                  'truncate transition-opacity duration-150',
                  collapsed && 'w-0 opacity-0'
                )}
              >
                {item.label}
              </span>
            </button>
          )
        })}
      </nav>

      <div className="space-y-2 px-2.5 pb-3">
        {/* 固定高度 + padding 位移：折叠时文字淡出、圆点平滑居中，不产生跳动 */}
        <div
          className={cn(
            'flex h-[34px] items-center gap-1.5 overflow-hidden rounded-[10px] border border-white/[0.06] bg-white/[0.025] pl-2.5 pr-2.5',
            'transition-[padding] duration-200 ease-out',
            collapsed && 'pl-[20px] pr-0'
          )}
        >
          <StatusDot
            tone={paused ? 'off' : running > 0 ? 'ok' : 'info'}
            pulse={!paused && running > 0}
          />
          <span
            className={cn(
              'truncate text-caption text-fg-mid transition-opacity duration-150',
              collapsed && 'w-0 opacity-0'
            )}
          >
            {paused ? '已暂停' : activeCount > 0 ? `${activeCount} 个任务进行中` : '监听中'}
          </span>
        </div>

        <button
          type="button"
          onClick={toggleCollapsed}
          className={cn(
            'flex h-[28px] w-full items-center gap-2 overflow-hidden rounded-lg pl-2 pr-2 text-caption text-fg-lo',
            'transition-[padding,background-color,color] duration-200 ease-out hover:bg-white/[0.04] hover:text-fg-mid',
            collapsed && 'pl-[18px] pr-0'
          )}
          title={collapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          <ChevronLeft
            size={13}
            className={cn('shrink-0 transition-transform', collapsed && 'rotate-180')}
          />
          <span className={cn('truncate transition-opacity duration-150', collapsed && 'w-0 opacity-0')}>
            收起
          </span>
        </button>
      </div>
    </aside>
  )
}
