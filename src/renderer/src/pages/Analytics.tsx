import { useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Download } from 'lucide-react'
import type { StatsPayload } from '@shared/types'
import {
  displayInput,
  formatCost,
  formatDuration,
  formatRate,
  formatTokens,
  turnElapsed
} from '@shared/format'
import { useMonitor } from '../store/monitor'
import { Card, Metric, SectionTitle, ToolAvatar } from '../components/ui/atoms'
import { CacheEfficiency, ChartTooltip, CostTrend, useChartReady } from '../components/charts'
import { cn, toolName } from '../lib/utils'

type RangeKey = 'today' | 'week' | 'month' | 'custom'

const RANGE_LABEL: Record<RangeKey, string> = {
  today: '今日',
  week: '近 7 天',
  month: '近 30 天',
  custom: '自定义'
}

/** 本地日期字符串（YYYY-MM-DD），与 dayKey 保持一致 */
function localDay(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function resolveRange(
  key: RangeKey,
  custom?: { from: string; to: string }
): { from: number; to: number } {
  const now = Date.now()
  if (key === 'custom' && custom?.from && custom?.to) {
    const rawFrom = new Date(`${custom.from}T00:00:00`).getTime()
    const rawTo = new Date(`${custom.to}T23:59:59.999`).getTime()
    if (Number.isFinite(rawFrom) && Number.isFinite(rawTo)) {
      // 起止颠倒时自动纠正，未来时间点按当前时间截断
      const from = Math.min(rawFrom, rawTo)
      const to = Math.min(Math.max(rawFrom, rawTo), now)
      return { from, to }
    }
  }
  const to = now
  if (key === 'today') {
    const start = new Date(to)
    start.setHours(0, 0, 0, 0)
    return { from: start.getTime(), to }
  }
  return { from: to - (key === 'week' ? 7 : 30) * 86_400_000, to }
}

export function Analytics(): JSX.Element {
  const snapshot = useMonitor((s) => s.snapshot)
  const notify = useMonitor((s) => s.notify)
  const openDrawer = useMonitor((s) => s.openDrawer)
  const [range, setRange] = useState<RangeKey>('week')
  const [customFrom, setCustomFrom] = useState(() => localDay(Date.now() - 6 * 86_400_000))
  const [customTo, setCustomTo] = useState(() => localDay(Date.now()))
  const [stats, setStats] = useState<StatsPayload | null>(null)
  const [loading, setLoading] = useState(false)

  const currency = snapshot?.currency ?? 'USD'
  const fxRate = snapshot?.fxRate ?? 7.2

  useEffect(() => {
    let disposed = false
    const { from, to } = resolveRange(range, { from: customFrom, to: customTo })
    setLoading(true)
    window.monitor
      .getStats(from, to)
      .then((result) => {
        if (!disposed) setStats(result)
      })
      .catch((error: unknown) => console.error('[analytics] stats failed', error))
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [range, customFrom, customTo, snapshot?.summary.todayCostUsd])

  const totals = stats?.totals
  const chartReady = useChartReady()
  const topMax = Math.max(...(stats?.topTasks ?? []).map((t) => t.costUsd), 1e-9)
  const bucketData = useMemo(
    () => (stats?.durationBuckets ?? []).map((bucket) => ({ ...bucket })),
    [stats]
  )

  const exportCsv = async (): Promise<void> => {
    const { from, to } = resolveRange(range, { from: customFrom, to: customTo })
    const result = await window.monitor.exportCsv(from, to)
    notify(
      result.saved ? `已导出 ${result.rows ?? 0} 条记录` : '已取消导出',
      result.saved ? 'ok' : 'warn'
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-white/[0.07] bg-white/[0.03] p-0.5">
            {(Object.keys(RANGE_LABEL) as RangeKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setRange(key)}
                className={cn(
                  'rounded-md px-3 py-1 text-caption transition-colors',
                  range === key ? 'bg-white/[0.09] text-fg-hi' : 'text-fg-lo hover:text-fg-mid'
                )}
              >
                {RANGE_LABEL[key]}
              </button>
            ))}
          </div>

          {range === 'custom' && (
            <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.03] px-2 py-0.5">
              <input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(event) => setCustomFrom(event.target.value)}
                className="field h-[24px] w-[124px] px-1.5 py-0 text-caption [color-scheme:dark]"
              />
              <span className="text-caption text-fg-lo">至</span>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={localDay(Date.now())}
                onChange={(event) => setCustomTo(event.target.value)}
                className="field h-[24px] w-[124px] px-1.5 py-0 text-caption [color-scheme:dark]"
              />
              <span className="num text-[10px] text-fg-lo">
                {Math.max(
                  1,
                  Math.round(
                    (new Date(`${customTo}T00:00:00`).getTime() -
                      new Date(`${customFrom}T00:00:00`).getTime()) /
                      86_400_000
                  ) + 1
                )}{' '}
                天
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="num text-caption text-fg-lo">{loading ? '统计中…' : '已更新'}</span>
          <button type="button" onClick={() => void exportCsv()} className="btn h-[30px]">
            <Download size={13} />
            <span className="text-caption">导出 CSV</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric label="任务总数" value={String(totals?.todayTasks ?? 0)} hint={`空闲 ${totals?.idleCount ?? 0} 个`} />
        <Metric label="区间费用" value={formatCost(totals?.todayCostUsd ?? 0, currency, fxRate)} />
        <Metric
          label="区间 Token"
          value={formatTokens(
            (totals?.todayInputTokens ?? 0) +
              (totals?.todayCacheReadTokens ?? 0) +
              (totals?.todayOutputTokens ?? 0)
          )}
          hint={`输入 ${formatTokens((totals?.todayInputTokens ?? 0) + (totals?.todayCacheReadTokens ?? 0))}（含缓存） · 输出 ${formatTokens(totals?.todayOutputTokens ?? 0)}`}
        />
        <Metric label="平均缓存命中" value={formatRate(totals?.avgCacheHitRate)} />
      </div>

      <Card>
        <SectionTitle
          title="按天按工具的费用堆叠"
          hint="悬停查看每个工具的具体金额"
          action={
            <span className="num text-caption text-fg-lo">
              合计 {formatCost(totals?.todayCostUsd ?? 0, currency, fxRate)}
            </span>
          }
        />
        <CostTrend data={stats?.daily ?? []} currency={currency} fxRate={fxRate} height={268} />
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <SectionTitle title="费用 Top 10 任务" hint="点击查看明细" />
          <div className="space-y-2">
            {(stats?.topTasks ?? []).length === 0 ? (
              <p className="py-6 text-center text-caption text-fg-lo">暂无任务记录</p>
            ) : (
              stats?.topTasks.map((task, index) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => openDrawer(task.id)}
                  className="group flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-white/[0.035]"
                >
                  <span className="num w-4 text-caption text-fg-lo">{index + 1}</span>
                  <ToolAvatar tool={task.tool} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-caption text-fg-hi">{task.title}</p>
                      <span className="num shrink-0 text-caption text-fg-hi">
                        {formatCost(task.costUsd, currency, fxRate)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-accent-cyan/80 to-accent-violet/70"
                          style={{ width: `${Math.max(4, (task.costUsd / topMax) * 100)}%` }}
                        />
                      </div>
                      <span className="num shrink-0 text-[10px] text-fg-lo">
                        {formatTokens(task.totalTokens)} · 本轮 {formatDuration(turnElapsed(task))}
                      </span>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </Card>

        <Card>
          <SectionTitle title="输入缓存命中率趋势" hint="缓存读 / (输入 + 缓存读写)" />
          <CacheEfficiency data={stats?.cacheTrend ?? []} />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <SectionTitle title="任务时长分布" hint="按已结算时长分桶统计" />
          {chartReady ? (
            <ResponsiveContainer width="100%" height={186}>
              <BarChart data={bucketData} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.045)' }}
                  content={<ChartTooltip valueText={(value) => `${value} 个任务`} nameText={() => '数量'} />}
                />
                <Bar dataKey="count" radius={[5, 5, 0, 0]} isAnimationActive={false}>
                  {bucketData.map((entry, index) => (
                    <Cell
                      key={entry.label}
                      fill={index >= 4 ? '#FBBF24' : index >= 2 ? '#7C6BFF' : '#22D3EE'}
                      fillOpacity={0.75}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[186px] rounded-xl border border-dashed border-white/[0.06]" />
          )}
        </Card>

        <Card>
          <SectionTitle title="工具汇总" hint="任务数、Token 与缓存效率" />
          <div className="overflow-hidden rounded-lg border border-white/[0.05]">
            <table className="w-full text-caption">
              <thead>
                <tr className="bg-white/[0.025] text-fg-lo">
                  <th className="px-2.5 py-1.5 text-left font-medium">工具</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">任务</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">输入</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">命中率</th>
                  <th className="px-2.5 py-1.5 text-right font-medium">费用</th>
                </tr>
              </thead>
              <tbody>
                {(stats?.byTool ?? []).map((row) => (
                  <tr key={row.tool} className="border-t border-white/[0.04]">
                    <td className="px-2.5 py-1.5">
                      <div className="flex items-center gap-1.5">
                        <ToolAvatar tool={row.tool} size="sm" />
                        <span className="text-fg-mid">{toolName(row.tool)}</span>
                      </div>
                    </td>
                    <td className="num px-2.5 py-1.5 text-right text-fg-mid">{row.tasks}</td>
                    <td className="num px-2.5 py-1.5 text-right text-fg-mid">
                      {formatTokens(displayInput(row.inputTokens, row.cacheReadTokens ?? 0))}
                    </td>
                    <td className="num px-2.5 py-1.5 text-right text-fg-mid">
                      {formatRate(row.cacheHitRate)}
                    </td>
                    <td className="num px-2.5 py-1.5 text-right text-fg-hi">
                      {formatCost(row.costUsd, currency, fxRate)}
                    </td>
                  </tr>
                ))}
                {(stats?.byTool ?? []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-2.5 py-6 text-center text-fg-lo">
                      区间内没有工具数据
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  )
}
