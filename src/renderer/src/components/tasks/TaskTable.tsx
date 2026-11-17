import type { Currency, TaskSnapshot } from '@shared/types'
import {
  formatDuration,
  formatRate,
  formatTaskCost,
  formatTimeFull,
  turnElapsed,
  formatTimeShort,
  formatTokens,
  formatTokensFull,
  taskSubtitle,
  STATUS_HINT,
  STATUS_LABEL
} from '@shared/format'
import { cn, statusTone, toolName } from '../../lib/utils'
import { StatusDot, ToolAvatar } from '../ui/atoms'

const COLUMNS = [
  { key: 'task', label: '任务', className: 'w-[38%]' },
  { key: 'tool', label: '工具', className: 'w-[128px]' },
  { key: 'start', label: '本轮开始', className: 'w-[112px]' },
  { key: 'duration', label: '本轮耗时', className: 'w-[96px]' },
  { key: 'input', label: '输入', className: 'w-[76px] text-right' },
  { key: 'output', label: '输出', className: 'w-[76px] text-right' },
  { key: 'cache', label: '缓存命中', className: 'w-[96px] text-right' },
  { key: 'cost', label: '费用', className: 'w-[88px] text-right' },
  { key: 'status', label: '状态', className: 'w-[92px] text-right' }
]

export function TaskTable({
  tasks,
  currency,
  fxRate,
  now,
  onOpen
}: {
  tasks: TaskSnapshot[]
  currency: Currency
  fxRate: number
  now: number
  onOpen: (id: string) => void
}): JSX.Element {
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.05]">
      <table className="w-full table-fixed border-collapse text-body">
        <thead>
          <tr className="bg-white/[0.025]">
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                className={cn(
                  'px-3 py-2 text-left text-caption font-medium text-fg-lo whitespace-nowrap',
                  col.className
                )}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tasks.map((task, index) => {
            const live = task.status !== 'ended'
            const elapsed = turnElapsed(task, now)
            const danger = task.alerts.includes('cost_danger')
            return (
              <tr
                key={task.id}
                onClick={() => onOpen(task.id)}
                className={cn(
                  'cursor-pointer border-t border-white/[0.04] transition-colors hover:bg-white/[0.035]',
                  index % 2 === 1 && 'bg-white/[0.012]'
                )}
              >
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <StatusDot tone={statusTone(task.status)} pulse={live && task.status === 'running'} />
                    <div className="min-w-0">
                      <p className="truncate text-fg-hi">{task.title}</p>
                      <p className="truncate text-caption text-fg-lo">
                        {taskSubtitle(task)}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <ToolAvatar tool={task.tool} size="sm" />
                    <span className="truncate text-caption text-fg-mid">{toolName(task.tool)}</span>
                  </div>
                </td>
                <td
                  className="num px-3 py-2.5 text-caption text-fg-mid"
                  title={`会话开始 ${formatTimeFull(task.startedAt)}`}
                >
                  {formatTimeShort(task.turnStartedAt ?? task.startedAt)}
                </td>
                <td className="num px-3 py-2.5 text-caption text-fg-mid">
                  {formatDuration(elapsed)}
                </td>
                <td className="num px-3 py-2.5 text-right text-fg-mid" title={formatTokensFull(task.inputTokens)}>
                  {formatTokens(task.inputTokens)}
                </td>
                <td className="num px-3 py-2.5 text-right text-fg-mid" title={formatTokensFull(task.outputTokens)}>
                  {formatTokens(task.outputTokens)}
                </td>
                <td className="num px-3 py-2.5 text-right text-fg-mid">{formatRate(task.cacheHitRate)}</td>
                <td
                  className={cn(
                    'num px-3 py-2.5 text-right',
                    danger ? 'text-state-danger' : 'text-fg-hi'
                  )}
                >
                  {formatTaskCost(task.costUsd, task.costKnown, currency, fxRate)}
                </td>
                <td className="px-3 py-2.5 text-right">
                   <span
                    title={STATUS_HINT[task.status]}
                    className={cn(
                      'rounded-md whitespace-nowrap px-1.5 py-0.5 text-caption',
                      task.status === 'running'
                        ? 'bg-state-ok/10 text-state-ok'
                        : task.status === 'idle'
                          ? 'bg-state-warn/10 text-state-warn'
                          : 'bg-white/[0.05] text-fg-lo'
                    )}
                  >
                    {STATUS_LABEL[task.status]}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {tasks.length === 0 && (
        <div className="px-4 py-10 text-center text-caption text-fg-lo">没有符合条件的历史任务</div>
      )}
    </div>
  )
}
