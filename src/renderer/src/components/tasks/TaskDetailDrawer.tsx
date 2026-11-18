import { useEffect, useMemo, useState } from 'react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { ChevronDown, Loader2, X } from 'lucide-react'
import type { TaskDetail } from '@shared/types'
import {
  formatCost,
  formatDuration,
  formatRate,
  turnElapsed,
  formatEventTime,
  formatTaskCost,
  formatTimeFull,
  formatTimeShort,
  formatTokens,
  formatTokensFull,
  SOURCE_LABEL,
  STATUS_LABEL,
  computeCacheHitRate
} from '@shared/format'
import { useMonitor } from '../../store/monitor'
import { useNow } from '../../hooks/useTicker'
import { cn, statusTone } from '../../lib/utils'
import { Badge, StatusDot, ToolAvatar } from '../ui/atoms'

export function TaskDetailDrawer(): JSX.Element | null {
  const taskId = useMonitor((s) => s.drawerTaskId)
  const close = useMonitor((s) => s.closeDrawer)
  const snapshot = useMonitor((s) => s.snapshot)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  const currency = snapshot?.currency ?? 'USD'
  const fxRate = snapshot?.fxRate ?? 7.2
  const now = useNow(Boolean(taskId))

  useEffect(() => {
    if (!taskId) {
      setDetail(null)
      return
    }
    let disposed = false
    setLoading(true)
    window.monitor
      .getTaskDetail(taskId)
      .then((result) => {
        if (!disposed) setDetail(result)
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [taskId])

  // 快照更新时同步刷新打开中的任务指标（保持逐秒跳动）
  const liveTask = useMemo(() => {
    if (!taskId || !snapshot) return null
    return snapshot.tasks.find((t) => t.id === taskId) ?? null
  }, [taskId, snapshot])

  const task = liveTask ?? detail?.task ?? null

  const series = useMemo(() => {
    const events = detail?.events ?? []
    const sorted = [...events].sort((a, b) => a.ts - b.ts)
    let cost = 0
    let tokens = 0
    return sorted.map((event) => {
      cost += event.costUsd
      tokens +=
        event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens
      return {
        time: new Date(event.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        cost: Number(cost.toFixed(5)),
        tokens
      }
    })
  }, [detail])

  if (!taskId) return null

  // 时间口径：展示当次问答，而不是整段会话
  const elapsed = task ? turnElapsed(task, now) : 0

  const totalTokens = task
    ? task.inputTokens + task.outputTokens + task.cacheReadTokens + task.cacheWriteTokens
    : 0

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="关闭详情"
        onClick={close}
        className="absolute inset-0 bg-ink-950/55 backdrop-blur-[2px]"
      />
      <aside className="relative flex h-full w-[480px] flex-col border-l border-white/[0.07] bg-ink-850/95 shadow-[-24px_0_60px_-30px_rgba(0,0,0,0.9)] backdrop-blur-2xl animate-rise">
        <header className="flex items-start justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <ToolAvatar tool={task?.tool ?? 'codex'} size="lg" active={task?.status === 'running'} />
            <div className="min-w-0">
              <p className="truncate text-title font-semibold text-fg-hi">
                {task?.title ?? '加载中…'}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {task && (
                  <>
                    <span className="flex items-center gap-1 text-caption text-fg-mid">
                      <StatusDot tone={statusTone(task.status)} pulse={task.status === 'running'} />
                      {STATUS_LABEL[task.status]}
                    </span>
                    <Badge tone={task.tokensSource === 'native' ? 'ok' : task.tokensSource === 'bridge' ? 'cyan' : 'neutral'}>
                      {SOURCE_LABEL[task.tokensSource]}
                    </Badge>
                    <span className="num text-caption text-fg-lo">会话 {task.externalSessionId.slice(0, 8)}</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            className="rounded-lg p-1.5 text-fg-lo transition-colors hover:bg-white/[0.06] hover:text-fg-hi"
          >
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && !task ? (
            <div className="flex items-center justify-center gap-2 py-16 text-fg-lo">
              <Loader2 size={14} className="animate-spin" />
              <span className="text-caption">读取任务明细…</span>
            </div>
          ) : task ? (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-2">
                <Metric
                  label="项目"
                  value={task.project ?? '—'}
                  hint={task.workspace ?? undefined}
                />
                <Metric label="本轮开始" value={formatTimeFull(task.turnStartedAt ?? task.startedAt)} mono />
                <Metric
                  label="本轮耗时"
                  value={formatDuration(elapsed)}
                  mono
                  hint={task.status === 'ended' ? '本轮回复已结束' : undefined}
                />
                <Metric label="模型" value={task.model ?? '—'} hint="数据源未提供模型时不计价" />
                <Metric label="事件数" value={String(task.eventCount)} mono />
              </div>

              <div>
                <p className="label-xs mb-2">本轮</p>
                <div className="grid grid-cols-2 gap-2">
                  <Metric label="输入 Token" value={formatTokensFull(task.turnInputTokens)} mono />
                  <Metric label="输出 Token" value={formatTokensFull(task.turnOutputTokens)} mono />
                  <Metric
                    label="缓存命中"
                    value={formatRate(
                      computeCacheHitRate({
                        inputTokens: task.turnInputTokens,
                        cacheReadTokens: task.turnCacheReadTokens,
                        cacheWriteTokens: task.turnCacheWriteTokens
                      })
                    )}
                    mono
                  />
                  <Metric
                    label="本轮费用"
                    value={formatTaskCost(task.turnCostUsd, task.costKnown, currency, fxRate)}
                    mono
                  />
                </div>
              </div>

              <div>
                <p className="label-xs mb-2">会话累计</p>
                <div className="grid grid-cols-2 gap-2">
                  <Metric label="输入 Token" value={formatTokensFull(task.inputTokens)} mono />
                  <Metric label="输出 Token" value={formatTokensFull(task.outputTokens)} mono />
                  <Metric label="缓存命中" value={formatRate(task.cacheHitRate)} mono />
                <Metric
                  label="会话费用"
                  value={formatTaskCost(task.costUsd, task.costKnown, currency, fxRate)}
                  mono
                  tone={task.alerts.includes('cost_danger') ? 'danger' : 'default'}
                  hint={
                    task.costKnown
                      ? undefined
                      : task.tokensSource === 'partial'
                        ? '上下文占用量不计价'
                        : task.tokensSource === 'unavailable'
                          ? task.tool === 'codebuddy' || task.tool === 'workbuddy'
                            ? '该工具本地只有会话心跳，token 用量在服务端'
                            : '该采集通道不提供 token 用量'
                          : '模型单价待确认'
                  }
                />
                </div>
              </div>

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <p className="label-xs">Token 构成</p>
                  <span className="num text-caption text-fg-lo">{formatTokens(totalTokens)} 总计</span>
                </div>
                <TokenBar task={task} />
              </section>

              <section>
                <p className="label-xs mb-2">费用累积曲线</p>
                <div className="h-[132px] rounded-xl border border-white/[0.05] bg-ink-950/40 p-2">
                  {series.length > 1 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={series} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
                        <defs>
                          <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#22D3EE" stopOpacity={0.35} />
                            <stop offset="100%" stopColor="#22D3EE" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <XAxis dataKey="time" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={46} />
                        <Tooltip
                          contentStyle={{
                            background: '#111721',
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: 10,
                            fontSize: 12
                          }}
                          formatter={(value: number) => [formatCost(value, currency, fxRate), '累计费用']}
                        />
                        <Area
                          type="monotone"
                          dataKey="cost"
                          stroke="#22D3EE"
                          strokeWidth={1.6}
                          fill="url(#costFill)"
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="flex h-full items-center justify-center text-caption text-fg-lo">
                      暂无足够的用量事件绘制曲线
                    </div>
                  )}
                </div>
              </section>

              <section>
                <p className="label-xs mb-2">轮次（{(detail?.turns ?? []).length} 轮）</p>
                <div className="space-y-1">
                  {(detail?.turns ?? []).length === 0 ? (
                    <p className="text-caption text-fg-lo">暂无轮次数据</p>
                  ) : (
                    (detail?.turns ?? []).map((turn, index) => (
                      <div
                        key={turn.id}
                        className="flex items-center justify-between rounded-md bg-white/[0.02] px-2 py-1.5 text-caption"
                      >
                        <span className="num text-fg-mid">
                          #{(detail?.turns ?? []).length - index} · {formatTimeShort(turn.startedAt)}
                        </span>
                        <span className="num text-fg-lo">
                          {formatDuration((turn.endedAt ?? turn.startedAt) - turn.startedAt)}
                        </span>
                        <span className="num text-fg-mid">
                          {formatTokens(turn.inputTokens)} in / {formatTokens(turn.outputTokens)} out
                        </span>
                        <span className="num text-fg-lo">
                          {formatRate(
                            computeCacheHitRate({
                              inputTokens: turn.inputTokens,
                              cacheReadTokens: turn.cacheReadTokens
                            })
                          )}
                        </span>
                        <span className="num text-fg-hi">
                          {formatTaskCost(turn.costUsd, task.costKnown, currency, fxRate)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section>
                <div className="space-y-1.5">
                  {(detail?.events ?? []).slice(0, 0).map((event) => (
                    <div
                      key={event.id}
                      className="flex items-center justify-between rounded-lg border border-white/[0.045] bg-white/[0.02] px-2.5 py-1.5"
                    >
                      <span className="num text-caption text-fg-lo">
                        {formatEventTime(event.ts)}
                      </span>
                      <span className="num text-caption text-fg-mid">
                        in {formatTokens(event.inputTokens)} · out {formatTokens(event.outputTokens)} · cache{' '}
                        {formatTokens(event.cacheReadTokens)}
                      </span>
                      <span className="num text-caption text-fg-hi">
                        {formatCost(event.costUsd, currency, fxRate)}
                      </span>
                    </div>
                  ))}
                  {false && (
                    <p className="rounded-lg border border-dashed border-white/[0.07] px-3 py-4 text-center text-caption text-fg-lo">
                      该任务暂无落库的用量事件
                    </p>
                  )}
                </div>
              </section>

              <section>
                <button
                  type="button"
                  onClick={() => setShowRaw((v) => !v)}
                  className="flex w-full items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2 text-caption text-fg-mid transition-colors hover:bg-white/[0.03]"
                >
                  原始字段
                  <ChevronDown size={14} className={cn('transition-transform', showRaw && 'rotate-180')} />
                </button>
                {showRaw && (
                  <pre className="num mt-2 overflow-x-auto rounded-lg border border-white/[0.05] bg-ink-950/70 p-3 text-[11px] leading-5 text-fg-mid">
{JSON.stringify(
  {
    id: task.id,
    tool: task.tool,
    sessionId: task.externalSessionId,
    model: task.model,
    workspace: task.workspace,
    turnStartedAt: formatTimeFull(task.turnStartedAt ?? task.startedAt),
    turnEndedAt: task.turnEndedAt ? formatTimeFull(task.turnEndedAt) : null,
    turnElapsedSec: Math.round(elapsed / 1000),
    startedAt: formatTimeFull(task.startedAt),
    lastEventAt: formatTimeFull(task.lastEventAt),
    tokens: {
      input: task.inputTokens,
      output: task.outputTokens,
      cacheRead: task.cacheReadTokens,
      cacheWrite: task.cacheWriteTokens,
      reasoning: task.reasoningTokens
    },
    costUsd: Number(task.costUsd.toFixed(6)),
    tokensSource: task.tokensSource,
    alerts: task.alerts
  },
  null,
  2
)}
                  </pre>
                )}
              </section>
            </div>
          ) : (
            <p className="py-16 text-center text-caption text-fg-lo">该任务已不存在（可能超过保留期）</p>
          )}
        </div>
      </aside>
    </div>
  )
}

function Metric({
  label,
  value,
  mono,
  hint,
  tone = 'default'
}: {
  label: string
  value: string
  mono?: boolean
  hint?: string
  tone?: 'default' | 'danger'
}): JSX.Element {
  return (
    <div className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-2">
      <p className="text-[10px] text-fg-lo">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-[13px] font-medium text-fg-hi',
          mono && 'num',
          tone === 'danger' && 'text-state-danger'
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[10px] text-fg-lo">{hint}</p> : null}
    </div>
  )
}

function TokenBar({ task }: { task: TaskDetail['task'] }): JSX.Element {
  const segments = [
    { label: '缓存读', value: task.cacheReadTokens, color: '#7C6BFF' },
    { label: '缓存写', value: task.cacheWriteTokens, color: '#60A5FA' },
    { label: '新增输入', value: task.inputTokens, color: '#22D3EE' },
    { label: '输出', value: task.outputTokens, color: '#2DD4BF' }
  ]
  const total = segments.reduce((sum, seg) => sum + seg.value, 0)

  return (
    <div className="space-y-2">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-white/[0.05]">
        {total > 0 ? (
          segments.map((seg) => (
            <span
              key={seg.label}
              style={{ width: `${(seg.value / total) * 100}%`, background: seg.color }}
              title={`${seg.label} ${formatTokensFull(seg.value)}`}
            />
          ))
        ) : (
          <span className="w-full bg-white/[0.04]" />
        )}
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: seg.color }} />
            <span className="truncate text-[10px] text-fg-lo">{seg.label}</span>
            <span className="num ml-auto text-[10px] text-fg-mid">{formatTokens(seg.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
