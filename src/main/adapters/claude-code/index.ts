import { basename } from 'node:path'
import type { AdapterCapabilities, ToolId } from '@shared/types'
import type { AdapterContext } from '../base'
import { BaseAdapter, emptyUsage, type DetectResult } from '../base'
import { JsonlTailer, type LineContext } from '../../collectors/jsonl-tailer'
import { TOOL_PATHS, firstExisting } from '../../collectors/paths'
import { isInstalled } from '../../collectors/process-probe'

interface ClaudeSessionMeta {
  sessionId: string
  cwd?: string
  model?: string
  startedAt: number
  seenFirstTurn: boolean
}

/**
 * Claude Code 适配器。
 * 数据源：~/.claude/projects/<dash-encoded-cwd>/<session-uuid>.jsonl
 * - 每行一条事件，type=assistant 的 message.usage 为"每轮增量"，需逐行累加
 * - Anthropic 的 input_tokens 不含缓存读写，cache_read / cache_creation 单独计费
 * - 去重键优先 message.id（同一消息可能因流式写入出现多行）
 */
export class ClaudeCodeAdapter extends BaseAdapter {
  readonly id: ToolId = 'claude-code'
  readonly displayName = 'Claude Code'
  readonly channel = 'jsonl' as const
  readonly capabilities: AdapterCapabilities = {
    tokens: true,
    liveStream: true,
    bridgeRequired: false
  }

  /** relPath → 上次 io 心跳的 30s 桶 */
  private readonly ioBucket = new Map<string, number>()
  private tailer: JsonlTailer | null = null
  private readonly sessions = new Map<string, ClaudeSessionMeta>()

  async detect(): Promise<DetectResult> {
    const spec = TOOL_PATHS.claudeCode()
    const path = firstExisting([spec.primary, ...spec.alternates])
    return {
      installed: isInstalled('claude-code', path),
      dataPath: path,
      message: path ? undefined : '未找到 ~/.claude/projects'
    }
  }

  protected async onStart(ctx: AdapterContext): Promise<void> {
    const root = this.dataPath
    if (!root) return
    this.tailer = new JsonlTailer({
      roots: [root],
      glob: '**/*.jsonl',
      depth: 4,
      debounceMs: ctx.settings().fileDebounceMs,
      backfillDays: ctx.settings().backfillDays,
      maxBytesPerRead: 4 * 1024 * 1024,
      cursors: ctx.cursors,
      onLine: (line, meta) => this.handleLine(line, meta),
      onError: (error) => this.fail(error)
    })
    await this.tailer.start()
    console.log('[adapter:claude-code] started')
  }

  protected async onStop(): Promise<void> {
    await this.tailer?.stop()
    this.tailer = null
  }

  /** 文件仍在追加 = 该会话正在工作（运行时 IO 观测，不解析内容） */
  private markIo(sessionId: string, meta: LineContext, cwd?: string): void {
    if (Date.now() - meta.mtimeMs > 180_000) return
    const bucket = Math.floor(Date.now() / 30_000)
    if (this.ioBucket.get(meta.relPath) === bucket) return
    this.ioBucket.set(meta.relPath, bucket)
    this.emitState({
      tool: this.id,
      sessionId,
      phase: 'active',
      ts: Date.now(),
      source: 'io',
      workspace: cwd
    })
  }

  private handleLine(line: string, meta: LineContext): void {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (obj.type !== 'assistant') return

    const message = isRecord(obj.message) ? obj.message : null
    if (!message) return
    const usage = isRecord(message.usage) ? message.usage : null
    if (!usage) return

    const cwd = typeof obj.cwd === 'string' ? obj.cwd : undefined
    const sessionId =
      (typeof obj.sessionId === 'string' && obj.sessionId) ||
      sessionIdFromFile(meta.relPath) ||
      meta.relPath

    this.markIo(sessionId, meta, cwd)
    const metaInfo = this.ensureSession(meta.relPath, sessionId, cwd, obj, message)

    const input = num(usage.input_tokens)
    const output = num(usage.output_tokens)
    const cacheRead = num(usage.cache_read_input_tokens)
    const cacheWrite = num(usage.cache_creation_input_tokens)
    if (input + output + cacheRead + cacheWrite === 0) return

    const messageId =
      typeof message.id === 'string' && message.id
        ? message.id
        : typeof obj.uuid === 'string' && obj.uuid
          ? obj.uuid
          : `${meta.relPath}:${meta.offset}`

    this.push({
      tool: this.id,
      externalSessionId: sessionId,
      ts: parseTs(obj.timestamp) ?? Date.now(),
      title: cwd ? basename(cwd) : undefined,
      workspace: cwd,
      model: typeof message.model === 'string' ? message.model : metaInfo.model,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: 0,
      tokensSource: 'native',
      dedupeKey: `msg:${messageId}`
    })
  }

  private ensureSession(
    relPath: string,
    sessionId: string,
    cwd: string | undefined,
    obj: Record<string, unknown>,
    message: Record<string, unknown>
  ): ClaudeSessionMeta {
    let meta = this.sessions.get(relPath)
    if (!meta) {
      meta = {
        sessionId,
        cwd,
        model: typeof message.model === 'string' ? message.model : undefined,
        startedAt: parseTs(obj.timestamp) ?? Date.now(),
        seenFirstTurn: false
      }
      this.sessions.set(relPath, meta)

      // 首轮事件额外落一条零用量元数据，确保任务先于 token 出现（并记录起始时间）
      this.push({
        tool: this.id,
        externalSessionId: sessionId,
        ts: meta.startedAt,
        title: cwd ? basename(cwd) : undefined,
        workspace: cwd,
        model: meta.model,
        tokensSource: 'native',
        dedupeKey: `meta:${relPath}`,
        ...emptyUsage()
      })
    } else {
      if (cwd && !meta.cwd) meta.cwd = cwd
      if (typeof message.model === 'string' && message.model) meta.model = message.model
    }
    return meta
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function parseTs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ts = Date.parse(value)
  return Number.isFinite(ts) ? ts : null
}

function sessionIdFromFile(relPath: string): string | null {
  const name = basename(relPath)
  const match = name.match(/^([0-9a-f-]{16,})\.jsonl$/i)
  return match ? match[1] : null
}
