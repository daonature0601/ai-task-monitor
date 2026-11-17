import { describe, expect, it } from 'vitest'
import type { AppSettings, TaskSnapshot } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { evaluateTask } from '../src/main/core/alerts'

const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime()

function makeTask(patch: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'codex:session-1',
    tool: 'codex',
    externalSessionId: 'session-1',
    title: '重构计费模块',
    status: 'running',
    startedAt: NOW - 60_000,
    lastEventAt: NOW,
    durationMs: 60_000,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 2000,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.2,
    costKnown: true,
    cacheHitRate: 0.66,
    tokensSource: 'native',
    eventCount: 3,
    alerts: [],
    ...patch
  }
}

const settings: AppSettings = { ...DEFAULT_SETTINGS }

describe('evaluateTask', () => {
  it('低费用低时长不触发告警', () => {
    expect(evaluateTask(makeTask(), settings, NOW)).toEqual([])
  })

  it('费用超过提醒线触发 cost_warn，超过警示线触发 cost_danger', () => {
    expect(evaluateTask(makeTask({ costUsd: 1.2 }), settings, NOW)).toContain('cost_warn')
    expect(evaluateTask(makeTask({ costUsd: 6 }), settings, NOW)).toContain('cost_danger')
    expect(evaluateTask(makeTask({ costUsd: 6 }), settings, NOW)).not.toContain('cost_warn')
  })

  it('时长阈值按 30 分钟 / 2 小时分级', () => {
    const warn = makeTask({ startedAt: NOW - 31 * 60_000 })
    expect(evaluateTask(warn, settings, NOW)).toContain('duration_warn')

    const danger = makeTask({ startedAt: NOW - 121 * 60_000 })
    expect(evaluateTask(danger, settings, NOW)).toContain('duration_danger')
  })

  it('样本量不足 1000 token 时不判定缓存命中率', () => {
    const tiny = makeTask({
      inputTokens: 10,
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
      cacheHitRate: 0.1
    })
    expect(evaluateTask(tiny, settings, NOW)).not.toContain('cache_low')

    const big = makeTask({ inputTokens: 5000, cacheReadTokens: 500, cacheHitRate: 0.09 })
    expect(evaluateTask(big, settings, NOW)).toContain('cache_low')
  })

  it('已结束任务用结算时长而非当前时间', () => {
    const ended = makeTask({
      status: 'ended',
      startedAt: NOW - 10 * 60_000,
      endedAt: NOW - 5 * 60_000,
      durationMs: 5 * 60_000
    })
    expect(evaluateTask(ended, settings, NOW)).toEqual([])
  })
})
