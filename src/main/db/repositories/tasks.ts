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

export function listRecentTasks(db: Database.Database, limit = 500): TaskSnapshot[] {
  const rows = db.prepare('SELECT * FROM tasks ORDER BY last_event_at DESC LIMIT ?').all(limit) as TaskRow[]
  return rows.map(rowToSnapshot)
}

export function listOpenTasks(db: Database.Database): TaskSnapshot[] {
  const rows = db
    .prepare("SELECT * FROM tasks WHERE status IN ('running','idle') ORDER BY last_event_at DESC")
    .all() as TaskRow[]
  return rows.map(rowToSnapshot)
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
    where.push('started_at >= @from')
    params.from = query.from
  }
  if (query.to) {
    where.push('started_at <= @to')
    params.to = query.to
  }
  // 与快照保持一致的过滤：零时长的已结束任务不进入列表
  where.push("NOT (status = 'ended' AND COALESCE(turn_ended_at, ended_at, last_event_at, turn_started_at) <= turn_started_at)")

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
                last_event_at DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset }) as TaskRow[]

  return { rows: rows.map(rowToSnapshot), total }
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
