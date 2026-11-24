import type Database from 'better-sqlite3'
import type { TaskQuery, TaskSnapshot, ToolId } from '@shared/types'
import { computeCacheHitRate } from '@shared/format'
import type { AlertKind } from '@shared/types'

export interface TaskRow {
  id: string
  tool: string
  external_session_id: string
  title: string | null
  workspace: string | null
  model: string | null
  status: string
  started_at: number
  last_event_at: number
  ended_at: number | null
  duration_ms: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  cost_usd: number
  cost_known: number
  state_source: string
  last_state_at: number | null
  turn_started_at: number | null
  project: string | null
  turn_ended_at: number | null
  tokens_source: string
  event_count: number
  updated_at: number
}

export function rowToSnapshot(row: TaskRow): TaskSnapshot {
  const cacheHitRate = computeCacheHitRate({
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens
  })
  return {
    id: row.id,
    tool: row.tool as ToolId,
    externalSessionId: row.external_session_id,
    title: row.title || row.external_session_id.slice(0, 8),
    workspace: row.workspace || undefined,
    model: row.model || undefined,
    status: (row.status as TaskSnapshot['status']) || 'ended',
    startedAt: row.started_at,
    lastEventAt: row.last_event_at,
    endedAt: row.ended_at ?? undefined,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    costUsd: row.cost_usd,
    costKnown: row.cost_known === 1,
    stateSource: (row.state_source as TaskSnapshot['stateSource']) ?? 'none',
    lastStateAt: row.last_state_at ?? null,
    turnStartedAt: row.turn_started_at ?? row.started_at,
    turnInputTokens: row.input_tokens,
    turnOutputTokens: row.output_tokens,
    turnCacheReadTokens: row.cache_read_tokens,
    turnCacheWriteTokens: row.cache_write_tokens,
    turnCostUsd: row.cost_usd,
    project: row.project ?? undefined,
    turnEndedAt: row.turn_ended_at ?? undefined,
    cacheHitRate,
    tokensSource: (row.tokens_source as TaskSnapshot['tokensSource']) || 'unavailable',
    eventCount: row.event_count,
    alerts: [] as AlertKind[]
  }
}

const UPSERT_SQL = `
INSERT INTO tasks (
  id, tool, external_session_id, title, workspace, model, status,
  started_at, last_event_at, ended_at, duration_ms,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
  cost_usd, cost_known, state_source, last_state_at, turn_started_at, turn_ended_at, project, tokens_source, event_count, updated_at
) VALUES (
  @id, @tool, @externalSessionId, @title, @workspace, @model, @status,
  @startedAt, @lastEventAt, @endedAt, @durationMs,
  @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens, @reasoningTokens,
  @costUsd, @costKnown, @stateSource, @lastStateAt, @turnStartedAt, @turnEndedAt, @project, @tokensSource, @eventCount, @updatedAt
)
ON CONFLICT(id) DO UPDATE SET
  title = COALESCE(excluded.title, tasks.title),
  workspace = COALESCE(excluded.workspace, tasks.workspace),
  model = COALESCE(excluded.model, tasks.model),
  status = excluded.status,
  last_event_at = MAX(excluded.last_event_at, tasks.last_event_at),
  ended_at = COALESCE(excluded.ended_at, tasks.ended_at),
  duration_ms = excluded.duration_ms,
  cost_usd = excluded.cost_usd,
  cost_known = excluded.cost_known,
  state_source = excluded.state_source,
  last_state_at = excluded.last_state_at,
  turn_started_at = excluded.turn_started_at,
  turn_ended_at = excluded.turn_ended_at,
  project = COALESCE(excluded.project, tasks.project),
  tokens_source = CASE
    WHEN excluded.tokens_source = 'native' OR excluded.tokens_source = 'bridge' THEN excluded.tokens_source
    WHEN tasks.tokens_source IN ('native', 'bridge') THEN tasks.tokens_source
    ELSE excluded.tokens_source
  END,
  updated_at = excluded.updated_at
`

function toParams(task: TaskSnapshot): Record<string, unknown> {
  return {
    id: task.id,
    tool: task.tool,
    externalSessionId: task.externalSessionId,
    title: task.title || null,
    workspace: task.workspace || null,
    model: task.model || null,
    status: task.status,
    startedAt: task.startedAt,
    lastEventAt: task.lastEventAt,
    endedAt: task.endedAt ?? null,
    durationMs: task.durationMs,
    // token 由 usage_events 聚合，新建行先置 0，随后由事件增量累加
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: task.costUsd,
    costKnown: task.costKnown ? 1 : 0,
    stateSource: task.stateSource,
    lastStateAt: task.lastStateAt ?? null,
    turnStartedAt: task.turnStartedAt,
    turnEndedAt: task.turnEndedAt ?? null,
    project: task.project ?? null,
    tokensSource: task.tokensSource,
    eventCount: 0,
    updatedAt: Date.now()
  }
}

export function upsertTasks(db: Database.Database, tasks: TaskSnapshot[]): void {
  if (tasks.length === 0) return
  const stmt = db.prepare(UPSERT_SQL)
  const tx = db.transaction((list: TaskSnapshot[]) => {
    for (const task of list) stmt.run(toParams(task))
  })
  tx(tasks)
}

export function getTaskRow(db: Database.Database, id: string): TaskRow | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  return row ?? null
}


/**
 * 列表展示的是「本轮」用量：只统计 turn_started_at 之后写入的事件。
 * 任务的会话累计值仍在 tasks 表里，详情抽屉使用它。
 */
export function attachTurnStats(db: Database.Database, rows: TaskSnapshot[]): TaskSnapshot[] {
  if (rows.length === 0) return rows

  // 与轮次表对齐：列表、卡片、详情都取「最新一轮」这一行，
  // 不能一个用 turn_started_at、一个用 task_turns 首行 —— 源日志滞后时会分成两轮。
  const latestTurn = db.prepare(
    // 同一秒内可能有两条轮次（重试产生），优先取真正有用量的那条，
    // 否则列表会挑到那个 0 事件的空窗口，显示成 0 in / 0 out。
    `SELECT started_at, ended_at
       FROM task_turns tt
      WHERE tt.task_id = ?
      ORDER BY EXISTS (
                 SELECT 1 FROM usage_events e
                  WHERE e.task_id = tt.task_id
                    AND e.ts >= tt.started_at
                    AND e.ts < COALESCE(tt.ended_at, 9223372036854775807)
               ) DESC,
               tt.started_at DESC
      LIMIT 1`
  )
  const latestUsage = db.prepare(
    `SELECT COALESCE(SUM(e.input_tokens), 0) AS i,
            COALESCE(SUM(e.output_tokens), 0) AS o,
            COALESCE(SUM(e.cache_read_tokens), 0) AS r,
            COALESCE(SUM(e.cache_write_tokens), 0) AS w,
            COALESCE(SUM(e.cost_usd), 0) AS c
       FROM usage_events e
      WHERE e.task_id = ? AND e.ts >= ? AND e.ts < ?`
  )
  // 没有轮次行的历史任务，回落到任务上保存的本轮边界
  const fallbackUsage = db.prepare(
    `SELECT COALESCE(SUM(e.input_tokens), 0) AS i,
            COALESCE(SUM(e.output_tokens), 0) AS o,
            COALESCE(SUM(e.cache_read_tokens), 0) AS r,
            COALESCE(SUM(e.cache_write_tokens), 0) AS w,
            COALESCE(SUM(e.cost_usd), 0) AS c
       FROM usage_events e JOIN tasks t ON t.id = e.task_id
      WHERE e.task_id = ? AND e.ts >= COALESCE(t.turn_started_at, 0)`
  )
  const MAX = 9223372036854775807

  for (const row of rows) {
    const turn = latestTurn.get(row.id) as { started_at: number; ended_at: number | null } | undefined
    if (turn) {
      row.turnStartedAt = turn.started_at
      // 轮次还没闭合时保留任务上的本轮结束时间，别清成 undefined —— 
      // 否则回落到较早的 endedAt，耗时算成 0
      row.turnEndedAt = turn.ended_at ?? row.turnEndedAt
    }
    const start = turn?.started_at ?? row.turnStartedAt
    const agg = (turn
      ? latestUsage.get(row.id, start, turn.ended_at ?? MAX)
      : fallbackUsage.get(row.id)) as
      | { i: number; o: number; r: number; w: number; c: number }
      | undefined
    if (!agg) continue
    row.turnInputTokens = agg.i
    row.turnOutputTokens = agg.o
    row.turnCacheReadTokens = agg.r
    row.turnCacheWriteTokens = agg.w
    row.turnCostUsd = agg.c
  }
  return rows
}

export function listRecentTasks(db: Database.Database, limit = 500): TaskSnapshot[] {
  const rows = db.prepare('SELECT * FROM tasks ORDER BY last_event_at DESC LIMIT ?').all(limit) as TaskRow[]
  return attachTurnStats(db, rows.map(rowToSnapshot))
}

export function listOpenTasks(db: Database.Database): TaskSnapshot[] {
  const rows = db
    .prepare("SELECT * FROM tasks WHERE status IN ('running','idle') ORDER BY last_event_at DESC")
    .all() as TaskRow[]
  return attachTurnStats(db, rows.map(rowToSnapshot))
}

export function queryTasks(
  db: Database.Database,
  query: TaskQuery
): { rows: TaskSnapshot[]; total: number } {
  const where: string[] = ['1 = 1']
  const params: Record<string, unknown> = {}

  if (query.tools && query.tools.length > 0) {
    const keys = query.tools.map((_, i) => `@tool${i}`)
    where.push(`tool IN (${keys.join(', ')})`)
    query.tools.forEach((tool, i) => {
      params[`tool${i}`] = tool
    })
  }
  if (query.statuses && query.statuses.length > 0) {
    const keys = query.statuses.map((_, i) => `@status${i}`)
    where.push(`status IN (${keys.join(', ')})`)
    query.statuses.forEach((status, i) => {
      params[`status${i}`] = status
    })
  }
  if (query.from) {
    // 时间筛选与列表展示的「本轮开始」保持同一口径：
    // 只按会话起点过滤，会让「今天开始的一轮、昨天开的会话」漏掉
    where.push('COALESCE(turn_started_at, started_at) >= @from')
    params.from = query.from
  }
  if (query.to) {
    where.push('COALESCE(turn_started_at, started_at) <= @to')
    params.to = query.to
  }
  // 与快照保持一致的过滤：零时长的已结束任务不进入列表
  where.push("NOT (status = 'ended' AND COALESCE(turn_ended_at, ended_at, last_event_at, turn_started_at) <= turn_started_at)")
  // 只有标题、没有任何用量事件的已结束会话不进入列表
  // 已结束且四类 token 全为 0 的任务（空回合、只有开始信号）同样不进入列表，
  // 与快照层 isEmptyRound 的口径一致
  where.push("NOT (status = 'ended' AND input_tokens = 0 AND output_tokens = 0 AND cache_read_tokens = 0 AND cache_write_tokens = 0)")

  if (query.keyword && query.keyword.trim()) {
    where.push('(title LIKE @kw OR project LIKE @kw OR workspace LIKE @kw OR model LIKE @kw OR external_session_id LIKE @kw)')
    params.kw = `%${query.keyword.trim()}%`
  }

  const whereSql = where.join(' AND ')
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE ${whereSql}`).get(params) as { c: number }
  ).c

  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000)
  const offset = Math.max(query.offset ?? 0, 0)
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE ${whereSql}
       ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'idle' THEN 1 ELSE 2 END,
                COALESCE(turn_started_at, started_at) DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset }) as TaskRow[]

  return { rows: attachTurnStats(db, rows.map(rowToSnapshot)), total }
}

export function markStaleTasksEnded(db: Database.Database, now = Date.now()): number {
  const info = db
    .prepare(
      `UPDATE tasks
       SET status = 'ended',
           ended_at = COALESCE(ended_at, last_event_at),
           duration_ms = MAX(0, COALESCE(ended_at, last_event_at) - started_at),
           updated_at = @now
       WHERE status IN ('running','idle')`
    )
    .run({ now })
  return info.changes
}

export function deleteTasksBefore(db: Database.Database, cutoff: number): number {
  const info = db.prepare('DELETE FROM tasks WHERE started_at < ? AND status = ?').run(cutoff, 'ended')
  return info.changes
}

export function countTasks(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c
}

export function distinctTools(db: Database.Database): ToolId[] {
  const rows = db.prepare('SELECT DISTINCT tool FROM tasks').all() as Array<{ tool: string }>
  return rows.map((r) => r.tool as ToolId)
}
