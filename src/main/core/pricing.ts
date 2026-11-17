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
  const name = (model ?? '').trim().toLowerCase()
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
export function computeCost(usage: TokenUsage, price: PricingRow | null): number {
  if (!price) return 0
  const perM = 1_000_000
  const cost =
    (usage.inputTokens / perM) * price.inputPerM +
    (usage.outputTokens / perM) * price.outputPerM +
    (usage.cacheReadTokens / perM) * price.cacheReadPerM +
    (usage.cacheWriteTokens / perM) * price.cacheWritePerM
  if (!Number.isFinite(cost) || cost < 0) return 0
  return Math.round(cost * 1e6) / 1e6
}

export function prettyPrice(row: PricingRow): string {
  return `in $${row.inputPerM}/M · out $${row.outputPerM}/M · cache $${row.cacheReadPerM}/M`
}
