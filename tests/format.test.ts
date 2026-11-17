import { describe, expect, it } from 'vitest'
import {
  computeCacheHitRate,
  formatCost,
  formatDuration,
  formatDurationShort,
  formatRate,
  formatTaskCost,
  formatTokens,
  startOfDay,
  turnElapsed
} from '@shared/format'

describe('formatDuration', () => {
  it('小于一分钟只显示秒', () => {
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(0)).toBe('0s')
  })

  it('分钟与小时按约定补零', () => {
    expect(formatDuration(65_000)).toBe('1m 05s')
    expect(formatDuration(5_025_000)).toBe('1h 23m 45s')
  })

  it('负数与非法值归零', () => {
    expect(formatDuration(-1000)).toBe('0s')
    expect(formatDuration(Number.NaN)).toBe('0s')
  })
})

describe('formatDurationShort', () => {
  it('省略空格用于托盘与表格', () => {
    expect(formatDurationShort(65_000)).toBe('1m05s')
    expect(formatDurationShort(3_723_000)).toBe('1h02m')
  })
})

describe('formatTokens', () => {
  it('按 1000 / 100 万 / 10 亿分档', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1.0K')
    expect(formatTokens(12_400)).toBe('12.4K')
    expect(formatTokens(1_234_567)).toBe('1.23M')
    expect(formatTokens(2_000_000_000)).toBe('2.00B')
  })
})

describe('formatCost', () => {
  it('美元与人民币分别取值', () => {
    expect(formatCost(0.1234, 'USD')).toBe('$0.1234')
    expect(formatCost(1.5, 'USD')).toBe('$1.50')
    expect(formatCost(1, 'CNY', 7.2)).toBe('¥7.20')
  })

  it('不可计价的任务不显示金额', () => {
    expect(formatTaskCost(12, false, 'USD')).toBe('—')
    expect(formatTaskCost(12, true, 'USD')).toBe('$12.00')
  })
})

describe('computeCacheHitRate', () => {
  it('分母为 0 时返回 null 而非 0', () => {
    expect(computeCacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull()
  })

  it('按 cacheRead / (input + read + write) 计算', () => {
    const rate = computeCacheHitRate({
      inputTokens: 100,
      cacheReadTokens: 800,
      cacheWriteTokens: 100
    })
    expect(rate).toBeCloseTo(0.8, 5)
  })

  it('formatRate 对 null 显示 —', () => {
    expect(formatRate(null)).toBe('—')
    expect(formatRate(0.8734)).toBe('87.3%')
  })
})

describe('startOfDay', () => {
  it('归零到当天 0 点', () => {
    const ts = new Date(2026, 10, 16, 21, 30, 15).getTime()
    const start = new Date(startOfDay(ts))
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
    expect(start.getDate()).toBe(16)
  })

  it('非运行态的本轮耗时冻结在最后活动时刻', () => {
    const task = {
      turnStartedAt: 1_000,
      status: 'idle',
      lastEventAt: 61_000,
      durationMs: 999_999
    }
    // 无论传入多晚的 now，静默任务都停在 lastEventAt
    expect(turnElapsed(task, 10_000_000)).toBe(60_000)

    const running = { turnStartedAt: 1_000, status: 'running', durationMs: 0 }
    expect(turnElapsed(running, 61_000)).toBe(60_000)
  })
})
