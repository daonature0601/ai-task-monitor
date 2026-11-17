import { useState } from 'react'
import { CirclePause, CirclePlay, RefreshCw } from 'lucide-react'
import type { Currency } from '@shared/types'
import { useMonitor } from '../../store/monitor'
import { cn } from '../../lib/utils'
import { StatusDot } from '../ui/atoms'

const PAGE_META: Record<string, { title: string; hint: string }> = {
  dashboard: { title: '概览', hint: '实时任务、今日开销与工具分布' },
  tasks: { title: '任务', hint: '按工具、状态与时间筛选历史任务' },
  analytics: { title: '历史统计', hint: '费用趋势、缓存效率与 Top 消耗排行' },
  adapters: { title: '适配器', hint: '七个采集通道的状态、能力与桥接配置' },
  settings: { title: '设置', hint: '刷新频率、告警阈值、币种与价目表' }
}

export function TitleBar(): JSX.Element {
  const page = useMonitor((s) => s.page)
  const snapshot = useMonitor((s) => s.snapshot)
  const setSettings = useMonitor((s) => s.setSettings)
  const notify = useMonitor((s) => s.notify)
  const [busy, setBusy] = useState(false)

  const meta = PAGE_META[page] ?? PAGE_META.dashboard
  const currency: Currency = snapshot?.currency ?? 'USD'
  const paused = snapshot?.paused ?? false
  const running = snapshot?.summary.runningCount ?? 0
  const idle = snapshot?.summary.idleCount ?? 0
  const activeCount = running + idle

  const switchCurrency = async (next: Currency): Promise<void> => {
    if (next === currency) return
    const updated = await window.monitor.updateSettings({ currency: next })
    setSettings(updated)
    notify(`已切换为${next === 'USD' ? '美元 $' : '人民币 ¥'}`)
  }

  const togglePause = async (): Promise<void> => {
    setBusy(true)
    const updated = await window.monitor.togglePause()
    setSettings(updated)
    notify(updated.paused ? '已暂停采集' : '已恢复采集', updated.paused ? 'warn' : 'ok')
    setBusy(false)
  }

  const rescan = async (): Promise<void> => {
    setBusy(true)
    const adapters = await window.monitor.rescanAdapters()
    useMonitor.getState().setAdapters(adapters)
    notify('已重新扫描本地数据源')
    setBusy(false)
  }

  return (
    <header className="drag-region flex h-[52px] shrink-0 items-center justify-between border-b border-white/[0.05] px-7">
      <div className="flex items-baseline gap-3">
        <h1 className="text-title font-semibold tracking-tight text-fg-hi">{meta.title}</h1>
        <span className="hidden text-caption text-fg-lo md:inline">{meta.hint}</span>
      </div>

      <div className="no-drag flex items-center gap-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.03] px-2 py-1">
          <StatusDot tone={paused ? 'off' : running > 0 ? 'ok' : 'info'} pulse={!paused && running > 0} />
          <span className="num text-caption text-fg-mid">
            {paused ? '暂停' : activeCount > 0 ? `${activeCount} 进行中` : '监听中'}
          </span>
        </div>

        <div className="flex rounded-lg border border-white/[0.07] bg-white/[0.03] p-0.5">
          {(['USD', 'CNY'] as Currency[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => void switchCurrency(item)}
              className={cn(
                'rounded-md px-2 py-0.5 text-caption transition-colors',
                currency === item
                  ? 'bg-white/[0.09] text-fg-hi'
                  : 'text-fg-lo hover:text-fg-mid'
              )}
            >
              {item === 'USD' ? '$ USD' : '¥ CNY'}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => void rescan()}
          disabled={busy}
          className="btn h-[28px] px-2"
          title="重新扫描数据源"
        >
          <RefreshCw size={13} className={cn(busy && 'animate-spin')} />
        </button>

        <button
          type="button"
          onClick={() => void togglePause()}
          disabled={busy}
          className={cn('btn h-[28px] px-2.5', paused && 'btn-primary')}
          title={paused ? '恢复采集' : '暂停采集'}
        >
          {paused ? <CirclePlay size={13} /> : <CirclePause size={13} />}
          <span className="text-caption">{paused ? '恢复' : '暂停'}</span>
        </button>
      </div>
    </header>
  )
}
