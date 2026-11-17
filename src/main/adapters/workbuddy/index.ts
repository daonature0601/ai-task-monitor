import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterCapabilities, ToolId } from '@shared/types'
import type { AdapterContext } from '../base'
import { BaseAdapter, type DetectResult } from '../base'
import { withReadonlyDb } from '../../collectors/sqlite-reader'
import { TOOL_PATHS, firstExisting, homePath } from '../../collectors/paths'
import { isInstalled } from '../../collectors/process-probe'

interface SessionRow {
  id: string
  title: string | null
  cwd: string | null
  status: string | null
  model: string | null
  created_at: number | null
  updated_at: number | null
  last_activity_at: number | null
}

interface UsageRow {
  session_id: string
  used: number | null
  size: number | null
  updated_at: number | null
  credit_json: string | null
}

/**
 * WorkBuddy 适配器（Tencent 桌面端）。
 * 数据源：~/.workbuddy/workbuddy.db（只读打开，WAL 安全）
 * - sessions 表给出会话生命周期与模型
 * - session_usage.used 为"上下文占用量"（非累计计费输入），归类为 partial
 * - credit_json 为各 turn 的积分消耗，无法换算为 USD，仅用于任务存在性判定
 * 因此 tokensSource 标记 partial，界面会显示"部分字段"徽标。
 */
export class WorkBuddyAdapter extends BaseAdapter {
  readonly id: ToolId = 'workbuddy'
  readonly displayName = 'WorkBuddy'
  readonly channel = 'sqlite' as const
  readonly capabilities: AdapterCapabilities = {
    tokens: true,
    liveStream: false,
    bridgeRequired: false
  }

  private timer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private readonly seenCredits = new Map<string, number>()

  async detect(): Promise<DetectResult> {
    const spec = TOOL_PATHS.workbuddy()
    const dbPath = existsSync(spec.primary) ? spec.primary : null
    return {
      installed: isInstalled('workbuddy', dbPath),
      dataPath: dbPath,
      message: dbPath ? undefined : '未找到 ~/.workbuddy/workbuddy.db'
    }
  }

  protected async onStart(ctx: AdapterContext): Promise<void> {
    const dbPath = this.dataPath
    if (!dbPath) return
    const interval = Math.max(3000, ctx.settings().desktopPollMs)
    await this.poll(ctx, dbPath)
    this.timer = setInterval(() => {
      void this.poll(ctx, dbPath)
    }, interval)

    // SQLite 的 last_activity 粒度较粗；心跳文件才是"正在运行"的实时信号
    const heartbeatDir = join(homePath('.workbuddy'), 'sessions')
    const beat = (): void => {
      void this.pollSessionHeartbeats(heartbeatDir, 'WorkBuddy').catch((error) =>
        this.fail(error, '读取会话心跳失败')
      )
    }
    beat()
    this.heartbeatTimer = setInterval(beat, Math.max(3000, ctx.settings().processProbeMs))
    console.log(`[adapter:workbuddy] polling every ${interval}ms (+heartbeat)`)
  }

  protected async onStop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async poll(ctx: AdapterContext, dbPath: string): Promise<void> {
    if (ctx.isPaused()) return
    try {
      const rows = withReadonlyDb(dbPath, (db) => this.readRows(db))
      if (!rows) return
      for (const item of rows) this.emitSession(item, ctx)
    } catch (error) {
      this.fail(error)
    }
  }

  private readRows(db: import('better-sqlite3').Database): Array<{
    session: SessionRow
    usage: UsageRow | null
  }> {
    const hasSessions = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get()
    if (!hasSessions) return []

    const sessions = db
      .prepare(
        `SELECT id, title, cwd, status, model, created_at, updated_at, last_activity_at
         FROM sessions
         WHERE deleted_at IS NULL OR deleted_at = 0
         ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC
         LIMIT 60`
      )
      .all() as SessionRow[]

    const hasUsage = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_usage'")
      .get()
    const usageStmt = hasUsage
      ? db.prepare('SELECT session_id, used, size, updated_at, credit_json FROM session_usage WHERE session_id = ?')
      : null

    return sessions.map((session) => ({
      session,
      usage: usageStmt ? ((usageStmt.get(session.id) as UsageRow | undefined) ?? null) : null
    }))
  }

  private emitSession(
    item: { session: SessionRow; usage: UsageRow | null },
    ctx: AdapterContext
  ): void {
    const { session, usage } = item
    const startedAt = toMs(session.created_at) ?? Date.now()
    const lastActivity = toMs(session.last_activity_at) ?? toMs(session.updated_at) ?? startedAt
    const used = Math.max(0, usage?.used ?? 0)
    const previous = this.seenCredits.get(session.id) ?? 0
    // used 为上下文占用量，取"较上次的增长"作为增量，避免每次轮询重复累加
    const delta = used > previous ? used - previous : 0
    if (used !== previous) this.seenCredits.set(session.id, used)

    const isActive = (session.status ?? '').toLowerCase() === 'active'
    if (delta === 0 && !isActive && previous > 0) return

    this.push({
      tool: this.id,
      externalSessionId: session.id,
      ts: lastActivity,
      title: session.title?.trim() || undefined,
      workspace: session.cwd ?? undefined,
      model: session.model ?? undefined,
      // 上下文占用量映射为输入侧观测值，明确标注 partial
      inputTokens: delta,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      tokensSource: 'partial',
      dedupeKey: `usage:${session.id}:${used}:${lastActivity}`,
      endSignal: !isActive && previous > 0
    })
  }
}

function toMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  // WorkBuddy 部分表使用秒级时间戳
  return value < 1_000_000_000_000 ? value * 1000 : value
}
