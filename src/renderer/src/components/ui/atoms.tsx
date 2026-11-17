import type { ReactNode } from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import type { ToolId } from '@shared/types'
import { cn, toolColor, toolMonogram, toolName } from '../../lib/utils'

export function Card({
  className,
  children,
  hover = false,
  id
}: {
  className?: string
  children: ReactNode
  hover?: boolean
  id?: string
}): JSX.Element {
  return (
    <div id={id} className={cn('glass p-5', hover && 'glass-hover', className)}>
      {children}
    </div>
  )
}

export function SectionTitle({
  title,
  hint,
  action
}: {
  title: string
  hint?: string
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-title font-semibold text-fg-hi">{title}</h2>
        {hint ? <p className="mt-0.5 text-caption text-fg-lo">{hint}</p> : null}
      </div>
      {action}
    </div>
  )
}

const DOT_TONE: Record<string, string> = {
  ok: 'bg-state-ok shadow-[0_0_0_3px_rgba(52,211,153,0.14)]',
  warn: 'bg-state-warn shadow-[0_0_0_3px_rgba(251,191,36,0.14)]',
  danger: 'bg-state-danger shadow-[0_0_0_3px_rgba(248,113,113,0.14)]',
  off: 'bg-fg-lo/60',
  info: 'bg-state-info shadow-[0_0_0_3px_rgba(96,165,250,0.14)]'
}

export function StatusDot({
  tone = 'off',
  pulse = false,
  className
}: {
  tone?: keyof typeof DOT_TONE
  pulse?: boolean
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-block h-[7px] w-[7px] rounded-full',
        DOT_TONE[tone] ?? DOT_TONE.off,
        pulse && 'animate-pulseRing',
        className
      )}
    />
  )
}

export function ToolAvatar({
  tool,
  size = 'md',
  active = false
}: {
  tool: ToolId
  size?: 'sm' | 'md' | 'lg'
  active?: boolean
}): JSX.Element {
  const color = toolColor(tool)
  const dim = size === 'sm' ? 'h-6 w-6 text-[10px]' : size === 'lg' ? 'h-10 w-10 text-body' : 'h-8 w-8 text-caption'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[10px] border font-semibold uppercase tracking-tight',
        dim
      )}
      style={{
        color,
        borderColor: `${color}33`,
        background: `linear-gradient(150deg, ${color}22, ${color}0A)`,
        boxShadow: active ? `0 0 16px -4px ${color}66` : undefined
      }}
      title={toolName(tool)}
    >
      {toolMonogram(tool)}
    </span>
  )
}

export function Badge({
  children,
  tone = 'neutral',
  className
}: {
  children: ReactNode
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'cyan' | 'violet'
  className?: string
}): JSX.Element {
  const tones: Record<string, string> = {
    neutral: 'border-white/10 bg-white/[0.04] text-fg-mid',
    ok: 'border-state-ok/25 bg-state-ok/10 text-state-ok',
    warn: 'border-state-warn/25 bg-state-warn/10 text-state-warn',
    danger: 'border-state-danger/25 bg-state-danger/10 text-state-danger',
    cyan: 'border-accent-cyan/25 bg-accent-cyan/10 text-accent-cyan',
    violet: 'border-accent-violet/25 bg-accent-violet/10 text-accent-violet'
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-caption font-medium',
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

export function Sparkline({
  data,
  color = '#22D3EE',
  width = 96,
  height = 28,
  className
}: {
  data: number[]
  color?: string
  width?: number
  height?: number
  className?: string
}): JSX.Element {
  const series = data.length >= 2 ? data : [0, 0]
  const max = Math.max(...series, 1e-9)
  const min = Math.min(...series, 0)
  const span = max - min || 1
  const step = width / (series.length - 1)
  const points = series.map((value, index) => {
    const x = index * step
    const y = height - 3 - ((value - min) / span) * (height - 6)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const id = `spark-${color.replace('#', '')}`

  return (
    <svg width={width} height={height} className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline
        points={`0,${height} ${points.join(' ')} ${width},${height}`}
        fill={`url(#${id})`}
        stroke="none"
      />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function TrendBadge({ delta }: { delta: number }): JSX.Element {
  const positive = delta > 0.001
  const negative = delta < -0.001
  const Icon = positive ? ArrowUpRight : negative ? ArrowDownRight : Minus
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-caption',
        positive ? 'text-state-warn' : negative ? 'text-state-ok' : 'text-fg-lo'
      )}
    >
      <Icon size={12} />
      {Math.abs(delta * 100).toFixed(0)}%
    </span>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <div className="relative">
        <div className="absolute inset-0 rounded-2xl bg-accent-cyan/10 blur-xl" />
        <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-ink-750 text-accent-cyan">
          {icon}
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-body font-medium text-fg-hi">{title}</p>
        <p className="mx-auto max-w-[320px] text-caption leading-relaxed text-fg-lo">{description}</p>
      </div>
      {action}
    </div>
  )
}

export function Metric({
  label,
  value,
  hint,
  spark,
  sparkColor,
  aside
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  spark?: number[]
  sparkColor?: string
  aside?: ReactNode
}): JSX.Element {
  return (
    <Card className="group relative overflow-hidden">
      <div className="pointer-events-none absolute -right-6 -top-8 h-24 w-24 rounded-full bg-accent-cyan/[0.05] blur-2xl transition-opacity duration-300 group-hover:opacity-100" />
      <div className="flex items-start justify-between">
        <p className="label-xs">{label}</p>
        {aside ?? (spark ? <Sparkline data={spark} color={sparkColor} width={72} height={24} /> : null)}
      </div>
      <p className="num mt-2 text-[26px] font-semibold leading-8 tracking-tight text-fg-hi">{value}</p>
      {hint ? <div className="mt-1.5 text-caption text-fg-lo">{hint}</div> : null}
    </Card>
  )
}
