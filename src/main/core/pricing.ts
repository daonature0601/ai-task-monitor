import type { PricingRow, TokenUsage } from '@shared/types'

export interface PricedModel {
  row: PricingRow | null
  /** 命中的匹配模式，便于界面提示 */
  matchedBy: string | null
  /** 是否为未知模型（按 0 计价） */
  unknown: boolean
  /** 命中行是否为「待确认」状态：价格为未知，不可计价 */
  pending: boolean
}

function toRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * 模型名 → 价目行。优先最长匹配（`claude-sonnet*` 优先于 `*`），
 * 未匹配到具名模型时返回 fallback（通常为 0 价），由界面标灰提示补录。
 */
export function matchPrice(model: string | undefined, rows: PricingRow[]): PricedModel {
  const raw = (model ?? '').trim().toLowerCase()
  // 「-ioa」是内部转换标记，实际计费按前缀模型（glm-5.3-ioa 就是 glm-5.3）
  const name = raw.replace(/-ioa$/, '')
  if (!name) {
    const fallback = rows.find((r) => r.match === '*') ?? null
    return {
      row: fallback,
      matchedBy: fallback ? '*' : null,
      unknown: true,
      pending: true
    }
  }

  let best: PricingRow | null = null
  for (const row of rows) {
    if (!row.match || row.match === '*') continue
    if (toRegExp(row.match).test(name)) {
      if (!best || row.match.length > best.match.length) best = row
    }
  }
  if (best) {
    return {
      row: best,
      matchedBy: best.match,
      unknown: false,
      pending: best.status !== 'verified'
    }
  }

  const fallback = rows.find((r) => r.match === '*') ?? null
  return { row: fallback, matchedBy: fallback ? '*' : null, unknown: true, pending: true }
}

/**
 * 按每百万 token 单价计算费用（USD）。
 * reasoningTokens 已包含在 outputTokens 内，不重复计价。
 */
/** 该时刻是否处于高峰时段（UTC 小时，左闭右开；可限制仅工作日） */
export function isPeakHour(price: PricingRow, ts: number): boolean {
  const peak = price.peak
  const windows = price.peakHoursUtc
  if (!peak || !windows || windows.length === 0) return false
  if (!Number.isFinite(ts) || ts <= 0) return false

  const date = new Date(ts)
  // getUTCDay: 0=周日 … 6=周六
  const weekday = date.getUTCDay()
  if (price.peakWeekdaysOnly && (weekday === 0 || weekday === 6)) return false

  const hour = date.getUTCHours() + date.getUTCMinutes() / 60
  return windows.some(([from, to]) => hour >= from && hour < to)
}

/** 按时刻取生效单价：命中高峰时段用 peak，否则用基础价 */
export function ratesFor(
  price: PricingRow,
  ts = Date.now()
): { inputPerM: number; outputPerM: number; cacheReadPerM: number; cacheWritePerM: number } {
  if (isPeakHour(price, ts)) {
    const peak = price.peak as NonNullable<PricingRow['peak']>
    return peak
  }
  return {
    inputPerM: price.inputPerM,
    outputPerM: price.outputPerM,
    cacheReadPerM: price.cacheReadPerM,
    cacheWritePerM: price.cacheWritePerM
  }
}

/**
 * 计算一次用量的费用。
 * ts 用于分时计价（目前只有 DeepSeek 区分高峰 / 非高峰），缺省按基础价。
 */
/** 人民币计价模型折算美元用的固定汇率（与价目表展示口径一致） */
export const CNY_TO_USD = 7.1

export function computeCost(usage: TokenUsage, price: PricingRow | null, ts?: number): number {
  if (!price) return 0
  const rates = ratesFor(price, ts)
  const perM = 1_000_000
  const native =
    (usage.inputTokens / perM) * rates.inputPerM +
    (usage.outputTokens / perM) * rates.outputPerM +
    (usage.cacheReadTokens / perM) * rates.cacheReadPerM +
    (usage.cacheWriteTokens / perM) * rates.cacheWritePerM
  // 价目按厂商原币种保存（国内厂商为人民币），入库统一折算成美元
  const cost = price.currency === 'CNY' ? native / CNY_TO_USD : native
  if (!Number.isFinite(cost) || cost < 0) return 0
  return Math.round(cost * 1e6) / 1e6
}

export function prettyPrice(row: PricingRow): string {
  return `in $${row.inputPerM}/M · out $${row.outputPerM}/M · cache $${row.cacheReadPerM}/M`
}
