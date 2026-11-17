import { describe, expect, it } from 'vitest'
import type { AppSettings, PricingRow, UsageDelta } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { TaskMachine } from '../src/main/core/task-machine'

const SETTINGS: AppSettings = { ...DEFAULT_SETTINGS, idleThresholdMs: 90_000 }
const PRICING: PricingRow[] = [
  { id: 'codex', provider: 'OpenAI', match: 'codex-*', inputPerM: 1, outputPerM: 10, cacheReadPerM: 0.1, cacheWritePerM: 1, status: 'verified' },
  { id: 'fallback', provider: '未知', match: '*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending' }
]

function makeMachine(): TaskMachine {
  return new TaskMachine({ settings: () => SETTINGS, pricing: () => PRICING })
}

function delta(patch: Partial<UsageDelta> & { ts: number }): UsageDelta {
  return {
    tool: 'codex',
    externalSessionId: 'sess-1',
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    tokensSource: 'native',
    model: 'codex-mini',
    dedupeKey: `k-${patch.ts}`,
    ...patch
  }
}

describe('TaskMachine 任务切分', () => {
  it('同一连续活动段合并为一个任务', () => {
    const machine = makeMachine()
    const t0 = Date.now()
    machine.ingest(delta({ ts: t0 }))
    machine.ingest(delta({ ts: t0 + 30_000, dedupeKey: 'b' }))
    machine.ingest(delta({ ts: t0 + 60_000, dedupeKey: 'c' }))

    const tasks = machine.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].eventCount).toBe(3)
    expect(tasks[0].inputTokens).toBe(3000)
  })

  it('间隔超过 10 分钟切分为新任务', () => {
    const machine = makeMachine()
    const t0 = Date.now() - 20 * 60_000
    machine.ingest(delta({ ts: t0 }))
    const result = machine.ingest(delta({ ts: t0 + 15 * 60_000, dedupeKey: 'late' }))

    expect(machine.list()).toHaveLength(2)
    expect(result.taskId).toContain('~')
  })

  it('重复 dedupeKey 被忽略', () => {
    const machine = makeMachine()
    const t0 = Date.now()
    const first = machine.ingest(delta({ ts: t0, dedupeKey: 'same' }))
    const second = machine.ingest(delta({ ts: t0, dedupeKey: 'same' }))

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)
    expect(machine.list()[0].inputTokens).toBe(1000)
  })
})

describe('TaskMachine 历史回填', () => {
  it('明显早于当前的事件直接结算，且时长随活动段延伸', () => {
    const machine = makeMachine()
    const start = Date.now() - 3_600_000
    machine.ingest(delta({ ts: start }))
    expect(machine.list()[0].status).toBe('ended')

    machine.ingest(delta({ ts: start + 5 * 60_000, dedupeKey: 'later' }))
    const task = machine.list()[0]
    expect(task.status).toBe('ended')
    expect(task.durationMs).toBe(5 * 60_000)
  })

  it('回填不会把旧任务标记为运行中', () => {
    const machine = makeMachine()
    machine.ingest(delta({ ts: Date.now() - 86_400_000 }))
    expect(machine.summary().runningCount).toBe(0)
  })
})

describe('TaskMachine 状态迁移', () => {
  it('超过空闲窗口转为 idle', () => {
    const machine = makeMachine()
    const t0 = Date.now()
    machine.ingest(delta({ ts: t0 }))
    machine.tick(t0 + 100_000)
    expect(machine.list()[0].status).toBe('idle')
  })

  it('结束后 duration 冻结', () => {
    const machine = makeMachine()
    const t0 = Date.now()
    const { taskId } = machine.ingest(delta({ ts: t0 }))
    const task = machine.getTask(taskId)
    expect(task).not.toBeNull()
    machine.endTask(task!, t0 + 120_000)
    machine.tick(t0 + 600_000)
    expect(machine.getTask(taskId)?.durationMs).toBe(120_000)
  })
})

describe('TaskMachine 计费与汇总', () => {
  it('native 数据源按价目表计价', () => {
    const machine = makeMachine()
    machine.ingest(delta({ ts: Date.now(), inputTokens: 1_000_000, outputTokens: 0 }))
    expect(machine.list()[0].costUsd).toBeCloseTo(1, 5)
  })

  it('partial 数据源不产生费用', () => {
    const machine = makeMachine()
    machine.ingest(
      delta({ ts: Date.now(), tokensSource: 'partial', inputTokens: 1_000_000, externalSessionId: 'wb-1' })
    )
    expect(machine.list()[0].costUsd).toBe(0)
  })

  it('「待确认」价目下不产生费用且 costKnown 为 false', () => {
    const machine = new TaskMachine({
      settings: () => SETTINGS,
      pricing: () => [
        { id: 'codex-pending', provider: 'OpenAI', match: 'codex-*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending' },
        { id: 'fallback', provider: '未知', match: '*', inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0, status: 'pending' }
      ]
    })
    machine.ingest(delta({ ts: Date.now(), inputTokens: 1_000_000 }))
    const task = machine.list()[0]
    expect(task.costKnown).toBe(false)
    expect(task.costUsd).toBe(0)
  })

  it('心跳给出早于首个事件的真实开始时间', () => {
    const machine = makeMachine()
    const started = Date.now() - 10 * 60_000
    machine.ingest(
      delta({
        ts: Date.now(),
        startedAtHint: started,
        tokensSource: 'unavailable',
        externalSessionId: 'hb-session'
      })
    )
    const task = machine.list()[0]
    expect(task.startedAt).toBe(started)
    expect(task.durationMs).toBeGreaterThanOrEqual(10 * 60_000)
  })

  it('汇总只统计当天启动的任务', () => {
    const machine = makeMachine()
    machine.ingest(delta({ ts: Date.now() }))
    machine.ingest(delta({ ts: Date.now() - 3 * 86_400_000, dedupeKey: 'old', externalSessionId: 'sess-2' }))
    const summary = machine.summary()
    expect(summary.todayTasks).toBe(1)
    expect(summary.todayInputTokens).toBe(1000)
  })
})
