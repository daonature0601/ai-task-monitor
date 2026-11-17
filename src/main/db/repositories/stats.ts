import type Database from 'better-sqlite3'
import type {
  CachePoint,
  DailyPoint,
  MonitorSummary,
  StatsPayload,
  TaskStatus,
  ToolAggregate,
  ToolId,
  TopTaskRow
} from '@shared/types'
import { dayKey } from '@shared/format'

/**
 * 统计口径（重要）：
 * 所有用量类指标（token / 费用 / 缓存命中）都按 **usage_events.ts 事件时间** 归集，
 * 而不是任务的 started_at。否则一个跨天存活的会话会把整段费用算在开始那天，
 * 出现「今天 > 近 30 天」这类不可能的结果。
 * 任务数、时长、状态类指标仍以任务为粒度。
 */
const EVENTS_IN_RANGE = `
  SELECT e.ts AS ts, e.input_tokens AS input_tokens, e.output_tokens AS output_tokens,
         e.cache_read_tokens AS cache_read_tokens, e.cache_write_tokens AS cache_write_tokens,
         e.cost_usd AS cost_usd, e.task_id AS task_id, t.tool AS tool
  FROM usage_events e
  JOIN tasks t ON t.id = e.task_id
  WHERE e.ts >= ? AND e.ts <= ?
`

export function summaryFor(db: Database.Database, from: number, to: number): MonitorSummary {
  const usage = db
    .prepare(
      `WITH ev AS (${EVENTS_IN_RANGE})
       SELECT COUNT(DISTINCT task_id) AS tasks,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cache_write_tokens) AS cache_write_tokens,
              SUM(cost_usd) AS cost_usd
       FROM ev`
    )
    .get(from, to) as {
    tasks: number
    input_tokens: number | null
    output_tokens: number | null
    cache_read_tokens: number | null
    cache_write_tokens: number | null
    cost_usd: number | null
  }

  // 状态是"此刻"的属性，与区间无关
  const open = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status = 'idle' THEN 1 ELSE 0 END) AS idle,
         SUM(CASE WHEN status = 'running' THEN cost_usd ELSE 0 END) AS running_cost
       FROM tasks WHERE status IN ('running','idle')`
    )
    .get() as { running: number | null; idle: number | null; running_cost: number | null }

  const input = usage.input_tokens ?? 0
  const read = usage.cache_read_tokens ?? 0
  const write = usage.cache_write_tokens ?? 0
  const denom = input + read + write

  return {
    runningCount: open.running ?? 0,
    idleCount: open.idle ?? 0,
    todayTasks: usage.tasks ?? 0,
    todayInputTokens: input,
    todayOutputTokens: usage.output_tokens ?? 0,
    todayCacheReadTokens: read,
    todayCostUsd: usage.cost_usd ?? 0,
    avgCacheHitRate: denom > 0 ? read / denom : null,
    runningCostUsd: open.running_cost ?? 0
  }
}

export function dailySeries(db: Database.Database, from: number, to: number): DailyPoint[] {
  const rows = db
    .prepare(
      `WITH ev AS (${EVENTS_IN_RANGE})
       SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
              tool,
              SUM(cost_usd) AS cost
       FROM ev GROUP BY day, tool ORDER BY day ASC`
    )
    .all(from, to) as Array<{ day: string; tool: string; cost: number }>

  const map = new Map<string, DailyPoint>()
  const cursor = new Date(from)
  cursor.setHours(0, 0, 0, 0)
  const end = new Date(to)
  while (cursor.getTime() <= end.getTime()) {
    const key = dayKey(cursor.getTime())
    map.set(key, { date: key, total: 0, byTool: {} })
    cursor.setDate(cursor.getDate() + 1)
  }

  for (const row of rows) {
    const point = map.get(row.day) ?? { date: row.day, total: 0, byTool: {} }
    const tool = row.tool as ToolId
    const cost = row.cost ?? 0
    point.byTool[tool] = (point.byTool[tool] ?? 0) + cost
    point.total += cost
    map.set(row.day, point)
  }

  return Array.from(map.values())
}

export function aggregateByTool(db: Database.Database, from: number, to: number): ToolAggregate[] {
  const rows = db
    .prepare(
      `WITH ev AS (${EVENTS_IN_RANGE})
       SELECT tool,
              COUNT(DISTINCT task_id) AS tasks,
              SUM(cost_usd) AS cost,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read,
              SUM(cache_write_tokens) AS cache_write
       FROM ev GROUP BY tool ORDER BY cost DESC`
    )
    .all(from, to) as Array<{
    tool: string
    tasks: number
    cost: number | null
    input_tokens: number | null
    output_tokens: number | null
    cache_read: number | null
    cache_write: number | null
  }>

  return rows.map((row) => {
    const input = row.input_tokens ?? 0
    const read = row.cache_read ?? 0
    const write = row.cache_write ?? 0
    const denom = input + read + write
    const total = input + (row.output_tokens ?? 0) + read + write
    return {
      tool: row.tool as ToolId,
      tasks: row.tasks,
      costUsd: row.cost ?? 0,
      inputTokens: input,
      outputTokens: row.output_tokens ?? 0,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      cacheHitRate: denom > 0 ? read / denom : null,
      totalTokens: total
    }
  })
}

export function topTasks(
  db: Database.Database,
  from: number,
  to: number,
  limit = 10
): TopTaskRow[] {
  const rows = db
    .prepare(
      `SELECT e.task_id AS id,
              SUM(e.cost_usd) AS cost_usd,
              SUM(e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_write_tokens) AS total_tokens,
              t.title AS title,
              t.tool AS tool,
              t.duration_ms AS duration_ms,
              t.status AS status,
              t.last_event_at AS last_event_at,
              t.ended_at AS ended_at,
              t.turn_started_at AS turn_started_at,
              t.turn_ended_at AS turn_ended_at
       FROM usage_events e
       JOIN tasks t ON t.id = e.task_id
       WHERE e.ts >= ? AND e.ts <= ?
       GROUP BY e.task_id
       ORDER BY cost_usd DESC, total_tokens DESC
       LIMIT ?`
    )
    .all(from, to, limit) as Array<{
    id: string
    cost_usd: number
    total_tokens: number
    title: string | null
    tool: string
    duration_ms: number
    status: string
    last_event_at: number
    ended_at: number | null
    turn_started_at: number | null
    turn_ended_at: number | null
  }>

  return rows.map((row) => ({
    id: row.id,
    title: row.title || row.id.slice(0, 12),
    tool: row.tool as ToolId,
    costUsd: row.cost_usd,
    totalTokens: row.total_tokens,
    durationMs: row.duration_ms,
    status: row.status as TaskStatus,
    lastEventAt: row.last_event_at,
    endedAt: row.ended_at ?? undefined,
    turnStartedAt: row.turn_started_at ?? 0,
    turnEndedAt: row.turn_ended_at ?? undefined
  }))
}

export function cacheTrend(db: Database.Database, from: number, to: number): CachePoint[] {
  const rows = db
    .prepare(
      `WITH ev AS (${EVENTS_IN_RANGE})
       SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
              SUM(cache_read_tokens) AS read_tokens,
              SUM(input_tokens) AS input_tokens,
              SUM(cache_write_tokens) AS write_tokens
       FROM ev GROUP BY day ORDER BY day ASC`
    )
    .all(from, to) as Array<{
    day: string
    read_tokens: number | null
    input_tokens: number | null
    write_tokens: number | null
  }>

  return rows.map((row) => {
    const read = row.read_tokens ?? 0
    const denom = (row.input_tokens ?? 0) + read + (row.write_tokens ?? 0)
    return { date: row.day, rate: denom > 0 ? read / denom : null }
  })
}

const BUCKET_LABELS = ['<1m', '1-5m', '5-15m', '15-30m', '30m-1h', '>1h']

export function durationBuckets(db: Database.Database, from: number, to: number) {
  // 时长是任务属性，按任务开始时间归日
  const row = db
    .prepare(
      // 时长口径与界面一致：以「本轮」实际跨度统计，
      // 运行中的任务冻结在最后一次活动时刻，避免把仍在跑的一轮算成超长分布。
      `SELECT
        SUM(CASE WHEN turn_ms < 60000 THEN 1 ELSE 0 END) AS b0,
        SUM(CASE WHEN turn_ms >= 60000 AND turn_ms < 300000 THEN 1 ELSE 0 END) AS b1,
        SUM(CASE WHEN turn_ms >= 300000 AND turn_ms < 900000 THEN 1 ELSE 0 END) AS b2,
        SUM(CASE WHEN turn_ms >= 900000 AND turn_ms < 1800000 THEN 1 ELSE 0 END) AS b3,
        SUM(CASE WHEN turn_ms >= 1800000 AND turn_ms < 3600000 THEN 1 ELSE 0 END) AS b4,
        SUM(CASE WHEN turn_ms >= 3600000 THEN 1 ELSE 0 END) AS b5
       FROM (
         SELECT MAX(0, COALESCE(turn_ended_at, ended_at, last_event_at, turn_started_at, started_at)
                       - COALESCE(turn_started_at, started_at)) AS turn_ms
         FROM tasks
         WHERE started_at >= ? AND started_at <= ?
       )`
    )
    .get(from, to) as Record<string, number | null>

  return BUCKET_LABELS.map((label, i) => ({ label, count: row[`b${i}`] ?? 0 }))
}

export function buildStats(db: Database.Database, from: number, to: number): StatsPayload {
  return {
    from,
    to,
    totals: summaryFor(db, from, to),
    daily: dailySeries(db, from, to),
    byTool: aggregateByTool(db, from, to),
    topTasks: topTasks(db, from, to, 10),
    cacheTrend: cacheTrend(db, from, to),
    durationBuckets: durationBuckets(db, from, to)
  }
}
