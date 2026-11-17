import { describe, expect, it } from 'vitest'
import type { PricingRow } from '@shared/types'
import { computeCost, matchPrice } from '../src/main/core/pricing'

const ROWS: PricingRow[] = [
  { id: 'sonnet', provider: 'Anthropic', match: 'claude-sonnet*', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75, status: 'verified' },
  { id: 'claude-any', provider: 'Anthropic', match: 'claude-*', inputPerM: 5, outputPerM: 20, cacheReadPerM: 0.5, cacheWritePerM: 5, status: 'verified' },
  { id: 'fallback', provider: '未知', match: '*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending' }
]

describe('matchPrice', () => {
  it('优先命中更长的匹配模式', () => {
    const result = matchPrice('claude-sonnet-4-5', ROWS)
    expect(result.row?.id).toBe('sonnet')
    expect(result.unknown).toBe(false)
  })

  it('未列名的同族模型走兜底通配', () => {
    const result = matchPrice('claude-opus-9', ROWS)
    expect(result.row?.id).toBe('claude-any')
  })

  it('完全未知的模型标记 unknown 并使用 * 行', () => {
    const result = matchPrice('unknown-model-v1', ROWS)
    expect(result.row?.id).toBe('fallback')
    expect(result.unknown).toBe(true)
    expect(result.pending).toBe(true)
  })

  it('模型为空时视为未知', () => {
    const result = matchPrice(undefined, ROWS)
    expect(result.unknown).toBe(true)
    expect(result.pending).toBe(true)
  })

  it('命中「待确认」价目行时不可计价', () => {
    const rows: PricingRow[] = [
      ...ROWS,
      { id: 'codex-unknown', provider: 'OpenAI', match: 'codex-*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending' }
    ]
    const result = matchPrice('codex-auto-review', rows)
    expect(result.row?.id).toBe('codex-unknown')
    expect(result.unknown).toBe(false)
    expect(result.pending).toBe(true)
  })

  it('已核实行不标记 pending', () => {
    expect(matchPrice('claude-sonnet-4-5', ROWS).pending).toBe(false)
  })
})

describe('computeCost', () => {
  const price = ROWS[0]

  it('按每百万 token 累加四类用量', () => {
    const cost = computeCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        reasoningTokens: 500_000
      },
      price
    )
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6)
  })

  it('reasoning tokens 不重复计价', () => {
    const base = computeCost(
      { inputTokens: 0, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      price
    )
    const withReasoning = computeCost(
      { inputTokens: 0, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 900 },
      price
    )
    expect(withReasoning).toBe(base)
  })

  it('无价目时返回 0', () => {
    const cost = computeCost(
      { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      null
    )
    expect(cost).toBe(0)
  })
})
