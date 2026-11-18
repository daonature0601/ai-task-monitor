import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import { dayKey } from '@shared/format'
import type { AdapterCapabilities, ToolId } from '@shared/types'
import type { AdapterContext } from '../base'
import { BaseAdapter, emptyUsage, type DetectResult } from '../base'
import { JsonlTailer, type LineContext } from '../../collectors/jsonl-tailer'
import { TOOL_PATHS, appSupportDir, firstExisting } from '../../collectors/paths'
import { isInstalled } from '../../collectors/process-probe'
import {
  listCbIdeConversations,
  readCbIdeModels,
  readCbIdeProjects,
  readCbIdeRequests,
  readCbIdeTitles
} from '../../collectors/codebuddy-ide'

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
  private ideTimer: NodeJS.Timeout | null = null
  /** 会话索引文件 → 上次处理的 mtime，避免重复解压/解析 */
  private readonly ideMtime = new Map<string, number>()
  /** convId → 项目名 */
  private ideProjects = new Map<string, string>()
  private ideProjectsAt = 0
  /** 会话 → 模型（来自插件 message-queue 缓存） */
  private ideModels = new Map<string, string>()
  private ideModelsAt = 0
  /** 已推送过的「会话:模型」，避免每轮扫描重复发事件 */
  private readonly ideModelPushed = new Set<string>()
  /** 已计入的请求指纹：同一会话的多个副本（切号复制）只算一次 */
  private readonly ideFingerprints = new Set<string>()
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
    const scanIde = (): void => {
      void this.scanIde(ctx).catch((error) => this.fail(error, '读取 IDE 会话索引失败'))
    }
    scanIde()
    this.ideTimer = setInterval(scanIde, 30_000)
    console.log('[adapter:codebuddy] started (jsonl + activity + ide-index)')
  }

  /**
   * CodeBuddy IDE（桌面端 / JetBrains 插件）不写 JSONL，用量在
   * CodeBuddyExtension/Data/<账号>/<IDE>/<账号>/history/<ws>/<convId>/index.json
   * 的 requests[].usage。该方法按文件 mtime + 已处理的最大时间戳增量导入。
   */
  private async scanIde(ctx: AdapterContext): Promise<void> {
    if (ctx.isPaused()) return
    const dataRoot = join(appSupportDir(), 'CodeBuddyExtension', 'Data')
    const conversations = await listCbIdeConversations(dataRoot)
    if (conversations.length === 0) return

    // 项目映射变动很少，5 分钟刷新一次
    if (Date.now() - this.ideProjectsAt > 300_000) {
      this.ideProjects = await readCbIdeProjects(
        join(
          appSupportDir(),
          'CodeBuddy CN',
          'User',
          'globalStorage',
          'tencent-cloud.coding-copilot',
          'genie-history'
        )
      )
      this.ideProjectsAt = Date.now()
    }

    // 模型缓存变动频繁（切模型即更新），60 秒刷新一次
    if (Date.now() - this.ideModelsAt > 60_000) {
      this.ideModels = await readCbIdeModels(
        join(
          appSupportDir(),
          'CodeBuddy CN',
          'User',
          'globalStorage',
          'tencent-cloud.coding-copilot',
          'message-queue'
        )
      )
      this.ideModelsAt = Date.now()
    }

    const titlesByWs = new Map<string, Map<string, string>>()

    for (const conversation of conversations) {
      // 标题/项目/模型与用量索引是不同文件，先无条件同步，避免「索引没变就不补模型」
      let titles = titlesByWs.get(conversation.workspaceIndex)
      if (!titles) {
        titles = await readCbIdeTitles(conversation.workspaceIndex)
        titlesByWs.set(conversation.workspaceIndex, titles)
      }

      if (this.ideMtime.get(conversation.filePath) === conversation.mtimeMs) {
        const cachedModel = this.ideModels.get(conversation.conversationId)
        if (cachedModel && !this.ideModelPushed.has(`${conversation.conversationId}:${cachedModel}`)) {
          this.ideModelPushed.add(`${conversation.conversationId}:${cachedModel}`)
          this.push({
            tool: this.id,
            externalSessionId: conversation.conversationId,
            ts: Date.now(),
            title: titles.get(conversation.conversationId),
            project: this.ideProjects.get(conversation.conversationId),
            model: cachedModel,
            authoritativeTitle: true,
            tokensSource: 'unavailable',
            skipEventLog: true,
            dedupeKey: `cbide:model:${conversation.conversationId}:${cachedModel}`,
            ...emptyUsage()
          })
        }
        continue
      }
      this.ideMtime.set(conversation.filePath, conversation.mtimeMs)

      const requests = await readCbIdeRequests(conversation)
      if (requests.length === 0) continue

      // 最后一条请求没有后续请求可参照，用文件 mtime 作为这一轮的结束
      const last = requests[requests.length - 1]
      if (!last.endTs || last.endTs < last.ts) last.endTs = conversation.mtimeMs

      const cursorKey = `cbide:${conversation.filePath}`
      const cursor = ctx.cursors.get(cursorKey)
      // 游标存的是「已处理的最大请求时间」，但历史版本写过文件 mtime（更大），
      // 会导致后续请求全部被判定为「已处理」而永久跳过 —— 这里检测到异常值就重置。
      const maxRequestTs = requests[requests.length - 1].ts
      let since = cursor?.offset ?? 0
      if (since > maxRequestTs) since = 0
      const title = titles.get(conversation.conversationId)
      const project = this.ideProjects.get(conversation.conversationId)
      const model = this.ideModels.get(conversation.conversationId)

      // 模型信息来自插件的 message-queue 缓存，与用量索引不是同一份文件：
      // 解析到新模型时单独推一条元信息事件，把已有任务的模型补上
      if (model) {
        const key = `${conversation.conversationId}:${model}`
        if (!this.ideModelPushed.has(key)) {
          this.ideModelPushed.add(key)
          this.push({
            tool: this.id,
            externalSessionId: conversation.conversationId,
            ts: Date.now(),
            title,
            project,
            model,
            authoritativeTitle: Boolean(title),
            tokensSource: 'unavailable',
            skipEventLog: true,
            dedupeKey: `cbide:model:${key}`,
            ...emptyUsage()
          })
        }
      }

      for (const request of requests) {
        if (request.ts <= since) continue
        // 副本之间逐字重放，指纹相同；跨文件、跨轮扫描都只计一次
        if (this.ideFingerprints.has(request.fingerprint)) continue
        this.ideFingerprints.add(request.fingerprint)
        this.push({
          tool: this.id,
          externalSessionId: conversation.conversationId,
          ts: request.ts,
          title,
          project,
          model,
          authoritativeTitle: Boolean(title),
          inputTokens: request.usage.input,
          outputTokens: request.usage.output,
          cacheReadTokens: request.usage.cacheRead,
          cacheWriteTokens: request.usage.cacheWrite,
          reasoningTokens: 0,
          tokensSource: 'native',
          // IDE 的一次对话就是一个任务，跨天也不拆；
          // 每次请求都是一轮问答，用它刷新「本轮开始」
          keepSession: true,
          turnStart: true,
          dedupeKey: `cbide:${request.fingerprint}`
        })
      }

      // 本轮结束：给最后一条请求补 turnEnd，否则已结束任务的耗时恒为 0
      if (last.endTs > last.ts) {
        this.push({
          tool: this.id,
          externalSessionId: conversation.conversationId,
          ts: last.endTs,
          title,
          project,
          authoritativeTitle: Boolean(title),
          tokensSource: 'unavailable',
          skipEventLog: true,
          turnEnd: true,
          keepSession: true,
          dedupeKey: `cbide:end:${conversation.conversationId}:${last.requestId}`,
          ...emptyUsage()
        })
      }

      if (this.ideFingerprints.size > 200_000) this.ideFingerprints.clear()
      const maxTs = Math.max(requests[requests.length - 1].ts, last.endTs)
      // 只记录请求自身的时间：用文件 mtime 会把「之后写入的请求」误判为已处理
      ctx.cursors.set(cursorKey, Math.max(requests[requests.length - 1].ts, since), null, conversation.mtimeMs)
    }
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
        sessionId: conversationId,
        phase: 'active',
        ts: updatedAt,
        source: 'io',
        // IDE 的一次对话就是一个任务：中间停顿多久都不拆
        keepSession: true,
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
        sessionId: id,
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
    if (this.ideTimer) clearInterval(this.ideTimer)
    this.ideTimer = null
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
