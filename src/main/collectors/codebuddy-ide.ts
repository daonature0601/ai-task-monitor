import { promises as fsp } from 'node:fs'
import { join, basename } from 'node:path'

/**
 * CodeBuddy IDE（桌面端 / JetBrains 插件）的用量读取。
 *
 * 与 CodeBuddy CLI 不同，IDE **不写 JSONL**：每个会话一个 index.json，
 * 位置在 `CodeBuddyExtension/Data/<账号>/<IDE>/<账号>/history/<wsHash>/<convId>/index.json`，
 * 其中 `requests[]` 的 `usage` 是请求级真实用量。
 *
 * 字段（实测）：
 *   inputTokens        本次请求的 prompt 总量（含缓存命中）
 *   cacheTokens        缓存命中读取
 *   cachedMissTokens   未命中的输入（= inputTokens - cacheTokens）
 *   cachedWriteTokens  缓存写入
 *   outputTokens       输出
 *
 * 标题与项目：
 *   - 标题在 `<history>/<wsHash>/index.json` 的 conversations[].name
 *   - 项目名来自 `genie-history/<base64 路径>/conversations/<convId>` 的目录名
 */

export interface CbIdeUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface CbIdeRequest {
  conversationId: string
  requestId: string
  ts: number
  /** 这一轮结束时间：取下一次请求的起点；最后一条由调用方用文件 mtime 补 */
  endTs: number
  /** 跨副本去重指纹：时间戳 + 四类用量（副本之间逐字重放，指纹相同） */
  fingerprint: string
  usage: CbIdeUsage
}

/** 会话索引文件（含 requests）的位置 */
export interface CbIdeConversation {
  filePath: string
  conversationId: string
  workspaceHash: string
  /** 工作区索引路径，用于取标题 */
  workspaceIndex: string
  mtimeMs: number
}

const SKIP_DIRS = new Set(['messages', 'check-point', 'backups', 'Public', 'assets'])

/** 递归查找 history/<wsHash>/<convId>/index.json */
export async function listCbIdeConversations(root: string): Promise<CbIdeConversation[]> {
  const out: CbIdeConversation[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth < 0) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.name === 'history') {
        // history/<wsHash>/<convId>/index.json
        let workspaces
        try {
          workspaces = await fsp.readdir(full, { withFileTypes: true })
        } catch {
          continue
        }
        for (const ws of workspaces) {
          if (!ws.isDirectory()) continue
          const wsDir = join(full, ws.name)
          const workspaceIndex = join(wsDir, 'index.json')
          let convs
          try {
            convs = await fsp.readdir(wsDir, { withFileTypes: true })
          } catch {
            continue
          }
          for (const conv of convs) {
            if (!conv.isDirectory()) continue
            const filePath = join(wsDir, conv.name, 'index.json')
            try {
              const stat = await fsp.stat(filePath)
              out.push({
                filePath,
                conversationId: conv.name,
                workspaceHash: ws.name,
                workspaceIndex,
                mtimeMs: stat.mtimeMs
              })
            } catch {
              // 没有 index.json 的目录跳过
            }
          }
        }
        continue
      }
      await walk(full, depth - 1)
    }
  }

  await walk(root, 6)
  return out
}

/** 按顺序取第一个 > 0 的数值；全为 0/缺失时返回 0 */
function positive(object: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = num(object[key])
    if (value > 0) return value
  }
  return 0
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 读取一个会话索引中的请求级用量 */
export async function readCbIdeRequests(file: CbIdeConversation): Promise<CbIdeRequest[]> {
  let raw: string
  try {
    raw = await fsp.readFile(file.filePath, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!isRecord(parsed)) return []
  const requests = Array.isArray(parsed.requests) ? parsed.requests : []

  const out: CbIdeRequest[] = []
  let lastTs = 0
  for (const item of requests) {
    if (!isRecord(item)) continue
    const usage = isRecord(item.usage) ? item.usage : null
    if (!usage) continue

    const total = num(usage.inputTokens)
    // 与 workbuddy-switch 一致：优先取**正值**，避免陈旧的 0 掩盖真实命中
    const cacheRead = positive(usage, ['cacheTokens', 'cacheReadInputTokens', 'cache_read_input_tokens'])
    const miss = num(usage.cachedMissTokens)
    const input = miss > 0 ? miss : Math.max(0, total - cacheRead)
    const output = num(usage.outputTokens)
    const cacheWrite = num(usage.cachedWriteTokens)
    if (input + output + cacheRead + cacheWrite === 0) continue

    // 实测有约 29% 的请求没有 startedAt：不能直接丢弃，否则用量凭空少一截。
    // 按顺序沿用上一条请求的时间；整份都没有时间时退到文件 mtime。
    const parsedTs = num(item.startedAt) || num(item.timestamp)
    const ts = parsedTs || lastTs || file.mtimeMs

    const requestId = typeof item.id === 'string' && item.id ? item.id : `${ts}`
    out.push({
      conversationId: file.conversationId,
      requestId,
      ts,
      endTs: 0,
      fingerprint: `${ts}:${input}:${output}:${cacheRead}:${cacheWrite}`,
      usage: { input, output, cacheRead, cacheWrite }
    })
    lastTs = ts
  }
  out.sort((a, b) => a.ts - b.ts)
  // 一次请求的「结束」就是下一次请求的开始
  for (let i = 0; i < out.length - 1; i += 1) out[i].endTs = out[i + 1].ts
  return out
}

/** 工作区索引里的会话标题（name 可能为空） */
export async function readCbIdeTitles(workspaceIndex: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  let raw: string
  try {
    raw = await fsp.readFile(workspaceIndex, 'utf8')
  } catch {
    return map
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return map
  }
  if (!isRecord(parsed)) return map
  const conversations = Array.isArray(parsed.conversations) ? parsed.conversations : []
  for (const conv of conversations) {
    if (!isRecord(conv)) continue
    const id = typeof conv.id === 'string' ? conv.id : ''
    const name = typeof conv.name === 'string' ? conv.name.trim() : ''
    if (id && name) map.set(id, name)
  }
  return map
}

/**
 * genie-history 目录：base64(工作区路径) → conversations/<convId>。
 * 用于把会话归到具体项目。
 */
export async function readCbIdeProjects(genieRoot: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  let entries
  try {
    entries = await fsp.readdir(genieRoot, { withFileTypes: true })
  } catch {
    return map
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const decoded = decodeWorkspace(entry.name)
    if (!decoded) continue
    // 目录名以 __ 补齐，解码后可能带替换字符/不可见字符，这里清掉再取末段
    const clean = decoded.replace(/[\u0000-\u001F\uFFFD]/g, '') 
    const project = basename(clean) || undefined
    if (!project) continue
    let convs
    try {
      convs = await fsp.readdir(join(genieRoot, entry.name, 'conversations'))
    } catch {
      continue
    }
    for (const convId of convs) {
      if (!map.has(convId)) map.set(convId, project)
    }
  }
  return map
}

/** 目录名是 URL-safe base64（`_` 代替 `/`），补 padding 后解码 */
function decodeWorkspace(name: string): string | null {
  const tryDecode = (value: string): string | null => {
    try {
      const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
      const text = Buffer.from(padded, 'base64').toString('utf8').trim()
      if (!text || text.includes('\0') || !text.startsWith('/')) return null
      return text
    } catch {
      return null
    }
  }
  return tryDecode(name) ?? tryDecode(name.replace(/_/g, '/')) ?? tryDecode(name.replace(/_/g, '+'))
}
