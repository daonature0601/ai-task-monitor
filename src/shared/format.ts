import type { Currency, TokenUsage } from './types'

/** 1h 23m 45s / 45s / 12m 05s — 秒级跳动使用 tabular-nums 防抖 */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) ? ms : 0
  const total = Math.max(0, Math.floor(safe / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/** 紧凑时长：1h23m / 23m / 45s（用于托盘与卡片角落） */
export function formatDurationShort(ms: number): string {
  const safe = Number.isFinite(ms) ? ms : 0
  const total = Math.max(0, Math.floor(safe / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/** <1000 原值；>=1000 → 12.4K；>=1000000 → 1.23M */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) ? n : 0
  if (Math.abs(v) < 1000) return String(Math.round(v))
  if (Math.abs(v) < 1_000_000) return `${(v / 1000).toFixed(1)}K`
  if (Math.abs(v) < 1_000_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  return `${(v / 1_000_000_000).toFixed(2)}B`
}

export function formatTokensFull(n: number): string {
  return Math.round(n || 0).toLocaleString('en-US')
}

/** 默认 USD；>=1 保留 2 位，<1 保留 4 位 */
export function formatCost(usd: number, currency: Currency = 'USD', fxRate = 7.2): string {
  const value = currency === 'CNY' ? usd * fxRate : usd
  const symbol = currency === 'CNY' ? '¥' : '$'
  const v = Number.isFinite(value) ? value : 0
  if (v === 0) return `${symbol}0.00`
  if (Math.abs(v) >= 1) return `${symbol}${v.toFixed(2)}`
  if (Math.abs(v) >= 0.01) return `${symbol}${v.toFixed(4)}`
  return `${symbol}${v.toFixed(5)}`
}

/**
 * 任务费用展示：只有「完整 token 来源 + 已核实单价」才显示金额，
 * 其余一律 "—"，避免把上下文占用量或未知单价折算成数字。
 */
export function formatTaskCost(
  usd: number,
  costKnown: boolean,
  currency: Currency = 'USD',
  fxRate = 7.2
): string {
  if (!costKnown) return '—'
  return formatCost(usd, currency, fxRate)
}

/**
 * 当次问答（turn）已用时长。
 * 优先用 turnStartedAt/turnEndedAt；老数据没有轮次信息时回落到任务时长。
 */
export function turnElapsed(
  task: {
    turnStartedAt?: number
    turnEndedAt?: number
    status: string
    endedAt?: number
    lastEventAt?: number
    durationMs: number
  },
  now = Date.now()
): number {
  const start = task.turnStartedAt
  if (!start) return task.durationMs
  // 只有「运行中」才用当前时间推进；静默 / 已结束都冻结在最后一次活动时刻，
  // 否则卡片（低频刷新）与详情（每秒刷新）会各算各的，出现两个不同的数字。
  const end =
    task.status === 'running'
      ? now
      : (task.turnEndedAt ?? task.endedAt ?? task.lastEventAt ?? start)
  return Math.max(0, end - start)
}

/**
 * 任务副标题：项目 · 模型。
 * 两者都可能缺失（如 CodeBuddy IDE 不落盘模型名），此时用固定文案兜底，
 * 避免各处一个写「—」、一个写「未上报」。
 */
export function taskSubtitle(task: { project?: string; model?: string }): string {
  return `${task.project ?? '项目未知'} · ${task.model ?? '模型未知'}`
}

/** 保留 1 位；null 显示 — */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

/**
 * 输入缓存命中率 = cacheRead / (input + cacheRead + cacheWrite)
 * 分母为 0 返回 null（界面显示 —，绝不补 0）
 */
export function computeCacheHitRate(usage: Partial<TokenUsage>): number | null {
  const read = usage.cacheReadTokens ?? 0
  const input = usage.inputTokens ?? 0
  const write = usage.cacheWriteTokens ?? 0
  const denom = input + read + write
  if (denom <= 0) return null
  return read / denom
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatTimeFull(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 事件时间：带日期消歧。
 * 合并子代理后，同一个任务里可能出现跨天的事件，
 * 只显示时分秒会让人误以为是"未来的时间"。
 */
export function formatEventTime(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const today = startOfDay(now)
  if (ts >= today) return hms
  if (ts >= today - 86_400_000) return `昨天 ${hms}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`
}

export function formatTimeShort(ts: number, now = Date.now()): string {
  const d = new Date(ts)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const today = startOfDay(now)
  if (ts >= today) return `今天 ${hm}`
  if (ts >= today - 86_400_000) return `昨天 ${hm}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

export function formatRelative(ts: number | null, now = Date.now()): string {
  if (!ts) return '从未'
  const diff = Math.max(0, now - ts)
  if (diff < 5_000) return '刚刚'
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  idle: '静默',
  ended: '已结束'
}

/** 状态语义说明，用于 tooltip，避免「空闲」与「已结束」被混为一谈 */
export const STATUS_HINT: Record<string, string> = {
  running: '最近 90 秒内有新的用量事件',
  idle: '超过 90 秒没有新事件，任务仍在进行中；持续 30 分钟无事件后自动结算为已结束',
  ended: '已结算，时长冻结；不会再有实时更新'
}

export const SOURCE_LABEL: Record<string, string> = {
  native: '原生落盘',
  bridge: '网页桥接',
  partial: '部分字段',
  unavailable: '数据不可用'
}

export const ALERT_LABEL: Record<string, string> = {
  cost_warn: '费用提醒',
  cost_danger: '费用超限',
  duration_warn: '耗时提醒',
  duration_danger: '耗时超限',
  cache_low: '缓存命中偏低',
  adapter_error: '采集异常'
}
