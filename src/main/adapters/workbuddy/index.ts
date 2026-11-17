import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AdapterCapabilities, ToolId } from '@shared/types'
import type { AdapterContext, DetectResult } from '../base'
import { BaseAdapter } from '../base'
import { JsonlTailer, type LineContext } from '../../collectors/jsonl-tailer'
import { TOOL_PATHS, homePath } from '../../collectors/paths'
import { isInstalled } from '../../collectors/process-probe'

/**
 * WorkBuddy 适配器（腾讯桌面端 / CLI）。
 *
 * 数据源（与官方 token-dashboard 技能一致）：
 *   ~/.workbuddy/projects/<工作区 slug>/<会话>.jsonl
 *   每条记录的 providerData.rawUsage 就是**请求级真实 usage**，
 *   含 prompt / completion / 缓存命中与写入，可直接计价。
 *
 *   <会话>/subagents/agent-*.jsonl 里的子代理请求按路径归属到父会话。
 *
 * 状态：仍用心跳文件驱动（<pid>.json），因为 JSONL 只在回合结束时落盘。
 */
export class WorkBuddyAdapter extends BaseAdapter {
  readonly id: ToolId = 'workbuddy'
  readonly displayName = 'WorkBuddy'
  readonly channel = 'jsonl' as const
  readonly capabilities: AdapterCapabilities = {
    tokens: true,
    liveStream: true,
    bridgeRequired: false
  }

  private tailer: JsonlTailer | null = null
  private readonly titles = new Map<string, string>()

  async detect(): Promise<DetectResult> {
    const projects = join(homePath('.workbuddy'), 'projects')
    if (existsSync(projects)) {
      return { installed: true, dataPath: projects }
    }
    // 兼容旧路径探测
    const spec = TOOL_PATHS.workbuddy()
    return {
      installed: isInstalled('workbuddy', spec.primary),
      dataPath: existsSync(spec.primary) ? spec.primary : null,
      message: '未找到 ~/.workbuddy/projects，无法读取会话日志'
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
        backfillDays: Math.max(ctx.settings().backfillDays, 7),
        maxBytesPerRead: 8 * 1024 * 1024,
        cursors: ctx.cursors,
        onLine: (line, meta) => this.handleLine(line, meta),
        onError: (error) => this.fail(error)
      })
      await this.tailer.start()
    }

    // 心跳文件是**进程存活**信号（prewarm 池会一次生成多个），
    // 用它建任务会出现「同一对话多张卡片」，因此不再接入。
    // 状态由 JSONL 的用量/轮次事件驱动。
    console.log('[adapter:workbuddy] started (jsonl)')
  }

  protected async onStop(): Promise<void> {
    await this.tailer?.stop()
    this.tailer = null
  }

  /** 子代理文件按路径归属父会话，避免一个会话裂成多条任务 */
  private sessionIdOf(meta: LineContext, recordSessionId: string | undefined): string {
    const parts = meta.relPath.split('/')
    const subIndex = parts.indexOf('subagents')
    if (subIndex > 0) return parts[subIndex - 1]
    return recordSessionId ?? basename(meta.relPath, '.jsonl')
  }

  private handleLine(line: string, meta: LineContext): void {
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }

    const type = typeof obj.type === 'string' ? obj.type : ''
    const sessionId = this.sessionIdOf(meta, str(obj.sessionId))
    if (!sessionId) return
    const ts = num(obj.timestamp)
    const cwd = str(obj.cwd)
    const project = cwd ? cwd.split('/').filter(Boolean).pop() : undefined

    // 会话标题：WorkBuddy 自己用 ai-title 事件命名
    if (type === 'ai-title') {
      const title = str(obj.aiTitle)
      if (!title) return
      if (this.titles.get(sessionId) === title) return
      this.titles.set(sessionId, title)
      this.push({
        tool: this.id,
        externalSessionId: sessionId,
        ts: ts || Date.now(),
        title,
        workspace: cwd,
        project,
        authoritativeTitle: true,
        tokensSource: 'unavailable',
        skipEventLog: true,
        dedupeKey: `wb:title:${sessionId}:${title}`,
        ...emptyUsage()
      })
      return
    }

    if (type === 'session-meta') {
      this.push({
        tool: this.id,
        externalSessionId: sessionId,
        ts: ts || Date.now(),
        title: this.titles.get(sessionId),
        workspace: cwd,
        project,
        startedAtHint: ts || undefined,
        tokensSource: 'unavailable',
        skipEventLog: true,
        dedupeKey: `wb:meta:${sessionId}`,
        ...emptyUsage()
      })
      return
    }

    // 轮次边界：用户消息开启一轮，assistant 完成时结束
    if (type === 'message') {
      const role = str(obj.role)
      if (role === 'user') {
        this.push({
          tool: this.id,
          externalSessionId: sessionId,
          ts: ts || Date.now(),
          title: this.titles.get(sessionId),
          workspace: cwd,
          project,
          authoritativeTitle: true,
          tokensSource: 'unavailable',
          skipEventLog: true,
          turnStart: true,
          dedupeKey: `wb:turn:${sessionId}:${str(obj.id) ?? ts}`,
          ...emptyUsage()
        })
      } else if (role === 'assistant' && str(obj.status) === 'completed') {
        this.push({
          tool: this.id,
          externalSessionId: sessionId,
          ts: ts || Date.now(),
          title: this.titles.get(sessionId),
          workspace: cwd,
          project,
          authoritativeTitle: true,
          tokensSource: 'unavailable',
          skipEventLog: true,
          // 与 Codex / DSH 一致：一轮结束即结算任务；
          // 用户在 10 分钟内追问会重开同一任务，不会碎成多条
          turnEnd: true,
          endSignal: true,
          dedupeKey: `wb:end:${sessionId}:${str(obj.id) ?? ts}`,
          ...emptyUsage()
        })
      }
      return
    }

    // 用量：providerData.rawUsage 是请求级真实 usage
    const provider = isRecord(obj.providerData) ? obj.providerData : null
    const usage = provider && isRecord(provider.rawUsage) ? provider.rawUsage : null
    if (!usage) return

    // WorkBuddy 用的字段名与 OpenAI 不同：命中/写入都在 prompt_cache_* 上，
    // cache_read_input_tokens 基本恒为 0，不能拿它当主口径。
    const cached = num(
      usage.prompt_cache_hit_tokens ??
        usage.cache_read_input_tokens ??
        (isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details.cached_tokens : 0)
    )
    const cacheWrite = num(usage.prompt_cache_write_tokens ?? usage.cache_creation_input_tokens)
    const prompt = num(usage.prompt_tokens)
    const miss = num(usage.prompt_cache_miss_tokens)
    const input = miss > 0 ? miss : Math.max(0, prompt - cached)
    const output = num(usage.completion_tokens)
    const reasoning = isRecord(usage.completion_tokens_details)
      ? num(usage.completion_tokens_details.reasoning_tokens)
      : 0

    if (input + output + cached + cacheWrite === 0) return

    this.push({
      tool: this.id,
      externalSessionId: sessionId,
      ts: ts || Date.now(),
      title: this.titles.get(sessionId),
      workspace: cwd,
      project,
      authoritativeTitle: true,
      model: provider ? (str(provider.model) ?? str(provider.requestModelName)) : undefined,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cached,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: reasoning,
      tokensSource: 'native',
      dedupeKey: `wb:usage:${sessionId}:${str(obj.id) ?? `${ts}:${prompt}:${output}`}`
    })
  }
}

function emptyUsage(): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
} {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  }
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
