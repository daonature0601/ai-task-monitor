import { useEffect, useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import type { CachePoint, Currency, DailyPoint, ToolAggregate, ToolId } from '@shared/types'
import { TOOL_META } from '@shared/types'
import { formatCost, formatRate, formatTokens } from '@shared/format'
import { cn, toolName } from '../../lib/utils'

interface TooltipItem {
  name?: string | number
  value?: number | string
  color?: string
  payload?: Record<string, unknown>
}

/**
 * 统一的自定义 Tooltip。
 * 之前用 recharts 默认实现 + contentStyle，条目名称取的是 series 的 stroke/fill，
 * 饼图的渐变或纯色在暗色底上对比度极差，出现「文字看不清」。
 * 这里改为自己画：圆点取色、名称用 text-fg-mid、数值用 text-fg-hi。
 */
export function ChartTooltip({
  active,
  payload,
  label,
  valueText,
  nameText
}: {
  active?: boolean
  payload?: TooltipItem[]
  label?: string | number
  valueText?: (value: number, name: string) => string
  nameText?: (name: string) => string
}): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null
  return (
    // 背景用内联样式而非 Tailwind 任意值：`bg-[#0E141E]/96` 不会被编译产出规则，
    // 结果只剩 backdrop-blur，浮层变成半透明玻璃、文字被图表颜色穿透。
    <div
      className="pointer-events-none min-w-[136px] rounded-lg border border-white/[0.14] px-2.5 py-2 shadow-[0_18px_44px_-14px_rgba(0,0,0,0.92)]"
      style={{ background: 'rgba(11,16,24,0.98)' }}
    >
      {label !== undefined && label !== '' && (
        <p className="mb-1 text-[10px] tracking-wide text-[#9AA9BC]">{String(label)}</p>
      )}
      <div className="space-y-1">
        {payload.map((item, index) => {
          const name = String(item.name ?? '')
          const value = typeof item.value === 'number' ? item.value : Number(item.value ?? 0)
          const dot = item.color ?? (item.payload?.fill as string | undefined) ?? '#8A99AD'
          return (
            <div key={`${name}-${index}`} className="flex items-center gap-2 text-[11px]">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full ring-1 ring-black/40"
                style={{ background: dot }}
              />
              <span className="text-[#C6D2E1]">{nameText ? nameText(name) : name}</span>
              <span className="num ml-auto pl-3 font-medium text-fg-hi">
                {valueText ? valueText(value, name) : value.toLocaleString('zh-CN')}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function shortDate(date: string): string {
  return date.slice(5)
}

/**
 * 图表延迟挂载：recharts 在首帧测量宽度可能为 0，
 * 会把 clipPath 宽度写成 0 导致图形被完全裁掉。
 * 等一帧（布局稳定）后再挂载可彻底规避。
 */
export function useChartReady(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setReady(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])
  return ready
}

const PLACEHOLDER = 'rounded-xl border border-dashed border-white/[0.06]'

export function CostTrend({
  data,
  currency,
  fxRate,
  height = 220,
  stacked = true
}: {
  data: DailyPoint[]
  currency: Currency
  fxRate: number
  height?: number
  stacked?: boolean
}): JSX.Element {
  const tools = useMemo(() => {
    const set = new Set<ToolId>()
    for (const point of data) {
      for (const [tool, value] of Object.entries(point.byTool)) {
        if ((value ?? 0) > 0) set.add(tool as ToolId)
      }
    }
    return Array.from(set)
  }, [data])

  const rows = useMemo(
    () =>
      data.map((point) => {
        const row: Record<string, string | number> = { date: shortDate(point.date) }
        for (const tool of tools) row[tool] = Number((point.byTool[tool] ?? 0).toFixed(5))
        return row
      }),
    [data, tools]
  )

  const ready = useChartReady()

  if (!ready) return <div className={PLACEHOLDER} style={{ height }} />

  if (tools.length === 0) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-dashed border-white/[0.07] text-caption text-fg-lo"
        style={{ height }}
      >
        当前区间没有费用记录
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
        <defs>
          {tools.map((tool) => (
            <linearGradient key={tool} id={`grad-${tool}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={TOOL_META[tool].color} stopOpacity={0.42} />
              <stop offset="100%" stopColor={TOOL_META[tool].color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="rgba(255,255,255,0.045)" vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={18} />
        <YAxis tickLine={false} axisLine={false} width={54} tickFormatter={(v: number) => formatCost(v, currency, fxRate)} />
        <Tooltip
          cursor={{ stroke: 'rgba(255,255,255,0.14)', strokeDasharray: '3 3' }}
          content={
            <ChartTooltip
              valueText={(value) => formatCost(value, currency, fxRate)}
              nameText={(name) => toolName(name as ToolId)}
            />
          }
        />
        {tools.map((tool) => (
          <Area
            key={tool}
            type="monotone"
            dataKey={tool}
            stackId={stacked ? 'cost' : undefined}
            stroke={TOOL_META[tool].color}
            strokeWidth={1.4}
            fill={stacked ? `url(#grad-${tool})` : 'transparent'}
            fillOpacity={0.9}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function ToolDistribution({
  data,
  currency,
  fxRate
}: {
  data: ToolAggregate[]
  currency: Currency
  fxRate: number
}): JSX.Element {
  const items = data.filter((item) => item.costUsd > 0)
  const total = items.reduce((sum, item) => sum + item.costUsd, 0)
  const ready = useChartReady()

  if (!ready) return <div className={cn(PLACEHOLDER, 'h-[148px]')} />

  if (items.length === 0) {
    return (
      <div className="flex h-[168px] items-center justify-center rounded-xl border border-dashed border-white/[0.07] text-caption text-fg-lo">
        暂无工具费用分布
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3">
      <div className="relative h-[148px] w-[148px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={items}
              dataKey="costUsd"
              nameKey="tool"
              innerRadius={44}
              outerRadius={68}
              paddingAngle={2}
              strokeWidth={0}
              isAnimationActive={false}
            >
              {items.map((item) => (
                <Cell key={item.tool} fill={TOOL_META[item.tool].color} fillOpacity={0.85} />
              ))}
            </Pie>
            <Tooltip
              content={
                <ChartTooltip
                  valueText={(value) => formatCost(value, currency, fxRate)}
                  nameText={(name) => toolName(name as ToolId)}
                />
              }
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="num text-body font-semibold text-fg-hi">
            {formatCost(total, currency, fxRate)}
          </span>
          <span className="text-[10px] text-fg-mid">合计</span>
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {items.slice(0, 6).map((item) => (
          <div key={item.tool} className="flex items-center gap-2">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: TOOL_META[item.tool].color }}
            />
            <span className="truncate text-caption text-fg-mid">{toolName(item.tool)}</span>
            <span className="num ml-auto text-caption text-fg-hi">
              {((item.costUsd / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function CacheEfficiency({ data }: { data: CachePoint[] }): JSX.Element {
  const rows = data
    .filter((point) => point.rate !== null)
    .map((point) => ({ date: shortDate(point.date), rate: Number(((point.rate ?? 0) * 100).toFixed(1)) }))
  const ready = useChartReady()

  if (!ready) return <div className={cn(PLACEHOLDER, 'h-[180px]')} />

  if (rows.length === 0) {
    return (
      <div className="flex h-[180px] items-center justify-center rounded-xl border border-dashed border-white/[0.07] text-caption text-fg-lo">
        暂无缓存命中数据
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={rows} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="rgba(255,255,255,0.045)" vertical={false} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={16} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          domain={[0, 100]}
          ticks={[0, 25, 50, 75, 100]}
          tickFormatter={(value: number) => `${value}%`}
        />
        <Tooltip
          cursor={{ stroke: 'rgba(255,255,255,0.14)', strokeDasharray: '3 3' }}
          content={<ChartTooltip valueText={(value) => formatRate(value / 100)} nameText={() => '输入缓存命中率'} />}
        />
        <Line
          type="monotone"
          dataKey="rate"
          stroke="#7C6BFF"
          strokeWidth={1.8}
          dot={false}
          activeDot={{ r: 3, fill: '#7C6BFF' }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

export function TokenBars({
  data,
  currency,
  fxRate
}: {
  data: ToolAggregate[]
  currency: Currency
  fxRate: number
}): JSX.Element {
  const rows = data
    .map((item) => ({
      tool: toolName(item.tool),
      input: item.inputTokens,
      output: item.outputTokens,
      cost: formatCost(item.costUsd, currency, fxRate)
    }))
    .slice(0, 7)

  if (rows.length === 0) {
    return <p className="py-6 text-center text-caption text-fg-lo">暂无 Token 记录</p>
  }

  const max = Math.max(...rows.map((row) => row.input + row.output), 1)

  return (
    <div className="space-y-2.5">
      {rows.map((row) => {
        const total = row.input + row.output
        return (
          <div key={row.tool} className="space-y-1">
            <div className="flex items-center justify-between text-caption">
              <span className="text-fg-mid">{row.tool}</span>
              <span className="num text-fg-lo">
                {formatTokens(total)} · {row.cost}
              </span>
            </div>
            <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.04]">
              <span
                className="h-full bg-accent-cyan/80"
                style={{ width: `${(row.input / max) * 100}%` }}
              />
              <span
                className="h-full bg-accent-teal/70"
                style={{ width: `${(row.output / max) * 100}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
