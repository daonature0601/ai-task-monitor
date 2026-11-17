import type Database from 'better-sqlite3'
import type { PricingRow, UsageDelta } from '@shared/types'
import { upsertTasks } from '../db/repositories/tasks'
import { insertUsageEvents, type UsageEventRow } from '../db/repositories/usage'
import { computeCost, matchPrice } from './pricing'
import type { TaskMachine } from './task-machine'

const MAX_QUEUE = 8000

/**
 * 批量写入器：事件先入内存队列，每 1s 或满 200 条落库，
 * 降低 WAL 抖动；任务主表按脏标记增量更新。
 */
export class BatchWriter {
  private queue: UsageEventRow[] = []
  private lastFlushAt = 0
  private insertedTotal = 0

  constructor(
    private readonly db: () => Database.Database | null,
    private readonly machine: TaskMachine,
    private readonly pricing: () => PricingRow[]
  ) {}

  enqueue(taskId: string, delta: UsageDelta, resolvedModel?: string): void {
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.splice(0, Math.floor(MAX_QUEUE / 4))
    }
    // Codex 首轮事件往往还没读到模型名，用任务当前模型兜底，避免事件被计成 0 费用
    const price = matchPrice(resolvedModel ?? delta.model, this.pricing())
    // 与任务主表口径一致：价目未核实时事件费用也记 0（界面不展示金额）
    const billable =
      (delta.tokensSource === 'native' || delta.tokensSource === 'bridge') && !price.pending
    this.queue.push({
      taskId,
      ts: delta.ts,
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      cacheReadTokens: delta.cacheReadTokens,
      cacheWriteTokens: delta.cacheWriteTokens,
      reasoningTokens: delta.reasoningTokens,
      costUsd: billable ? computeCost(delta, price.row) : 0,
      dedupeKey: delta.dedupeKey
    })
  }

  /** 返回本次写入的事件条数与任务条数 */
  flush(force = false): { events: number; tasks: number } {
    const now = Date.now()
    const due = force || this.queue.length >= 200 || now - this.lastFlushAt >= 1000
    if (!due) return { events: 0, tasks: 0 }

    const db = this.db()
    if (!db) return { events: 0, tasks: 0 }
    this.lastFlushAt = now

    let events = 0
    const pending = this.queue
    this.queue = []
    let taskCount = 0
    try {
      // 顺序不可颠倒：usage_events 外键引用 tasks，必须先落任务主表
      const dirty = this.machine.drainDirty()
      if (dirty.length > 0) {
        upsertTasks(db, dirty)
        taskCount = dirty.length
      }
      if (pending.length > 0) {
        events = insertUsageEvents(db, pending)
        this.insertedTotal += events
      }
      return { events, tasks: taskCount }
    } catch (error) {
      console.error('[writer] flush failed', error)
      return { events: 0, tasks: 0 }
    }
  }

  get pending(): number {
    return this.queue.length
  }

  get totalInserted(): number {
    return this.insertedTotal
  }

  clear(): void {
    this.queue = []
  }
}
