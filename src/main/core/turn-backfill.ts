import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { appSupportDir, homePath } from '../collectors/paths'
import { listCbIdeConversations, readCbIdeRequests } from '../collectors/codebuddy-ide'
import { parseDshSession } from '../collectors/dsh-session-reader'

/**
 * 轮次重建：从源数据还原「用户输入 → AI 完成」的边界。
 *
 * 之前只按任务的 turn_started_at 补了一条，历史会话永远显示 1 轮。
 * 这里改回读源日志：
 *   CodeBuddy IDE 每条请求 = 一轮
 *   WorkBuddy    user 消息开始，下一条 user 之前结束
 *   DeepSeek     turn/start / turn/end
 *   Codex        task_started / task_complete
 *   Claude Code  type=user 开始，下一条 user 之前结束
 *
 * 读不到的会话回落到任务上保存的本轮边界，保证每个任务至少有一轮。
 */

export const TURNS_VERSION = 32

interface Span {
  tool: string
  sessionId: string
  start: number
  end: number | null
}

/** 只遍历文件名，不读内容：用来把 uuid 映射到具体文件 */
async function walkFiles(root: string, depth: number): Promise<string[]> {
  const out: string[] = []
  const visit = async (dir: string, left: number): Promise<void> => {
    if (left < 0) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        await visit(full, left - 1)
      } else {
        out.push(full)
      }
    }
  }
  await visit(root, depth)
  return out
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  let raw: string
  try {
    const stat = await fsp.stat(path)
    if (stat.size > 128 * 1024 * 1024) return []
    raw = await fsp.readFile(path, 'utf8')
  } catch {
    return []
  }
  const out: Array<Record<string, unknown>> = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>)
    } catch {
      // 半行或坏行跳过
    }
  }
  return out
}

/** 时间戳可能是毫秒数字，也可能是 ISO 字符串（Claude / Codex 混用） */
function tsOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 一串时间点 → 相邻起点构成的轮次；最后一条用 fallbackEnd 收口 */
function fromStarts(starts: number[], fallbackEnd: number | null, tool: string, sessionId: string): Span[] {
  const sorted = starts.filter((ts) => ts > 0).sort((a, b) => a - b)
  // 3 秒内的连续输入算同一次（重发 / 回车抖动），否则会切出没有用量的空轮
  const points: number[] = []
  for (const ts of sorted) {
    if (points.length > 0 && ts - points[points.length - 1] < 3_000) continue
    points.push(ts)
  }
  return points.map((start, index) => ({
    tool,
    sessionId,
    start,
    end: points[index + 1] ?? fallbackEnd
  }))
}

async function codebuddyIdeSpans(): Promise<Span[]> {
  const root = join(appSupportDir(), 'CodeBuddyExtension', 'Data')
  const conversations = await listCbIdeConversations(root)
  const spans: Span[] = []

  // 与 CodeBuddy 自身的显示对齐：一轮 = 一次完成的请求。
  // 被用户意外中断的那些提问不会生成 request，CodeBuddy 里也不显示，这里同样不计。
  for (const conversation of conversations) {
    let raw: string
    try {
      raw = await fsp.readFile(conversation.filePath, 'utf8')
    } catch {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const requests = Array.isArray((parsed as Record<string, unknown>).requests)
      ? ((parsed as Record<string, unknown>).requests as unknown[])
      : []
    // 与 CodeBuddy 对齐：一轮的结束取「下一条请求的起点」，最后一条用文件 mtime。
    // （请求自身只有 startedAt，没有完成时间；实测这样 16:42、16:33 等轮次逐秒一致）
    const points: number[] = []
    for (const item of requests) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const ts = tsOf(record.startedAt) || tsOf(record.timestamp)
      if (!ts) continue
      const usage = record.usage
      const total = usage && typeof usage === 'object'
        ? ['inputTokens', 'outputTokens', 'cacheTokens', 'cachedMissTokens', 'cachedWriteTokens']
            .reduce((sum, key) => sum + (((usage as Record<string, unknown>)[key] as number) || 0), 0)
        : 0
      if (total <= 0) continue
      points.push(ts)
    }
    points.sort((a, b) => a - b)
    // 同一秒内的连续请求（重试 / 分步提交）属于同一次用户输入：
    // 不合并会切成一个几十毫秒的空窗口，那一轮既没有事件也没有用量。
    const merged: number[] = []
    for (const ts of points) {
      if (merged.length > 0 && ts - merged[merged.length - 1] < 3_000) continue
      merged.push(ts)
    }
    for (let index = 0; index < merged.length; index += 1) {
      spans.push({
        tool: 'codebuddy',
        sessionId: conversation.conversationId,
        start: merged[index],
        end: merged[index + 1] ?? conversation.mtimeMs
      })
    }
    continue
    continue
  }

  return spans
}

async function workbuddySpans(sessionIds: Set<string>): Promise<Span[]> {
  const root = join(homePath('.workbuddy'), 'projects')
  const files = await walkFiles(root, 4)
  const spans: Span[] = []
  let matched = 0
  let users = 0
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const stem = basename(file, '.jsonl')
    if (!sessionIds.has(stem)) continue
    matched += 1
    const lines = await readJsonl(file)
    const starts: number[] = []
    const activity: number[] = []
    let last = 0
    for (const line of lines) {
      if (str(line.type) !== 'message') continue
      const ts = tsOf(line.timestamp)
      if (!ts) continue
      last = Math.max(last, ts)
      activity.push(ts)
      if (str(line.role) === 'user') {
        starts.push(ts)
        users += 1
      }
    }

    // 结束时间取「本轮窗口内最后一条消息」：同一会话可能隔天再聊，
    // 直接用下一条用户输入的起点会把上一轮算成好几天。
    const merged = fromStarts(starts, last || null, 'workbuddy', stem)
    for (let index = 0; index < merged.length; index += 1) {
      const span = merged[index]
      const nextStart = merged[index + 1]?.start ?? Number.POSITIVE_INFINITY
      // 相邻输入间隔在 1 小时内：说明这一轮一直在工作，取下一条输入作为结束
      // （与软件显示一致）；跨天的长间隔说明中间没动，收口到本轮最后一条消息
      if (nextStart - span.start <= 3_600_000) {
        spans.push(span)
        continue
      }
      let end = span.start
      for (const ts of activity) {
        if (ts >= span.start && ts < nextStart && ts > end) end = ts
      }
      spans.push({ ...span, end: end > span.start ? end : (span.end ?? null) })
    }
  }
  console.log(`[turns] workbuddy files=${files.length} matched=${matched} users=${users}`)
  return spans
}

async function dshSpans(): Promise<Span[]> {
  const root = join(homePath('.dsh'), 'sessions')
  const files = (await walkFiles(root, 4)).filter((file) => file.endsWith('.zstd'))
  const spans: Span[] = []
  for (const file of files) {
    let buffer: Buffer
    try {
      buffer = await fsp.readFile(file)
    } catch {
      continue
    }
    // 文件名固定是 session.v4.jsonl.zstd，真正的会话 id 在目录名 session-<uuid> 里
    const sessionId = basename(dirname(file))
    const session = parseDshSession(buffer, sessionId)
    if (!session || session.turns.length === 0) continue
    let open: number | null = null
    let lastEvent = 0
    for (const turn of session.turns) {
      lastEvent = Math.max(lastEvent, turn.time)
      if (turn.kind === 'start') open = turn.time
      else if (turn.kind === 'end' && open !== null) {
        spans.push({ tool: 'deepseek-harness', sessionId, start: open, end: turn.time })
        open = null
      }
    }
    if (open !== null) spans.push({ tool: 'deepseek-harness', sessionId, start: open, end: lastEvent || null })
  }
  return spans
}

async function codexSpans(sessionIds: Set<string>): Promise<Span[]> {
  const root = join(homePath('.codex'), 'sessions')
  const files = (await walkFiles(root, 5)).filter((file) => file.endsWith('.jsonl'))

  // 同一会话可能被切成多个 rollout 文件（压缩后续写 / 恢复）。
  // 必须按会话合并后再判轮次：否则某个分段里「只有 task_started、没有用户消息」，
  // 会被当成新的一轮，比软件里显示的多一轮。
  const bySession = new Map<string, { userStarts: number[]; taskStarts: number[]; ends: number[] }>()

  for (const file of files) {
    const match = /rollout-.*-([0-9a-f-]{36})\.jsonl$/.exec(basename(file))
    if (!match) continue
    const sessionId = match[1]
    if (!sessionIds.has(sessionId)) continue
    const lines = await readJsonl(file)
    const bucket = bySession.get(sessionId) ?? { userStarts: [], taskStarts: [], ends: [] }
    bySession.set(sessionId, bucket)

    for (const line of lines) {
      const payload = line.payload
      if (!payload || typeof payload !== 'object') continue
      const record = payload as Record<string, unknown>
      const kind = str(record.type)
      if (str(line.type) === 'event_msg' && (kind === 'task_started' || kind === 'task_complete')) {
        const ts = tsOf(line.timestamp)
        if (ts) (kind === 'task_started' ? bucket.taskStarts : bucket.ends).push(ts)
        continue
      }
      if (str(line.type) !== 'response_item' || kind !== 'message') continue
      if (str(record.role) !== 'user') continue
      const blocks = Array.isArray(record.content) ? record.content : []
      const text = blocks
        .map((block) => (block && typeof block === 'object' ? str((block as Record<string, unknown>).text) : ''))
        .join('')
      if (!text || text.includes('environment_context') || text.includes('<user_instructions>')) continue
      const ts = tsOf(line.timestamp)
      if (ts) bucket.userStarts.push(ts)
    }
  }

  const spans: Span[] = []
  for (const [sessionId, bucket] of bySession) {
    // 用户消息是权威起点；只有整个会话都没有用户消息时才退回 task_started
    const starts = bucket.userStarts.length > 0 ? bucket.userStarts : bucket.taskStarts
    const merged: number[] = []
    for (const ts of [...starts].sort((a, b) => a - b)) {
      if (merged.length > 0 && ts - merged[merged.length - 1] < 3_000) continue
      merged.push(ts)
    }
    const ends = [...bucket.ends].sort((a, b) => a - b)
    for (let index = 0; index < merged.length; index += 1) {
      const start = merged[index]
      const nextStart = merged[index + 1]
      // 这一轮的 task_complete 落在 [start, nextStart) 就用它收口，否则用下一条起点
      const complete = ends.find((ts) => ts >= start && (nextStart === undefined || ts < nextStart))
      spans.push({ tool: 'codex', sessionId, start, end: complete ?? nextStart ?? null })
    }
  }
  return spans
}

async function claudeSpans(sessionIds: Set<string>): Promise<Span[]> {
  const root = join(homePath('.claude'), 'projects')
  const files = (await walkFiles(root, 3)).filter((file) => file.endsWith('.jsonl'))
  const spans: Span[] = []
  for (const file of files) {
    const sessionId = basename(file, '.jsonl')
    if (!sessionIds.has(sessionId)) continue
    const lines = await readJsonl(file)
    const starts: number[] = []
    let last = 0
    for (const line of lines) {
      const ts = tsOf(line.timestamp)
      if (ts) last = Math.max(last, ts)
      if (str(line.type) !== 'user' || !ts) continue
      // 工具调用结果也是 role=user，必须排除 —— 否则一轮会被拆成十几次
      const message = line.message
      const content = message && typeof message === 'object'
        ? (message as Record<string, unknown>).content
        : undefined
      const isToolResult =
        Array.isArray(content) &&
        content.some((block) => block && typeof block === 'object' && str((block as Record<string, unknown>).type) === 'tool_result')
      if (isToolResult || line.isMeta === true) continue
      starts.push(ts)
    }
    spans.push(...fromStarts(starts, last || null, 'claude-code', sessionId))
  }
  return spans
}

interface TaskRow {
  id: string
  tool: string
  external_session_id: string
  turn_started_at: number | null
  turn_ended_at: number | null
  started_at: number
}

/** 重建全部轮次，返回写入行数 */
export async function rebuildTaskTurns(db: Database.Database): Promise<{ spans: number; rows: number }> {
  const tasks = db
    .prepare('SELECT id, tool, external_session_id, turn_started_at, turn_ended_at, started_at FROM tasks')
    .all() as TaskRow[]

  const idsByTool = new Map<string, Set<string>>()
  for (const task of tasks) {
    const set = idsByTool.get(task.tool) ?? new Set<string>()
    set.add(task.external_session_id)
    idsByTool.set(task.tool, set)
  }

  const spans: Span[] = []
  const collectors: Array<() => Promise<Span[]>> = [
    () => codebuddyIdeSpans(),
    () => dshSpans(),
    () => workbuddySpans(idsByTool.get('workbuddy') ?? new Set()),
    () => codexSpans(idsByTool.get('codex') ?? new Set()),
    () => claudeSpans(idsByTool.get('claude-code') ?? new Set())
  ]
  const names = ['codebuddy', 'deepseek-harness', 'workbuddy', 'codex', 'claude-code']
  for (let index = 0; index < collectors.length; index += 1) {
    try {
      const value = await collectors[index]()
      spans.push(...value)
      console.log(`[turns] ${names[index]}: ${value.length} spans`)
    } catch (error) {
      console.error(`[turns] ${names[index]} failed:`, error)
    }
  }

  const spansByKey = new Map<string, Span[]>()
  for (const span of spans) {
    const key = `${span.tool}:${span.sessionId}`
    const list = spansByKey.get(key) ?? []
    list.push(span)
    spansByKey.set(key, list)
  }

  const tasksByKey = new Map<string, TaskRow[]>()
  for (const task of tasks) {
    const key = `${task.tool}:${task.external_session_id}`
    const list = tasksByKey.get(key) ?? []
    list.push(task)
    tasksByKey.set(key, list)
  }
  for (const list of tasksByKey.values()) list.sort((a, b) => a.started_at - b.started_at)

  const insert = db.prepare('INSERT INTO task_turns (task_id, started_at, ended_at) VALUES (?, ?, ?)')
  const touched = new Set<string>()
  /** 每个任务已写入的最大轮次起点，用来补「当前这一轮」 */
  const maxStart = new Map<string, number>()
  let rows = 0
  db.transaction(() => {
    db.prepare('DELETE FROM task_turns').run()

    // 一个会话可能对应多条任务（Codex / Claude 每轮一个任务）：
    // 每段轮次归给「它开始时正在进行的那个任务」，避免同会话的所有轮次
    // 被重复挂到每一条任务上。
    for (const [key, sessionSpans] of spansByKey) {
      const sessionTasks = tasksByKey.get(key)
      if (!sessionTasks || sessionTasks.length === 0) continue
      // 同一会话里可能重复出现相同的起点（子代理副本），先按起点去重
      const uniqueByStart = new Map<number, Span>()
      for (const span of sessionSpans) if (!uniqueByStart.has(span.start)) uniqueByStart.set(span.start, span)
      for (const span of [...uniqueByStart.values()].sort((a, b) => a.start - b.start)) {
        let target = sessionTasks[0]
        for (const task of sessionTasks) {
          if (task.started_at <= span.start) target = task
          else break
        }
        insert.run(target.id, span.start, span.end ?? null)
        touched.add(target.id)
        maxStart.set(target.id, Math.max(maxStart.get(target.id) ?? 0, span.start))
        rows += 1
      }
    }

    // 源数据取不到（子代理、已清理的文件）：回落任务上保存的本轮边界
    for (const task of tasks) {
      if (touched.has(task.id)) continue
      insert.run(task.id, task.turn_started_at ?? task.started_at, task.turn_ended_at ?? null)
      maxStart.set(task.id, task.turn_started_at ?? task.started_at)
      rows += 1
    }
    // 源日志还没落盘的「当前这一轮」：任务行上已经有比所有源轮次更新的起点，
    // 补一条，否则抽屉里上面显示本轮、下面轮次列表却没有这一条。
    for (const task of tasks) {
      const currentStart = task.turn_started_at ?? task.started_at
      if (currentStart <= (maxStart.get(task.id) ?? 0)) continue
      insert.run(task.id, currentStart, task.turn_ended_at ?? null)
      rows += 1
    }
  })()

  return { spans: spans.length, rows }
}
