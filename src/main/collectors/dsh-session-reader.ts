import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { decompress } from 'fzstd'

/**
 * DeepSeek Harness 会话读取器。
 *
 * DSH 把每个会话写成一个 zstd 压缩的 JSONL：
 *   ~/.dsh/sessions/<项目 slug>/session-<uuid>/session.v4.jsonl.zstd
 *
 * 首行是会话头（id / createdAt / cwd），其余是按 seq 递增的事件流：
 *   turn/start、turn/end、user/message、assistant/message（含 usage）、session/title …
 *
 * 由于是整块压缩，无法按字节增量追加，只能「整体解压 + 按 seq 去重」。
 */

export interface DshSessionFile {
  sessionId: string
  filePath: string
  /** 项目目录 slug，如 --Users-anxingya-DSH-first-DS-- */
  projectDir: string
  mtimeMs: number
  size: number
}

export interface DshUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface DshSession {
  sessionId: string
  cwd?: string
  createdAt: number
  title?: string
  titleSource?: string
  model?: string
  /** usage 事件：assistant/message 上携带的增量 */
  messages: Array<{ seq: number; time: number; turn?: number; usage: DshUsage }>
  turns: Array<{ kind: 'start' | 'end'; seq: number; time: number; turn?: number; reason?: string }>
  titles: Array<{ seq: number; time: number; title: string; source?: string }>
  /** 会话内出现过的最大 seq，用于增量判断 */
  maxSeq: number
}

const EMPTY_USAGE: DshUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 列出全部会话文件（两级目录，深度固定） */
export async function listDshSessionFiles(root: string): Promise<DshSessionFile[]> {
  let projects
  try {
    projects = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const files: DshSessionFile[] = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let sessions
    try {
      sessions = await fsp.readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const filePath = join(projectDir, session.name, 'session.v4.jsonl.zstd')
      try {
        const stat = await fsp.stat(filePath)
        files.push({
          sessionId: session.name,
          filePath,
          projectDir: project.name,
          mtimeMs: stat.mtimeMs,
          size: stat.size
        })
      } catch {
        // 没有会话文件（仅有 lock）时跳过
      }
    }
  }
  return files
}

/** 解压并解析一个会话文件 */
export function parseDshSession(buffer: Buffer, sessionId: string): DshSession | null {
  let text: string
  try {
    // fzstd 是纯 JS 实现，能一次解开 DSH 追加写入的多个 zstd 帧；
    // Electron 内置的 Node 20 没有 zlib.zstdDecompressSync。
    text = Buffer.from(decompress(new Uint8Array(buffer))).toString('utf8')
  } catch {
    return null
  }

  const session: DshSession = {
    sessionId,
    createdAt: 0,
    messages: [],
    turns: [],
    titles: [],
    maxSeq: 0
  }

  for (const line of text.split('\n')) {
    const raw = line.trim()
    if (!raw) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(raw) as Record<string, unknown>
    } catch {
      continue
    }

    const type = str(event.type)
    const seq = num(event.seq)
    const time = num(event.time)
    const data = isRecord(event.data) ? event.data : {}

    if (type === 'session') {
      session.sessionId = str(event.id) ?? sessionId
      session.cwd = str(event.cwd)
      session.createdAt = num(event.createdAt) || time
      continue
    }

    session.maxSeq = Math.max(session.maxSeq, seq)

    switch (type) {
      case 'request/header': {
        const header = isRecord(data.header) ? data.header : null
        const config = header && isRecord(header.config) ? header.config : null
        const model = config ? str(config.model) : undefined
        if (model) session.model = model
        break
      }
      case 'session/title': {
        const title = str(data.title)
        if (title) {
          session.title = title
          session.titleSource = str(isRecord(data.source) ? data.source.kind : undefined)
          session.titles.push({ seq, time, title, source: session.titleSource })
        }
        break
      }
      case 'turn/start':
        session.turns.push({ kind: 'start', seq, time, turn: num(data.turn) })
        break
      case 'turn/end': {
        const reason = isRecord(data.reason) ? str(data.reason.kind) : undefined
        session.turns.push({ kind: 'end', seq, time, turn: num(data.turn), reason })
        break
      }
      case 'assistant/message': {
        const usage = isRecord(data.usage) ? data.usage : null
        if (!usage) break
        const parsed: DshUsage = {
          inputTokens: num(usage.inputTokens),
          outputTokens: num(usage.outputTokens),
          cacheReadTokens: num(usage.cacheReadTokens),
          cacheWriteTokens: num(usage.cacheWriteTokens)
        }
        if (parsed.inputTokens + parsed.outputTokens + parsed.cacheReadTokens + parsed.cacheWriteTokens === 0) {
          break
        }
        session.messages.push({ seq, time, turn: num(data.turn), usage: parsed })
        break
      }
      default:
        break
    }
  }

  if (!session.createdAt) return null
  return session
}

export { EMPTY_USAGE }
