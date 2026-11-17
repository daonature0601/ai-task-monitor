import { promises as fsp, closeSync, openSync, readSync } from 'node:fs'
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

    if (payload && typeof payload.model === 'string' && payload.model) {
      session.model = payload.model
    }

    // 文件此刻仍在被写入 = 该会话正在工作。这是运行时 IO 观测，
    // 不解析日志内容，也不改变 token/费用口径。
    this.markIo(session, meta)


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
      title: cwd ? basename(cwd) : undefined,
      workspace: cwd,
      model: metaInfo.model,
      tokensSource: 'native',
      dedupeKey: `meta:${meta.relPath}`,
      authoritativeTitle: true,
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
      title: session.cwd ? basename(session.cwd) : undefined,
      workspace: session.cwd,
      model: session.model ?? session.provider,
      inputTokens: billableInput,
      outputTokens: output,
      cacheReadTokens: cached,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: reasoning,
      tokensSource: 'native',
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
