import type {
  AdapterCapabilities,
  StateSignal,
  AdapterHealth,
  AdapterInfo,
  AppSettings,
  BridgePayload,
  CollectChannel,
  PricingRow,
  ToolId,
  UsageDelta
} from '@shared/types'
import { basename } from 'node:path'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { CursorStore } from '../collectors/jsonl-tailer'
import { isAnyRunning } from '../collectors/process-probe'
import { HeartbeatWatcher, type HeartbeatSession } from '../collectors/session-heartbeat'

export interface AdapterContext {
  settings: () => AppSettings
  pricing: () => PricingRow[]
  /** 归一化增量入口（由状态机消费），只承载用量信息 */
  emit: (delta: UsageDelta) => void
  /** 运行时状态信号入口（hook / 心跳 / 进程 / 桥接） */
  emitState: (signal: StateSignal) => void
  cursors: CursorStore
  /** 记录错误：指数退避由 AdapterManager 处理 */
  reportError: (error: unknown, message?: string) => void
  isPaused: () => boolean
}

export interface DetectResult {
  installed: boolean
  dataPath: string | null
  message?: string
}

export interface AdapterHealthInfo {
  status: AdapterHealth
  lastEventAt: number | null
  errorCount: number
  message: string | null
}

/**
 * 工具适配器契约：新增工具只需实现该接口并在 registry 注册一行，
 * 不需要改动采集引擎、数据库与界面。
 */
export interface ToolAdapter {
  readonly id: ToolId
  readonly displayName: string
  readonly channel: CollectChannel
  readonly capabilities: AdapterCapabilities
  detect(): Promise<DetectResult>
  start(ctx: AdapterContext): Promise<void>
  stop(): Promise<void>
  health(): AdapterHealthInfo
  /** 供适配器管理页展示的完整状态 */
  info(): AdapterInfo
  /** 桥接上报入口，仅网页类工具实现 */
  ingestBridge?(payload: BridgePayload): void
}

/** 提供健康度统计与安全 emit 的基类 */
export abstract class BaseAdapter implements ToolAdapter {
  abstract readonly id: ToolId
  abstract readonly displayName: string
  abstract readonly channel: CollectChannel
  abstract readonly capabilities: AdapterCapabilities

  protected dataPath: string | null = null
  protected installed = false
  protected started = false
  protected lastEventAt: number | null = null
  protected errorCount = 0
  protected message: string | null = null
  protected ctx: AdapterContext | null = null
  /** 累计已发出的事件数，用于适配器管理页展示 */
  protected emittedCount = 0
  /** 心跳目录 → 观察器，避免每次轮询重建候选列表 */
  private readonly heartbeatWatchers = new Map<string, HeartbeatWatcher>()
  /** sessionId → 最近一次心跳时间，用于判定会话结束 */
  private readonly heartbeatSeen = new Map<string, number>()

  protected settings(): AppSettings {
    return this.ctx?.settings() ?? DEFAULT_SETTINGS
  }

  abstract detect(): Promise<DetectResult>

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx
    const result = await this.detect()
    this.dataPath = result.dataPath
    this.installed = result.installed
    this.message = result.message ?? null
    if (!result.installed) {
      this.message = result.message ?? '未检测到本地数据目录'
      return
    }
    await this.onStart(ctx)
    this.started = true
  }

  protected abstract onStart(ctx: AdapterContext): Promise<void>

  async stop(): Promise<void> {
    await this.onStop()
    this.started = false
  }

  protected abstract onStop(): Promise<void>

  health(): AdapterHealthInfo {
    let status: AdapterHealth = 'ok'
    if (!this.installed) status = 'off'
    else if (!this.started) status = 'degraded'
    else if (this.errorCount > 6) status = 'degraded'
    return {
      status,
      lastEventAt: this.lastEventAt,
      errorCount: this.errorCount,
      message: this.message
    }
  }

  info(): AdapterInfo {
    const health = this.health()
    return {
      id: this.id,
      displayName: this.displayName,
      channel: this.channel,
      capabilities: this.capabilities,
      installed: this.installed,
      dataPath: this.dataPath,
      status: health.status,
      lastEventAt: health.lastEventAt,
      errorCount: health.errorCount,
      message: health.message,
      eventsToday: this.emittedCount
    }
  }

  /** 运行时状态出口：只上报状态，不写用量流水 */
  protected emitState(signal: StateSignal): void {
    if (!this.ctx || this.ctx.isPaused()) return
    this.ctx.emitState(signal)
  }

  /** 统一出口：校验数据合法性后交给状态机 */
  protected push(delta: UsageDelta): void {
    if (!this.ctx) return
    if (this.ctx.isPaused()) return
    if (!delta.externalSessionId) return
    if (!Number.isFinite(delta.ts) || delta.ts <= 0) delta.ts = Date.now()
    this.emittedCount += 1
    // 轮询类适配器可能乱序上报，这里取最大值，避免"最近事件"被旧记录覆盖
    this.lastEventAt = Math.max(this.lastEventAt ?? 0, delta.ts)
    this.ctx.emit(delta)
  }

  /**
   * 桥接上报入口（网页类工具）。
   * 有 token 数据时标记 bridge，纯心跳则标记 unavailable —— 不使用任何估算值。
   */
  ingestBridge(payload: BridgePayload): void {
    const total =
      (payload.inputTokens ?? 0) +
      (payload.outputTokens ?? 0) +
      (payload.cacheReadTokens ?? 0) +
      (payload.cacheWriteTokens ?? 0)
    const ts = payload.ts ?? Date.now()
    this.push({
      tool: this.id,
      externalSessionId: payload.sessionId,
      ts,
      title: payload.title,
      model: payload.model,
      inputTokens: payload.inputTokens ?? 0,
      outputTokens: payload.outputTokens ?? 0,
      cacheReadTokens: payload.cacheReadTokens ?? 0,
      cacheWriteTokens: payload.cacheWriteTokens ?? 0,
      reasoningTokens: 0,
      tokensSource: total > 0 ? 'bridge' : 'unavailable',
      dedupeKey: `bridge:${payload.sessionId}:${ts}:${total}`,
      endSignal: payload.end === true
    })
  }

  /**
   * 会话心跳通道：读取 `<tool>/sessions/<pid>.json` 的 lastHeartbeat。
   * 这是"任务是否真的在运行"最可靠的信号，但心跳不含 token，
   * 因此只记录真实开始时间与时长，用量标记为 unavailable。
   * 心跳每 30s 合并为一条事件（skipEventLog），避免流水表膨胀。
   */
  protected async pollSessionHeartbeats(
    dir: string,
    label: string,
    options: {
      /** 把进程级 sessionId 归并为业务任务 id（如按项目 + 日期聚合） */
      idFor?: (session: HeartbeatSession) => string
      titleFor?: (session: HeartbeatSession) => string
    } = {}
  ): Promise<void> {
    if (!this.ctx) return
    let watcher = this.heartbeatWatchers.get(dir)
    if (!watcher) {
      watcher = new HeartbeatWatcher(dir)
      this.heartbeatWatchers.set(dir, watcher)
    }

    const now = Date.now()
    const staleMs = Math.max(this.settings().idleThresholdMs * 20, 10 * 60_000)
    const sessions = await watcher.poll(now)
    const alive = new Set<string>()

    for (const session of sessions) {
      if (now - session.lastHeartbeat > staleMs) continue
      const taskKey = options.idFor ? options.idFor(session) : session.sessionId
      alive.add(taskKey)
      this.heartbeatSeen.set(taskKey, session.lastHeartbeat)

      this.emitState({
        tool: this.id,
        sessionId: taskKey,
        phase: 'active',
        ts: session.lastHeartbeat,
        source: 'heartbeat',
        title: options.titleFor
          ? options.titleFor(session)
          : heartbeatTitle(session.cwd, label, session.startedAt),
        workspace: session.cwd,
        startedAtHint: session.startedAt
      })
    }

    // 心跳文件消失或超时 → 会话结束
    for (const [taskKey, lastBeat] of this.heartbeatSeen) {
      if (alive.has(taskKey)) continue
      this.emitState({
        tool: this.id,
        sessionId: taskKey,
        phase: 'end',
        ts: Math.min(lastBeat, now),
        source: 'heartbeat'
      })
      this.heartbeatSeen.delete(taskKey)
    }
  }

  /**
   * 无桥接时的降级通道：工具进程存在即视为"会话进行中"，
   * 只记录真实时长，token 明确标记为 unavailable。
   */
  protected async aliveFallback(matchers: string[], label: string): Promise<boolean> {
    if (!this.ctx || this.ctx.isPaused()) return false
    const bridgeRecent = this.lastEventAt !== null && Date.now() - this.lastEventAt < 180_000
    if (bridgeRecent) return false
    const running = await isAnyRunning(matchers).catch(() => false)
    if (!running) return false

    this.emitState({
      tool: this.id,
      sessionId: `alive-${this.id}-${new Date().toISOString().slice(0, 10)}`,
      phase: 'active',
      ts: Date.now(),
      source: 'process',
      // 不携带标题：进程信号只维持已有任务的状态，不参与命名
    })
    return true
  }

  protected fail(error: unknown, message?: string): void {
    this.errorCount += 1
    this.message = message ?? (error instanceof Error ? error.message : String(error))
    console.error(`[adapter:${this.id}] ${this.message}`, error)
    this.ctx?.reportError(error, this.message)
  }
}

/** 心跳会话标题：优先工作目录名，临时目录等无意义名回退为带时间的会话名 */
function heartbeatTitle(cwd: string | undefined, label: string, startedAt: number): string {
  const dir = cwd ? basename(cwd) : ''
  const meaningful = dir.length > 2 && !/^\d+$/.test(dir) && !/^T$/i.test(dir)
  if (meaningful) return dir
  const time = new Date(startedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
  return `${label} 会话 ${time}`
}

export function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0
  }
}
