import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import { dayKey } from '@shared/format'
import type { AdapterCapabilities, ToolId } from '@shared/types'
import type { AdapterContext } from '../base'
import { BaseAdapter, emptyUsage, type DetectResult } from '../base'
import { JsonlTailer, type LineContext } from '../../collectors/jsonl-tailer'
import { TOOL_PATHS, appSupportDir, firstExisting } from '../../collectors/paths'
import { isInstalled } from '../../collectors/process-probe'

/**
 * CodeBuddy 适配器。
 * 数据源：~/.codebuddy/projects/<slug>/<sessionId>.jsonl
 * 行结构：{ id, timestamp(ms), type:"message", role, sessionId, cwd, providerData:{ model, rawUsage } }
 * rawUsage 同时存在两套命名（OpenAI 与字节风格），优先取 prompt/completion + cache_hit/write。
 */
export class CodeBuddyAdapter extends BaseAdapter {
  readonly id: ToolId = 'codebuddy'
  readonly displayName = 'CodeBuddy'
  readonly channel = 'jsonl' as const
  readonly capabilities: AdapterCapabilities = {
    tokens: true,
    liveStream: true,
    bridgeRequired: false
  }

  private tailer: JsonlTailer | null = null
  private activityTimer: NodeJS.Timeout | null = null
  /** 上一轮仍然活跃的对话 id，用于发结束信号 */
  private activeSessions = new Set<string>()
  private readonly models = new Map<string, string>()

  async detect(): Promise<DetectResult> {
    const spec = TOOL_PATHS.codebuddy()
    const path = firstExisting([spec.primary, ...spec.alternates])
    return {
      installed: isInstalled('codebuddy', path),
      dataPath: path,
      message: path ? undefined : '未找到 ~/.codebuddy/projects'
    }
  }

  protected async onStart(ctx: AdapterContext): Promise<void> {
    const root = this.dataPath
    if (root) {
      this.tailer = new JsonlTailer({
        roots: [root],
        glob: '**/*.jsonl',
        depth: 3,
        debounceMs: ctx.settings().fileDebounceMs,
        backfillDays: ctx.settings().backfillDays,
        maxBytesPerRead: 4 * 1024 * 1024,
        cursors: ctx.cursors,
        onLine: (line, meta) => this.handleLine(line, meta),
        onError: (error) => this.fail(error)
      })
      await this.tailer.start()
    }

    // projects/*.jsonl 只在会话落盘时写入；桌面对话没有 token 落盘。
    // 注意：sessions/<pid>.json 是**进程存活心跳**（开着一秒一跳），
    // 用它驱动 running 会造成「对话早已结束仍显示运行 10 小时」的假状态，
    // 因此这里改用扩展日志的写入时间作为真实活动信号。
    const poll = (): void => {
      void this.pollActivity().catch((error) => this.fail(error, '读取会话活动失败'))
    }
    poll()
    this.activityTimer = setInterval(poll, Math.max(3000, ctx.settings().processProbeMs))
    console.log('[adapter:codebuddy] started (jsonl + activity)')
  }

  /**
   * CodeBuddy 桌面端没有 hook，但每个对话会在
   * AppSupport/CodeBuddy CN/User/globalStorage/tencent-cloud.coding-copilot/edit-sessions/
   * 下维护一个 <conversationId>.json，字段 updatedAt 只在真正产生编辑时刷新。
   *
   * 这是会话级的运行时文件，比「应用日志有没有写入」准确得多 ——
   * 后者会把「IDE 开着」误判成「任务在跑」。
   */
  private async pollActivity(): Promise<void> {
    if (!this.ctx || this.ctx.isPaused()) return
    const dir = join(
      appSupportDir(),
      'CodeBuddy CN',
      'User',
      'globalStorage',
      'tencent-cloud.coding-copilot',
      'edit-sessions'
    )

    let names: string[]
    try {
      names = await fsp.readdir(dir)
    } catch {
      return
    }

    const now = Date.now()
    const freshMs = Math.max(this.settings().idleThresholdMs, 120_000)
    const alive = new Set<string>()

    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = join(dir, name)
      let raw: string
      try {
        raw = await fsp.readFile(file, 'utf8')
      } catch {
        continue
      }
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>
      } catch {
        continue
      }
      const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
      const conversationId =
        typeof parsed.conversationId === 'string' ? parsed.conversationId : name.replace(/.json$/, '')
      if (!updatedAt || now - updatedAt > freshMs) continue

      alive.add(conversationId)
      this.emitState({
        tool: this.id,
        sessionId: `cb-${conversationId}`,
        phase: 'active',
        ts: updatedAt,
        source: 'io',
        title: 'CodeBuddy 会话',
        project: 'CodeBuddy',
        startedAtHint: typeof parsed.createdAt === 'number' ? parsed.createdAt : undefined
      })
    }

    // 之前活跃、现在不再更新 → 显式结束，避免一直挂着运行中
    for (const id of this.activeSessions) {
      if (alive.has(id)) continue
      this.emitState({
        tool: this.id,
        sessionId: `cb-${id}`,
        phase: 'end',
        ts: now,
        source: 'io'
      })
    }
    this.activeSessions = alive
  }

  protected async onStop(): Promise<void> {
    await this.tailer?.stop()
    this.tailer = null
    if (this.activityTimer) clearInterval(this.activityTimer)
    this.activityTimer = null
  }

  private handleLine(line: string, meta: LineContext): void {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (obj.type !== 'message') return

    const sessionId =
      str(obj.sessionId) ?? basename(meta.relPath).replace(/\.jsonl$/i, '') ?? meta.relPath
    const cwd = str(obj.cwd)
    const ts = msTimestamp(obj.timestamp) ?? Date.now()
    const provider = isRecord(obj.providerData) ? obj.providerData : null
    const model = provider ? str(provider.model) : undefined
    if (model) this.models.set(sessionId, model)

    const role = str(obj.role)
    if (role === 'user') {
      this.push({
        tool: this.id,
        externalSessionId: sessionId,
        ts,
        title: cwd ? basename(cwd) : undefined,
        workspace: cwd,
        model: this.models.get(sessionId),
        tokensSource: 'native',
        dedupeKey: `meta:${meta.relPath}`,
        ...emptyUsage()
      })
      return
    }
    if (role !== 'assistant') return

    const raw = provider && isRecord(provider.rawUsage) ? provider.rawUsage : null
    if (!raw) return

    const promptTotal = num(raw.prompt_tokens) || num(raw.input_tokens) || num(raw.inputTokens)
    const cacheRead =
      num(raw.prompt_cache_hit_tokens) ||
      num(raw.cache_read_input_tokens) ||
      num(isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details.cached_tokens : 0)
    const cacheWrite =
      num(raw.prompt_cache_write_tokens) || num(raw.cache_creation_input_tokens) || 0
    const output = num(raw.completion_tokens) || num(raw.output_tokens) || num(raw.outputTokens)
    const reasoning =
      num(raw.reasoning_tokens) ||
      num(isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details.reasoning_tokens : 0)

    if (promptTotal + output + cacheRead + cacheWrite === 0) return

    const billableInput = Math.max(0, promptTotal - cacheRead)
    const dedupe =
      str(obj.id) ??
      str(provider && provider.messageId) ??
      `${meta.relPath}:${meta.offset}`

    this.push({
      tool: this.id,
      externalSessionId: sessionId,
      ts,
      title: cwd ? basename(cwd) : undefined,
      workspace: cwd,
      model: model ?? this.models.get(sessionId),
      inputTokens: billableInput,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: reasoning,
      tokensSource: 'native',
      dedupeKey: `msg:${dedupe}`
    })
  }
}

/** 递归取目录内 *.log 的最新修改时间 */
async function walkMaxMtime(dir: string, depth: number): Promise<number> {
  if (depth < 0) return 0
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let max = 0
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      max = Math.max(max, await walkMaxMtime(full, depth - 1))
      continue
    }
    if (!entry.name.endsWith('.log')) continue
    try {
      const stat = await fsp.stat(full)
      max = Math.max(max, stat.mtimeMs)
    } catch {
      // 单文件读取失败忽略
    }
  }
  return max
}

/** CodeBuddy CN 扩展日志的最新写入时间，作为"是否有交互"的信号 */
async function latestLogMtime(): Promise<number | null> {
  const base = join(appSupportDir(), 'CodeBuddy CN', 'logs')
  let entries: string[]
  try {
    entries = await fsp.readdir(base)
  } catch {
    return null
  }
  // 会话目录名是时间戳前缀，字典序即时间序；只看最新两个，控制扫描成本
  const recent = entries.filter((name) => /^\d{8}T\d{6}$/.test(name)).sort().slice(-2)
  let max = 0
  for (const dir of recent) {
    max = Math.max(max, await walkMaxMtime(join(base, dir), 4))
  }
  return max > 0 ? max : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function msTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
