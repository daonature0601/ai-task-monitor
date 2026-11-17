import type Database from 'better-sqlite3'
import type { UsageEventItem } from '@shared/types'

export interface UsageEventRow {
  taskId: string
  ts: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costUsd: number
  dedupeKey: string
}

const INSERT_SQL = `
INSERT OR IGNORE INTO usage_events
  (task_id, ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, dedupe_key)
VALUES
  (@taskId, @ts, @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens, @reasoningTokens, @costUsd, @dedupeKey)
`

/** 批量幂等写入，返回实际插入条数（重复 dedupeKey 被忽略） */
export function insertUsageEvents(db: Database.Database, rows: UsageEventRow[]): number {
  if (rows.length === 0) return 0
  const stmt = db.prepare(INSERT_SQL)
  // 任务上的 token 是事件流水的聚合结果：只在真正插入成功时累加，
  // 重复 dedupeKey 被 IGNORE 时 changes=0，不会重复计入。
  const bump = db.prepare(`
    UPDATE tasks SET
      input_tokens = input_tokens + @inputTokens,
      output_tokens = output_tokens + @outputTokens,
      cache_read_tokens = cache_read_tokens + @cacheReadTokens,
      cache_write_tokens = cache_write_tokens + @cacheWriteTokens,
      reasoning_tokens = reasoning_tokens + @reasoningTokens,
      event_count = event_count + 1
    WHERE id = @taskId`)
  let inserted = 0
  const tx = db.transaction((list: UsageEventRow[]) => {
    for (const row of list) {
      const info = stmt.run(row)
      if (info.changes > 0) {
        bump.run(row)
        inserted += 1
      }
    }
  })
  tx(rows)
  return inserted
}

export function listEventsForTask(
  db: Database.Database,
  taskId: string,
  limit = 300
): UsageEventItem[] {
  const rows = db
    .prepare(
      `SELECT id, ts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd, dedupe_key
       FROM usage_events WHERE task_id = ? ORDER BY ts DESC LIMIT ?`
    )
    .all(taskId, limit) as Array<{
    id: number
    ts: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    reasoning_tokens: number
    cost_usd: number
    dedupe_key: string
  }>
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    reasoningTokens: r.reasoning_tokens,
    costUsd: r.cost_usd,
    dedupeKey: r.dedupe_key
  }))
}

export function countEventsForTask(db: Database.Database, taskId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM usage_events WHERE task_id = ?').get(taskId) as {
      c: number
    }
  ).c
}
