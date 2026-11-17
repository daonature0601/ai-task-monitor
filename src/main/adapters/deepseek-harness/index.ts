import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { AdapterCapabilities, ToolId, UsageDelta } from '@shared/types'
import type { AdapterContext } from '../base'
import { BaseAdapter, type DetectResult } from '../base'
import {
  listDshSessionFiles,
  parseDshSession,
  type DshSession,
  type DshSessionFile
} from '../../collectors/dsh-session-reader'
import { homePath, firstExisting } from '../../collectors/paths'
import { PROCESS_MATCHERS, isInstalled } from '../../collectors/process-probe'

/**
 * DeepSeek Harness 适配器。
 *
 * 数据源（本机实测）：
 *   ~/.dsh/sessions/<项目 slug>/session-<uuid>/session.v4.jsonl.zstd
 *   每个会话一个 zstd 压缩的 JSONL，含会话头、轮次、以及 assistant/message 上的 usage。
 *
 * 说明：
 *   - 文件是整块压缩，无法按字节尾随，只能整份解压后按 seq 去重
 *   - LocalStorage（LevelDB）里只有界面状态，没有用量，不再作为数据源
 *   - 网页端 chat.deepseek.com 仍通过桥接补充
 */
export class DeepSeekHarnessAdapter extends BaseAdapter {
  readonly id: ToolId = 'deepseek-harness'
  readonly displayName = 'DeepSeek Harness'
  readonly channel = 'jsonl' as const
  readonly capabilities: AdapterCapabilities = {
    tokens: true,
    liveStream: true,
    bridgeRequired: false
  }

  private timer: NodeJS.Timeout | null = null
  /** 文件 → 上次处理的时间戳/大小，用于判断是否需要重解压 */
  private readonly fileState = new Map<string, { mtimeMs: number; size: number; maxSeq: number }>()
  /** 已发出过的事件 seq（sessionId → 最大 seq），避免重复推送 */
  private readonly sessionSeq = new Map<string, number>()
  private scanning = false
  private ctxRef: AdapterContext | null = null

  async detect(): Promise<DetectResult> {
    const root = join(homePath('.dsh'), 'sessions')
    const exists = await fsp
      .stat(root)
      .then((stat) => stat.isDirectory())
      .catch(() => false)
    if (exists) {
      return { installed: true, dataPath: root, message: '读取 ~/.dsh/sessions 下的会话文件' }
    }

    // 兜底：旧版本装在 AppSupport 下，或者根本没装
    const spec = { primary: root, alternates: [] as string[] }
    const path = firstExisting([spec.primary, ...spec.alternates])
    return {
      installed: isInstalled('deepseek-harness', path),
      dataPath: path,
      message: path ? undefined : '未找到 ~/.dsh/sessions，仅能通过网页桥接采集'
    }
  }

  protected async onStart(ctx: AdapterContext): Promise<void> {
    this.ctxRef = ctx
    const interval = Math.max(ctx.settings().desktopPollMs * 2, 30_000)
    void this.scan(ctx)
    this.timer = setInterval(() => {
      void this.scan(ctx)
    }, interval)
    console.log(`[adapter:deepseek-harness] dsh sessions scan every ${interval}ms`)
  }

  protected async onStop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async scan(ctx: AdapterContext): Promise<void> {
    if (ctx.isPaused() || this.scanning) return
    const root = this.dataPath
    if (!root) return

    this.scanning = true
    try {
      const files = await listDshSessionFiles(root)
      for (const file of files) {
        const known = this.fileState.get(file.filePath)
        if (known && known.mtimeMs === file.mtimeMs && known.size === file.size) continue

        const session = await this.readSession(file)
        if (!session) continue
        // 游标存「已处理的最大 seq」：DSH 是整块压缩，只能整份重解，
        // 靠它避免每次重启把同一批事件重复计入任务总额。
        const cursor = this.ctxRef?.cursors.get(file.filePath)
        const lastSeq = cursor && session.maxSeq >= cursor.offset ? cursor.offset : 0
        this.fileState.set(file.filePath, {
          mtimeMs: file.mtimeMs,
          size: file.size,
          maxSeq: session.maxSeq
        })
        this.emitSession(session, lastSeq)
        this.ctxRef?.cursors.set(file.filePath, session.maxSeq, null, file.mtimeMs)
      }
    } catch (error) {
      this.fail(error)
    } finally {
      this.scanning = false
    }
  }

  private async readSession(file: DshSessionFile): Promise<DshSession | null> {
    try {
      const buffer = await fsp.readFile(file.filePath)
      return parseDshSession(buffer, file.sessionId)
    } catch (error) {
      console.error('[adapter:deepseek-harness] read session failed', file.filePath, error)
      return null
    }
  }

  /** 把一个会话解析结果转成用量 / 状态事件，只推送尚未处理的部分 */
  private emitSession(session: DshSession, sinceSeq = 0): void {
    // 空会话（只有 lock、没有消息与标题）不建任务，避免列表里出现一串无名记录
    if (sinceSeq === 0 && session.messages.length === 0 && session.titles.length === 0) return

    const project = session.cwd ? session.cwd.split('/').filter(Boolean).pop() : undefined
    const base = {
      tool: this.id,
      externalSessionId: session.sessionId,
      workspace: session.cwd,
      project,
      title: session.title,
      model: session.model,
      authoritativeTitle: true,
      // 一次会话就是一个任务，跨天也不拆
      keepSession: true
    }
    const empty = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0
    }

    const pending: Array<{ seq: number; delta: UsageDelta }> = []

    if (session.createdAt > 0 && sinceSeq === 0) {
      pending.push({
        seq: -1,
        delta: {
          ...base,
          ts: session.createdAt,
          tokensSource: 'unavailable',
          skipEventLog: true,
          dedupeKey: `dsh:meta:${session.sessionId}`,
          ...empty
        }
      })
    }

    for (const turn of session.turns) {
      if (turn.seq <= sinceSeq) continue
      pending.push({
        seq: turn.seq,
        delta: {
          ...base,
          ts: turn.time,
          tokensSource: 'unavailable',
          skipEventLog: true,
          turnStart: turn.kind === 'start',
          turnEnd: turn.kind === 'end',
          endSignal: turn.kind === 'end',
          dedupeKey: `dsh:turn:${session.sessionId}:${turn.seq}`,
          ...empty
        }
      })
    }

    for (const title of session.titles) {
      if (title.seq <= sinceSeq) continue
      pending.push({
        seq: title.seq,
        delta: {
          ...base,
          title: title.title,
          ts: title.time,
          tokensSource: 'unavailable',
          skipEventLog: true,
          dedupeKey: `dsh:title:${session.sessionId}:${title.seq}`,
          ...empty
        }
      })
    }

    for (const message of session.messages) {
      if (message.seq <= sinceSeq) continue
      pending.push({
        seq: message.seq,
        delta: {
          ...base,
          ts: message.time,
          tokensSource: 'native',
          inputTokens: message.usage.inputTokens,
          outputTokens: message.usage.outputTokens,
          cacheReadTokens: message.usage.cacheReadTokens,
          cacheWriteTokens: message.usage.cacheWriteTokens,
          reasoningTokens: 0,
          dedupeKey: `dsh:msg:${session.sessionId}:${message.seq}`
        }
      })
    }

    // 必须按 seq 顺序推送：DSH 的 turn/end 往往排在最后一条 assistant/message 之后，
    // 若按「轮次 → 标题 → 用量」分批推，最后一次推送会是用量事件，
    // 任务就被重新标成「运行中」——这正是对话已结束却仍显示运行中的原因。
    pending.sort((a, b) => a.seq - b.seq)
    for (const item of pending) this.push(item.delta)

    this.sessionSeq.set(session.sessionId, session.maxSeq)
  }
}
