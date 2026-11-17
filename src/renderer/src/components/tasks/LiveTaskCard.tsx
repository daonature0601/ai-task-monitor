import { ArrowUpRight, Clock3, Coins, Hash } from 'lucide-react'
import type { Currency, TaskSnapshot } from '@shared/types'
import {
  formatDuration,
  formatRate,
  formatTaskCost,
  formatTimeShort,
  turnElapsed,
  formatTokens,
  STATUS_HINT,
  STATUS_LABEL
} from '@shared/format'
import { cn, statusTone } from '../../lib/utils'
import { Badge, StatusDot, ToolAvatar } from '../ui/atoms'

export function LiveTaskCard({
  task,
  now,
  currency,
  fxRate,
  onOpen
}: {
  task: TaskSnapshot
  now: number
  currency: Currency
  fxRate: number
  onOpen: (id: string) => void
}): JSX.Element {
  const running = task.status === 'running'
  // 展示「当次问答」的时长与开始时间，而不是整段会话
  const elapsed = turnElapsed(task, now)
  const danger = task.alerts.includes('cost_danger') || task.alerts.includes('duration_danger')
  const warn = task.alerts.includes('cost_warn') || task.alerts.includes('duration_warn')

  return (
    <button
      type="button"
      onClick={() => onOpen(task.id)}
      className={cn(
        'group relative w-full overflow-hidden rounded-2xl border p-4 text-left transition-all duration-200',
        'bg-ink-800/50 backdrop-blur-xl hover:bg-ink-750/70',
        danger
          ? 'border-state-danger/35 shadow-[0_0_28px_-18px_rgba(248,113,113,0.7)]'
          : warn
            ? 'border-state-warn/30'
            : 'border-white/[0.06] hover:border-white/[0.13]'
      )}
    >
      {running && (
        <span className="absolute inset-x-0 top-0 h-[2px] overflow-hidden">
          <span className="block h-full w-1/3 animate-breathe bg-gradient-to-r from-transparent via-accent-cyan/70 to-transparent" />
        </span>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <ToolAvatar tool={task.tool} active={running} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-body font-medium text-fg-hi">{task.title}</p>
              <span title={STATUS_HINT[task.status]} className="flex shrink-0 items-center gap-1">
                <StatusDot tone={statusTone(task.status)} pulse={running} />
                <span
                  className={cn(
                    'text-[10px]',
                    running ? 'text-state-ok' : 'text-state-warn'
                  )}
                >
                  {STATUS_LABEL[task.status]}
                </span>
              </span>
            </div>
            <p className="mt-0.5 truncate text-caption text-fg-lo">
              {task.project ? <span className="text-fg-mid">{task.project}</span> : '项目未知'}
              <span className="mx-1.5 text-fg-lo/50">·</span>
              {task.model ?? '模型未上报'}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 text-caption text-fg-lo">
          <Clock3 size={11} />
          <span className="num text-fg-mid">{formatDuration(elapsed)}</span>
          <ArrowUpRight
            size={13}
            className="ml-0.5 opacity-0 transition-opacity group-hover:opacity-100"
          />
        </div>
      </div>

      <div className="mt-3.5 grid grid-cols-4 gap-2">
        <Stat icon={<Hash size={10} />} label="输入" value={formatTokens(task.inputTokens)} accent="text-accent-cyan" />
        <Stat label="输出" value={formatTokens(task.outputTokens)} accent="text-accent-teal" />
        <Stat
          label="缓存命中"
          value={formatRate(task.cacheHitRate)}
          accent={
            task.alerts.includes('cache_low') ? 'text-state-warn' : 'text-accent-violet'
          }
        />
        <Stat
          icon={<Coins size={10} />}
          label="费用"
          value={formatTaskCost(task.costUsd, task.costKnown, currency, fxRate)}
          accent={danger ? 'text-state-danger' : warn ? 'text-state-warn' : 'text-fg-hi'}
        />
      </div>

      <div className="mt-3 flex items-center justify-between text-caption text-fg-lo">
        <span className="num">本轮开始 {formatTimeShort(task.turnStartedAt ?? task.startedAt)}</span>
        <div className="flex items-center gap-1.5">
          {task.tokensSource !== 'native' && (
            <Badge tone={task.tokensSource === 'unavailable' ? 'neutral' : 'warn'}>
              {task.tokensSource === 'bridge'
                ? '桥接上报'
                : task.tokensSource === 'partial'
                  ? '部分字段'
                  : '无 token 数据'}
            </Badge>
          )}
          <span className="num">{task.eventCount} 次事件</span>
        </div>
      </div>
    </button>
  )
}

function Stat({
  label,
  value,
  accent,
  icon
}: {
  label: string
  value: string
  accent: string
  icon?: JSX.Element
}): JSX.Element {
  return (
    <div className="rounded-lg border border-white/[0.05] bg-ink-950/40 px-2 py-1.5">
      <p className="flex items-center gap-1 text-[10px] text-fg-lo">
        {icon}
        {label}
      </p>
      <p className={cn('num mt-0.5 text-[13px] font-medium leading-4', accent)}>{value}</p>
    </div>
  )
}
