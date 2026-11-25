import { promises as fsp, closeSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import type { AdapterCapabilities, ToolId } from '@shared/types'
import type { AdapterContext } from '../base'
import { BaseAdapter, emptyUsage, type DetectResult } from '../base'
import { JsonlTailer, readAllLines, type LineContext } from '../../collectors/jsonl-tailer'
import { TOOL_PATHS, firstExisting } from '../../collectors/paths'
import { isInstalled } from '../../collectors/process-probe'

interface SessionMeta {
  sessionId: string
  cwd?: string
  model?: string
  provider?: string
}

interface CodexTotals {
  input: number
  cached: number
  output: number
}

/**
 * Codex（CLI + Desktop）适配器。
 * 数据源：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * - session_meta 建立任务并取 cwd / 模型
 * - event_msg(token_count) 提供 last_token_usage 增量（total_token_usage 为累计值，仅在缺失时差分）
 * - Codex 的 input_tokens 含 cached_input_tokens，计费时需拆分为"新增输入"与"缓存读"
 */
export class CodexAdapter extends BaseAdapter {
  readonly id: ToolId = 'codex'
  readonly displayName = 'Codex'
  readonly channel = 'jsonl' as const
  readonly capabilities: AdapterCapabilities = {
    tokens: true,
    liveStream: true,
    bridgeRequired: false
  }

  private tailer: JsonlTailer | null = null
  /** relPath → 上次 io 心跳的 30s 桶，避免每次追加都发信号 */
  private readonly ioBucket = new Map<string, number>()
  /** session_index.jsonl 的线程展示名：id → thread_name */
  private readonly threadTitles = new Map<string, string>()
  private titleTimer: NodeJS.Timeout | null = null
  private lastIndexMtime = 0
  private readonly sessions = new Map<string, SessionMeta>()
  private readonly totals = new Map<string, CodexTotals>()
  /** guardian_review 线程：内部审查，不计入任务 */
  private readonly skipped = new Set<string>()
  /** 文件 → 父线程 id（子代理归并用） */
  private readonly parents = new Map<string, string | null>()

  async detect(): Promise<DetectResult> {
    const spec = TOOL_PATHS.codex()
    const path = firstExisting([spec.primary, ...spec.alternates])
    return {
      installed: isInstalled('codex', path),
      dataPath: path,
      message: path ? undefined : '未找到 ~/.codex/sessions'
    }
  }

  protected async onStart(ctx: AdapterContext): Promise<void> {
    const root = this.dataPath
    if (!root) return
    this.tailer = new JsonlTailer({
      roots: [root],
      glob: '**/rollout-*.jsonl',
      depth: 6,
      debounceMs: ctx.settings().fileDebounceMs,
      backfillDays: ctx.settings().backfillDays,
      maxBytesPerRead: 4 * 1024 * 1024,
      cursors: ctx.cursors,
      onLine: (line, meta) => this.handleLine(line, meta),
      onError: (error) => this.fail(error)
    })
    // 先加载线程展示名，保证第一条事件就带正确的任务名
    await this.loadThreadTitles()
    this.titleTimer = setInterval(() => {
      void this.loadThreadTitles().catch(() => undefined)
    }, 15_000)

    await this.tailer.start()
    void this.primeMeta(root)
    console.log('[adapter:codex] started')
  }

  /**
   * 启动时补读历史会话元信息。
   * 游标已到 EOF 的文件不会再产生行事件，若不主动回读文件头，
   * 这些任务就只剩「会话 xxxx」这种无语义标题、且缺工作区与模型。
   */
  private async primeMeta(root: string): Promise<void> {
    const cutoff = Date.now() - 7 * 86_400_000
    const files: Array<{ filePath: string; relPath: string }> = []
    const stack = [root]
    while (stack.length > 0 && files.length < 300) {
      const dir = stack.pop() as string
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
          continue
        }
        if (!entry.name.endsWith('.jsonl')) continue
        try {
          const stat = await fsp.stat(full)
          if (stat.mtimeMs >= cutoff) files.push({ filePath: full, relPath: relative(root, full) })
        } catch {
          // 忽略单个文件的读取失败
        }
      }
    }

    for (const file of files) {
      if (this.sessions.has(file.relPath)) continue
      await this.loadMetaFromFile(file)
    }
    console.log(`[adapter:codex] primed meta for ${files.length} session files`)
  }

  private async loadMetaFromFile(file: { filePath: string; relPath: string }): Promise<void> {
    try {
      const lines = await readAllLines(file.filePath, 32 * 1024)
      let cwdOffset = 0
      for (const line of lines) {
        cwdOffset += 1
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (obj.type !== 'session_meta') continue
        const payload = isRecord(obj.payload) ? obj.payload : null
        if (payload) {
          this.handleSessionMeta(payload, {
            filePath: file.filePath,
            relPath: file.relPath,
            offset: cwdOffset,
            mtimeMs: 0
          })
        }
        return
      }
    } catch (error) {
      console.error('[adapter:codex] prime meta failed', file.relPath, error)
    }
  }

  protected async onStop(): Promise<void> {
    await this.tailer?.stop()
    this.tailer = null
    if (this.titleTimer) clearInterval(this.titleTimer)
    this.titleTimer = null
  }

  /** 会话展示名：优先 Codex 侧边栏的 thread_name，回退到工作目录名 */
  private titleFor(session: SessionMeta): string | undefined {
    const fromIndex = this.threadTitles.get(session.sessionId)
    if (fromIndex && fromIndex.trim()) return fromIndex.trim()
    return session.cwd ? basename(session.cwd) : undefined
  }

  /** 所属项目名：取工作目录末段（Codex 侧边栏按项目分组的就是它） */
  private projectFor(session: SessionMeta): string | undefined {
    if (!session.cwd) return undefined
    const seg = session.cwd.split('/').filter(Boolean).pop()
    return seg || undefined
  }

  /**
   * 读取 ~/.codex/session_index.jsonl（id → thread_name），
   * 这是 Codex 桌面端侧边栏里显示的会话名，也是任务名的权威来源。
   * 文件不大但会持续追加，按 mtime 变化重载即可。
   */
  private async loadThreadTitles(): Promise<void> {
    const file = join(homedir(), '.codex', 'session_index.jsonl')
    let stat
    try {
      stat = await fsp.stat(file)
    } catch {
      return
    }
    if (this.lastIndexMtime === stat.mtimeMs) return
    this.lastIndexMtime = stat.mtimeMs

    let raw: string
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch {
      return
    }
    const changed: string[] = []
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (!text) continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(text) as Record<string, unknown>
      } catch {
        continue
      }
      const id = typeof obj.id === 'string' ? obj.id : ''
      const name = typeof obj.thread_name === 'string' ? obj.thread_name : ''
      if (!id || !name) continue
      if (this.threadTitles.get(id) !== name) {
        this.threadTitles.set(id, name)
        changed.push(id)
      }
    }

    // 标题被重命名时，即便会话已静默也要把新名字同步到任务上
    if (changed.length === 0) return
    for (const session of this.sessions.values()) {
      if (!changed.includes(session.sessionId)) continue
      this.push({
        tool: this.id,
        externalSessionId: session.sessionId,
        ts: Date.now(),
        title: this.titleFor(session),
        workspace: session.cwd,
        project: this.projectFor(session),
        authoritativeTitle: true,
        tokensSource: 'unavailable',
        skipEventLog: true,
        dedupeKey: `title:${session.sessionId}:${this.threadTitles.get(session.sessionId)}`,
        ...emptyUsage()
      })
    }
  }

  private handleLine(line: string, meta: LineContext): void {
    if (this.skipped.has(meta.relPath)) return
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const type = typeof obj.type === 'string' ? obj.type : ''
    const payload = isRecord(obj.payload) ? obj.payload : null

    if (type === 'session_meta' && payload) {
      this.handleSessionMeta(payload, meta)
      return
    }

    // 会话元信息只在文件首行；进程重启后游标已在末尾，不会再读到它。
    // 必须**同步**补齐：若异步加载，首个 token_count 会先用文件名兜底成子会话 id，
    // 导致子代理被拆成独立任务（且父子关系丢失）。
    this.ensureMetaSync(meta)
    // 元信息加载后可能刚判定为 guardian 线程，必须立刻退出，
    // 否则文件追加的心跳仍会为它建立任务。
    if (this.skipped.has(meta.relPath)) return
    const session = this.sessions.get(meta.relPath) ?? this.fallbackSession(meta.relPath)
    this.sessions.set(meta.relPath, session)

    // 模型名可能出现在 session_meta / turn_context / compacted 等不同位置，
    // 且 session_meta 常常只给 model_provider（"openai"）而不给 model。
    // 这里统一扫一遍，避免把 provider 当成模型名展示。
    const foundModel = extractModel(payload, obj)
    if (foundModel && foundModel !== session.model) {
      const previous = session.model
      session.model = foundModel
      // 已经建过任务时，把新模型同步过去（无用量事件，只更新元信息）
      if (previous) {
        this.push({
          tool: this.id,
          externalSessionId: session.sessionId,
          ts: Date.now(),
          title: this.titleFor(session),
          workspace: session.cwd,
          project: this.projectFor(session),
          model: foundModel,
          authoritativeTitle: true,
          tokensSource: 'unavailable',
          skipEventLog: true,
          dedupeKey: `model:${session.sessionId}:${foundModel}`,
          ...emptyUsage()
        })
      }
    }

    // 文件此刻仍在被写入 = 该会话正在工作。这是运行时 IO 观测，
    // 不解析日志内容，也不改变 token/费用口径。
    this.markIo(session, meta)


    // 用户消息 = 一轮的开始（与重建规则一致）：
    // Codex 的 task_started 只在新任务时发，一轮内追问不会重发，
    // 只靠它记录轮次会少算，因此这里显式按用户消息开轮。
    if (type === 'response_item' && payload) {
      const kind = typeof payload.type === 'string' ? payload.type : ''
      if (kind === 'message' && payload.role === 'user') {
        const blocks = Array.isArray(payload.content) ? payload.content : []
        const text = blocks
          .map((block) => (block && typeof block === 'object' ? String((block as Record<string, unknown>).text ?? '') : ''))
          .join('')
        const injected =
          !text || text.includes('environment_context') || text.includes('<user_instructions>')
        if (!injected) {
          // 压缩 / 恢复的文件会把历史消息整段重放。这类行的 timestamp 很旧，
          // 用它开轮会产生一串「刚创建就是 0 用量」的假轮次；
          // 只把「最近 10 分钟内」的消息当作真实的新输入。
          const parsed = parseTs(obj.timestamp)
          const fresh = parsed && Date.now() - parsed < 10 * 60_000
          if (!fresh) return
          const ts = parsed
          this.push({
            tool: this.id,
            externalSessionId: session.sessionId,
            ts,
            title: this.titleFor(session),
            workspace: session.cwd,
            project: this.projectFor(session),
            model: session.model,
            authoritativeTitle: true,
            tokensSource: 'unavailable',
            skipEventLog: true,
            turnStart: true,
            allowCreate: true,
            keepSession: true,
            dedupeKey: `turn:user:${ts}`,
            ...emptyUsage()
          })
        }
      }
    }

    // Codex 自带的任务边界事件：task_started 是本轮开始，task_complete 是本轮结束
    if (type === 'event_msg' && payload) {
      const kind = typeof payload.type === 'string' ? payload.type : ''
      if (kind === 'task_started' || kind === 'task_complete') {
        const ts = parseTs(obj.timestamp) ?? Date.now()
        this.push({
          tool: this.id,
          externalSessionId: session.sessionId,
          ts,
          title: this.titleFor(session),
          workspace: session.cwd,
          project: this.projectFor(session),
          authoritativeTitle: true,
          model: session.model,
          // 一次会话一个任务：与 CodeBuddy / WorkBuddy 一致，轮次由 task_turns 表达
          keepSession: true,
          tokensSource: 'unavailable',
          skipEventLog: true,
          // 轮次起点只认用户消息（重建时统一处理）：task_started 在续写/恢复的分段里
          // 也会发，用它开新轮会比软件里多出一轮
          turnStart: false,
          turnEnd: kind === 'task_complete',
          forceActive: kind === 'task_started',
          // 新会话的首个 task_started 必须立刻建任务，否则实时任务里看不到
          allowCreate: kind === 'task_started',
          // 回合结束即任务结束：Codex 桌面端显示"对话执行完成"时，
          // 这一轮就是终点，不应再挂 30 分钟「静默」
          endSignal: kind === 'task_complete',
          dedupeKey: `turn:${kind}:${ts}`,
          ...emptyUsage()
        })
      }
    }

    if (type === 'event_msg' && payload && payload.type === 'token_count') {
      // 使用原始事件时间，避免把历史会话误判为"刚刚发生"
      this.handleTokenCount(payload, session, meta, parseTs(obj.timestamp))
    }
  }

  /**
   * 同步回读文件头的 session_meta（仅 32KB，首次遇到该文件时执行一次）。
   * 用同步 IO 是为了保证「父子线程 / guardian 判定」先于任何用量事件生效。
   */
  private ensureMetaSync(meta: LineContext): void {
    if (this.sessions.has(meta.relPath) || this.skipped.has(meta.relPath)) return
    let fd: number | null = null
    try {
      fd = openSync(meta.filePath, 'r')
      const buffer = Buffer.allocUnsafe(32 * 1024)
      const bytes = readSync(fd, buffer, 0, buffer.length, 0)
      const head = buffer.subarray(0, bytes).toString('utf8')
      for (const line of head.split('\n')) {
        const raw = line.trim()
        if (!raw) continue
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(raw) as Record<string, unknown>
        } catch {
          // 首行被截断时跳过；下一次追加会再尝试
          continue
        }
        if (obj.type !== 'session_meta') continue
        const payload = isRecord(obj.payload) ? obj.payload : null
        if (payload) this.handleSessionMeta(payload, meta)
        return
      }
    } catch (error) {
      console.error('[adapter:codex] read session meta failed', meta.relPath, error)
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // 忽略关闭失败
        }
      }
    }
  }

  private handleSessionMeta(payload: Record<string, unknown>, meta: LineContext): void {
    // 守护审查（guardian_review）是 Codex 内部的安全判定线程，不属于用户任务，
    // 若纳入统计会让「实时任务」凭空多出几条。
    const source = isRecord(payload.source) ? payload.source : null
    const subagent = source && isRecord(source.subagent) ? source.subagent : null
    const threadSource = str(payload.thread_source)
    if (threadSource === 'guardian_review' || (subagent && str(subagent.other) === 'guardian')) {
      this.skipped.add(meta.relPath)
      return
    }

    // 子代理归并到父线程，避免一次会话被拆成多条任务
    const spawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : null
    const parentId = str(payload.parent_thread_id) ?? (spawn ? str(spawn.parent_thread_id) : undefined)
    this.parents.set(meta.relPath, parentId ?? null)

    const sessionId = parentId || str(payload.id) || sessionIdFromFile(meta.relPath)
    if (!sessionId) return
    const cwd = str(payload.cwd)
    const metaInfo: SessionMeta = {
      sessionId,
      cwd,
      model: str(payload.model),
      provider: str(payload.model_provider)
    }
    this.sessions.set(meta.relPath, metaInfo)

    const ts = parseTs(payload.timestamp) ?? parseTsFromPath(meta.relPath) ?? Date.now()
    this.push({
      tool: this.id,
      externalSessionId: sessionId,
      ts,
      title: this.titleFor(metaInfo),
      workspace: cwd,
      project: this.projectFor(metaInfo),
      authoritativeTitle: true,
      model: metaInfo.model,
      tokensSource: 'native',
      // 一次会话一个任务：历史回填不再切 ~h 分身
      keepSession: true,
      dedupeKey: `meta:${meta.relPath}`,
      ...emptyUsage()
    })
  }

  /** 刷新 io 活跃信号（30 秒合并一次，仅当文件 3 分钟内被写过） */
  private markIo(session: SessionMeta, meta: LineContext): void {
    if (Date.now() - meta.mtimeMs > 180_000) return
    const bucket = Math.floor(Date.now() / 30_000)
    if (this.ioBucket.get(meta.relPath) === bucket) return
    this.ioBucket.set(meta.relPath, bucket)
    this.emitState({
      tool: this.id,
      sessionId: session.sessionId,
      phase: 'active',
      ts: Date.now(),
      source: 'io',
      workspace: session.cwd,
      model: session.model
    })
  }

  private handleTokenCount(
    payload: Record<string, unknown>,
    session: SessionMeta,
    meta: LineContext,
    eventTs: number | null
  ): void {
    const info = isRecord(payload.info) ? payload.info : null
    if (!info) return
    const last = isRecord(info.last_token_usage) ? info.last_token_usage : null
    const total = isRecord(info.total_token_usage) ? info.total_token_usage : null

    let input = 0
    let cached = 0
    let output = 0
    let reasoning = 0
    let cacheWrite = 0

    if (last) {
      input = num(last.input_tokens)
      cached = num(last.cached_input_tokens)
      output = num(last.output_tokens)
      reasoning = num(last.reasoning_output_tokens)
      cacheWrite = num(last.cache_write_input_tokens)
    } else if (total) {
      const prev = this.totals.get(session.sessionId) ?? { input: 0, cached: 0, output: 0 }
      const cur = {
        input: num(total.input_tokens),
        cached: num(total.cached_input_tokens),
        output: num(total.output_tokens)
      }
      // 累计值回退说明会话被重置，按当前值全量记一次，避免负数
      input = cur.input >= prev.input ? cur.input - prev.input : cur.input
      cached = cur.cached >= prev.cached ? cur.cached - prev.cached : cur.cached
      output = cur.output >= prev.output ? cur.output - prev.output : cur.output
      this.totals.set(session.sessionId, cur)
    } else {
      return
    }

    if (input === 0 && cached === 0 && output === 0) return
    if (total) {
      this.totals.set(session.sessionId, {
        input: num(total.input_tokens),
        cached: num(total.cached_input_tokens),
        output: num(total.output_tokens)
      })
    }

    const billableInput = Math.max(0, input - cached)
    const ts = eventTs ?? Date.now()
    this.push({
      tool: this.id,
      externalSessionId: session.sessionId,
      ts,
      title: this.titleFor(session),
      workspace: session.cwd,
      project: this.projectFor(session),
      authoritativeTitle: true,
      // 没有真实模型时留空：provider 名（openai）不是模型名，写成它会覆盖已知真值
      model: isModelName(session.model) ? session.model : undefined,
      inputTokens: billableInput,
      outputTokens: output,
      cacheReadTokens: cached,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: reasoning,
      tokensSource: 'native',
      // 一次会话一个任务：历史回填不再切 ~h 分身
      keepSession: true,
      dedupeKey: `tok:${meta.relPath}:${meta.offset}`
    })
  }

  private fallbackSession(relPath: string): SessionMeta {
    return { sessionId: sessionIdFromFile(relPath) ?? relPath }
  }
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

/**
 * 从事件 payload 里挖出真实模型名。
 * 跳过 provider 名（openai / anthropic / google 等）与空值，只认带标识符特征的模型 id。
 */
const PROVIDER_NAMES = new Set(['openai', 'anthropic', 'google', 'azure', 'vertex', 'bedrock', 'custom'])

function isModelName(value: string | undefined): boolean {
  if (!value) return false
  return !PROVIDER_NAMES.has(value.trim().toLowerCase())
}

function extractModel(payload: unknown, whole: unknown): string | null {
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): string | null => {
    if (!node || typeof node !== 'object' || depth > 4 || seen.has(node)) return null
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item, depth + 1)
        if (hit) return hit
      }
      return null
    }
    const record = node as Record<string, unknown>
    for (const [key, value] of Object.entries(record)) {
      if ((key === 'model' || key === 'modelId' || key === 'model_name') && typeof value === 'string') {
        const name = value.trim()
        if (name && !PROVIDER_NAMES.has(name.toLowerCase())) return name
      }
      const hit = walk(value, depth + 1)
      if (hit) return hit
    }
    return null
  }
  return walk(payload, 0) ?? walk(whole, 0)
}

function parseTs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ts = Date.parse(value)
  return Number.isFinite(ts) ? ts : null
}

/** rollout-2026-11-03T22-23-34-<uuid>.jsonl → uuid */
function sessionIdFromFile(relPath: string): string | null {
  const name = basename(relPath)
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  if (match) return match[1]
  const loose = name.match(/([0-9a-f]{8,})\.jsonl$/i)
  return loose ? loose[1] : null
}

function parseTsFromPath(relPath: string): number | null {
  const match = relPath.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/)
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match
  const ts = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s)
  ).getTime()
  return Number.isFinite(ts) ? ts : null
}
