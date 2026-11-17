import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, Inbox, Sparkles } from 'lucide-react'
import type { StatsPayload } from '@shared/types'
import { formatCost, formatRate, formatRelative, formatTokens } from '@shared/format'
import { useMonitor } from '../store/monitor'
import { useNow } from '../hooks/useTicker'
import { Card, EmptyState, Metric, SectionTitle, StatusDot } from '../components/ui/atoms'
import { LiveTaskCard } from '../components/tasks/LiveTaskCard'
import { CostTrend, ToolDistribution } from '../components/charts'
import { toolName } from '../lib/utils'

export function Dashboard(): JSX.Element {
  const snapshot = useMonitor((s) => s.snapshot)
  const openDrawer = useMonitor((s) => s.openDrawer)
  const [stats, setStats] = useState<StatsPayload | null>(null)
  const [todayStats, setTodayStats] = useState<StatsPayload | null>(null)

  const currency = snapshot?.currency ?? 'USD'
  const fxRate = snapshot?.fxRate ?? 7.2
  // 「实时任务」= 进行中（运行中 + 静默），与指标卡口径完全一致。
  // 静默任务在卡片上有独立的状态文字（静默），不会与运行中混淆。
  const liveTasks = useMemo(
    () => (snapshot?.tasks ?? []).filter((task) => task.status !== 'ended'),
    [snapshot]
  )
  const idleCount = snapshot?.summary.idleCount ?? 0
  const now = useNow(liveTasks.some((task) => task.status === 'running'))
  const todayTasks = snapshot?.summary.todayTasks ?? 0
  const hasCost = (snapshot?.summary.todayCostUsd ?? 0) > 0

  useEffect(() => {
    let disposed = false
    const load = (): void => {
      const to = Date.now()
      const dayStart = new Date(to)
      dayStart.setHours(0, 0, 0, 0)
      // 两个区间分别取：近 7 天用于趋势图，今日用于指标卡，
      // 指标卡不再用内存快照，避免与统计页口径不一致。
      window.monitor
        .getStats(to - 7 * 86_400_000, to)
        .then((result) => {
          if (!disposed) setStats(result)
        })
        .catch((error: unknown) => console.error('[dashboard] stats failed', error))
      window.monitor
        .getStats(dayStart.getTime(), to)
        .then((result) => {
          if (!disposed) setTodayStats(result)
        })
        .catch((error: unknown) => console.error('[dashboard] today stats failed', error))
    }
    load()
    // 首次快照到达时数据库可能刚完成首批写入，补一次延迟加载
    const retry = window.setTimeout(load, 2_500)
    const timer = window.setInterval(load, 10_000)
    return () => {
      disposed = true
      window.clearTimeout(retry)
      window.clearInterval(timer)
    }
  }, [todayTasks, hasCost])

  const summary = snapshot?.summary
  // 今日指标以数据库为准（按用量事件时间归集），与统计页完全同源
  const today = todayStats?.totals
  const dailyTotals = (stats?.daily ?? []).map((point) => point.total)
  const totalTokens = (today?.todayInputTokens ?? 0) + (today?.todayOutputTokens ?? 0)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric
          label="进行中任务"
          value={String((summary?.runningCount ?? 0) + (summary?.idleCount ?? 0))}
          hint={
            <span className="flex items-center gap-2">
              <span>运行中 {summary?.runningCount ?? 0}</span>
              <span className="text-fg-lo/50">·</span>
              <span>静默 {summary?.idleCount ?? 0}</span>
              <span className="text-fg-lo/50">·</span>
              <span className="num">今日共 {today?.todayTasks ?? 0} 个</span>
            </span>
          }
          aside={<StatusDot tone={liveTasks.length > 0 ? 'ok' : 'info'} pulse={liveTasks.length > 0} />}
        />
        <Metric
          label="今日 Token"
          value={formatTokens(totalTokens)}
          hint={`输入 ${formatTokens(summary?.todayInputTokens ?? 0)} · 输出 ${formatTokens(summary?.todayOutputTokens ?? 0)}`}
          spark={dailyTotals}
          sparkColor="#22D3EE"
        />
        <Metric
          label="今日费用"
          value={formatCost(today?.todayCostUsd ?? 0, currency, fxRate)}
          hint={`运行中已消耗 ${formatCost(summary?.runningCostUsd ?? 0, currency, fxRate)}`}
          spark={dailyTotals}
          sparkColor="#7C6BFF"
        />
        <Metric
          label="平均缓存命中率"
          value={formatRate(today?.avgCacheHitRate)}
          hint={`缓存读 ${formatTokens(summary?.todayCacheReadTokens ?? 0)} tokens`}
          spark={dailyTotals}
          sparkColor="#2DD4BF"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <SectionTitle
            title="实时任务"
            hint="时长逐秒刷新，Token 与费用按采集周期增量更新"
            action={
              <span className="flex items-center gap-1.5 text-caption text-fg-lo">
                <Activity size={12} />
                {liveTasks.length} 个进行中
                {idleCount > 0 ? ` · 其中 ${idleCount} 个静默` : ''}
              </span>
            }
          />
          <div className="space-y-2.5">
            {liveTasks.length === 0 ? (
              <Card className="p-0">
                <EmptyState
                  icon={<Sparkles size={20} />}
                  title="暂无进行中的 AI 任务"
                  description="开始使用 Codex、Claude Code、CodeBuddy、WorkBuddy、Cursor 或元宝，任务会自动出现在这里。若某个工具始终无数据，请到「适配器」页查看采集通道状态。"
                />
              </Card>
            ) : (
              liveTasks.map((task) => (
                <LiveTaskCard
                  key={task.id}
                  task={task}
                  now={now}
                  currency={currency}
                  fxRate={fxRate}
                  onOpen={openDrawer}
                />
              ))
            )}
          </div>
        </div>

        <div className="space-y-4">
          <Card>
            <SectionTitle title="工具费用分布" hint="近 7 天" />
            <ToolDistribution data={stats?.byTool ?? []} currency={currency} fxRate={fxRate} />
          </Card>

          <Card>
            <SectionTitle title="告警" hint="阈值可在设置中调整" />
            {(snapshot?.alerts.length ?? 0) === 0 ? (
              <div className="flex items-center gap-2 rounded-xl border border-dashed border-white/[0.07] px-3 py-6 text-caption text-fg-lo">
                <Inbox size={14} />
                当前没有触发任何阈值
              </div>
            ) : (
              <div className="space-y-1.5">
                {snapshot?.alerts.slice(0, 4).map((alert) => (
                  <button
                    key={alert.id}
                    type="button"
                    onClick={() => openDrawer(alert.taskId)}
                    className="flex w-full items-start gap-2 rounded-lg border border-state-warn/20 bg-state-warn/[0.06] px-2.5 py-2 text-left transition-colors hover:bg-state-warn/[0.1]"
                  >
                    <AlertTriangle size={13} className="mt-0.5 shrink-0 text-state-warn" />
                    <div className="min-w-0">
                      <p className="truncate text-caption text-fg-hi">{alert.title}</p>
                      <p className="truncate text-[10px] text-fg-lo">
                        {toolName(alert.tool)} · {alert.message}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle title="采集健康度" hint="最近事件时间" />
            <div className="space-y-1.5">
              {(snapshot?.adapters ?? []).slice(0, 7).map((adapter) => (
                <div key={adapter.id} className="flex items-center gap-2 text-caption">
                  <StatusDot
                    tone={
                      adapter.status === 'ok' ? 'ok' : adapter.status === 'degraded' ? 'warn' : 'off'
                    }
                  />
                  <span className="truncate text-fg-mid">{adapter.displayName}</span>
                  <span className="num ml-auto text-fg-lo">
                    {adapter.lastEventAt ? formatRelative(adapter.lastEventAt) : '无事件'}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Card>
        <SectionTitle
          title="近 7 天费用趋势"
          hint="按工具堆叠，单位随币种切换"
          action={
            <span className="num text-caption text-fg-lo">
              合计 {formatCost(stats?.totals.todayCostUsd ?? 0, currency, fxRate)}
            </span>
          }
        />
        <CostTrend data={stats?.daily ?? []} currency={currency} fxRate={fxRate} height={208} />
      </Card>
    </div>
  )
}
