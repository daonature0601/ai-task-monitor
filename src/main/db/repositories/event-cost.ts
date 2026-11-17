import type Database from 'better-sqlite3'
import type { PricingRow, TokenUsage } from '@shared/types'
import { computeCost, matchPrice } from '../../core/pricing'

/**
 * 重算用量流水的事件级费用。
 *
 * 背景：事件写入时若模型名尚未解析出来（Codex 首轮事件常见），
 * 事件费用会被记成 0；而任务主表的费用用的是最终模型名。
 * 两者口径不一致会让「按事件时间统计」的区间费用偏低。
 *
 * 这里以任务上的模型为准重算一遍，代价是一次全表 UPDATE（数万行，毫秒级）。
 */
export function recomputeEventCosts(
  db: Database.Database,
  pricing: PricingRow[]
): { updated: number; total: number } {
  const rows = db
    .prepare(
      `SELECT e.id AS id,
              e.input_tokens AS input_tokens,
              e.output_tokens AS output_tokens,
              e.cache_read_tokens AS cache_read_tokens,
              e.cache_write_tokens AS cache_write_tokens,
              e.reasoning_tokens AS reasoning_tokens,
              e.cost_usd AS cost_usd,
              t.model AS model,
              t.tokens_source AS tokens_source
       FROM usage_events e JOIN tasks t ON t.id = e.task_id`
    )
    .all() as Array<{
    id: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    reasoning_tokens: number
    cost_usd: number
    model: string | null
    tokens_source: string
  }>

  const update = db.prepare('UPDATE usage_events SET cost_usd = ? WHERE id = ?')
  const priceCache = new Map<string, PricingRow | null>()
  let updated = 0

  const priceFor = (model: string | null): PricingRow | null => {
    const key = model ?? ''
    if (priceCache.has(key)) return priceCache.get(key) ?? null
    const matched = matchPrice(model ?? undefined, pricing)
    const row = matched.pending ? null : matched.row
    priceCache.set(key, row)
    return row
  }

  const run = db.transaction(() => {
    for (const row of rows) {
      const billable = row.tokens_source === 'native' || row.tokens_source === 'bridge'
      const price = billable ? priceFor(row.model) : null
      const usage: TokenUsage = {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        reasoningTokens: row.reasoning_tokens
      }
      const value = computeCost(usage, price)
      if (Math.abs(value - row.cost_usd) > 1e-9) {
        update.run(value, row.id)
        updated += 1
      }
    }
  })

  run()
  return { updated, total: rows.length }
}
