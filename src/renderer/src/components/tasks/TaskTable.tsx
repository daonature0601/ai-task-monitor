import type { Currency, TaskSnapshot, TaskSortKey } from '@shared/types'
import {
  computeCacheHitRate,
  formatDuration,
  formatRate,
  formatTaskCost,
  formatTimeFull,
  turnElapsed,
  formatTimeShort,
  formatTokens,
  formatTokensFull,
  STATUS_HINT,
  STATUS_LABEL,
  displayInput
} from '@shared/format'
import { cn, statusTone, toolName } from '../../lib/utils'
import { StatusDot, ToolAvatar } from '../ui/atoms'

const COLUMNS: Array<{ key: TaskSortKey; label: string; className: string; numeric?: boolean }> = [
  { key: 'title', label: '任务', className: 'w-[38%]' },
  { key: 'tool', label: '工具', className: 'w-[128px]' },
  { key: 'start', label: '本轮开始', className: 'w-[112px]' },
  { key: 'duration', label: '本轮耗时', className: 'w-[96px]', numeric: true },
  { key: 'input', label: '输入', className: 'w-[76px] text-right', numeric: true },
  { key: 'output', label: '输出', className: 'w-[76px] text-right', numeric: true },
  { key: 'cache', label: '缓存命中', className: 'w-[96px] text-right', numeric: true },
  { key: 'cost', label: '费用', className: 'w-[88px] text-right', numeric: true },
  { key: 'status', label: '状态', className: 'w-[92px] text-right' }
]

export function TaskTable({
  tasks,
  currency,
  fxRate,
  now,
  onOpen,
  sortBy,
  sortDir,
  onSort
}: {
  tasks: TaskSnapshot[]
  currency: Currency
  fxRate: number
  now: number
  onOpen: (id: string) => void
  sortBy: TaskSortKey
  sortDir: 'asc' | 'desc'
  onSort: (key: TaskSortKey) => void
}): JSX.Element {
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.05]">
      <table className="w-full table-fixed border-collapse text-body">
        <thead>
          <tr className="bg-white/[0.025]">
            {COLUMNS.map((col) => {
              const active = sortBy === col.key
              return (
                <th
                  key={col.key}
                  className={cn(
                    'px-3 py-2 text-left text-caption font-medium whitespace-nowrap',
                    col.className
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSort(col.key)}
                    title={`按「${col.label}」${active && sortDir === 'desc' ? '正序' : '倒序'}排序`}
                    className={cn(
                      'inline-flex items-center gap-1 transition-colors',
                      col.numeric && 'flex-row-reverse',
                      active ? 'text-fg-hi' : 'text-fg-lo hover:text-fg-mid'
                    )}
                  >
                    <span>{col.label}</span>
                    <span className={cn('text-[9px]', active ? 'opacity-100' : 'opacity-0')}>
                      {sortDir === 'asc' ? '▲' : '▼'}
                    </span>
                  </button>
                </th>
              )
            })}
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
                      {/* 项目名可省略，模型名优先展示全（最多占行宽 3/4） */}
                      <p className="flex min-w-0 items-baseline text-caption text-fg-lo">
                        <span className="min-w-0 truncate">{task.project ?? '项目未知'}</span>
                        <span className="mx-1 shrink-0">·</span>
                        <span className="max-w-[75%] shrink-0 truncate">
                          {task.model ?? '模型未知'}
                        </span>
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
                <td className="num px-3 py-2.5 text-right text-fg-mid" title={formatTokensFull(displayInput(task.turnInputTokens, task.turnCacheReadTokens))}>
                  {formatTokens(displayInput(task.turnInputTokens, task.turnCacheReadTokens))}
                </td>
                <td className="num px-3 py-2.5 text-right text-fg-mid" title={formatTokensFull(task.outputTokens)}>
                  {formatTokens(task.turnOutputTokens)}
                </td>
                <td className="num px-3 py-2.5 text-right text-fg-mid">{formatRate(
                computeCacheHitRate({
                  inputTokens: task.turnInputTokens,
                  cacheReadTokens: task.turnCacheReadTokens,
                  cacheWriteTokens: task.turnCacheWriteTokens
                })
              )}</td>
                <td
                  className={cn(
                    'num px-3 py-2.5 text-right',
                    danger ? 'text-state-danger' : 'text-fg-hi'
                  )}
                >
                  {formatTaskCost(task.turnCostUsd, task.costKnown, currency, fxRate)}
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
