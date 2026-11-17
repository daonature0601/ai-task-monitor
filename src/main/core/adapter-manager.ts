import type {
  AdapterInfo,
  AppSettings,
  BridgePayload,
  PricingRow,
  ToolId,
  UsageDelta
} from '@shared/types'
import type { AdapterContext, ToolAdapter } from '../adapters/base'
import { createAdapters } from '../adapters/registry'
import type { CursorStore } from '../collectors/jsonl-tailer'
import { PROCESS_MATCHERS, isAnyRunning } from '../collectors/process-probe'
import { TOOL_IDS } from '@shared/types'

interface BackoffState {
  failures: number
  nextAttemptAt: number
}

const MAX_BACKOFF_MS = 60_000

/**
 * 适配器生命周期管理：注册、启停、错误隔离与指数退避。
 * 任一适配器异常都不影响其它适配器与主进程。
 */
export class AdapterManager {
  private adapters: ToolAdapter[] = []
  private readonly backoff = new Map<string, BackoffState>()
  private ctx: AdapterContext | null = null
  private started = false

  constructor(
    private readonly deps: {
      settings: () => AppSettings
      pricing: () => PricingRow[]
      emit: (delta: UsageDelta) => void
      cursors: CursorStore
    }
  ) {}

  async startAll(): Promise<void> {
    if (this.started) return
    this.started = true
    this.adapters = createAdapters()
    this.ctx = {
      settings: this.deps.settings,
      pricing: this.deps.pricing,
      emit: this.deps.emit,
      cursors: this.deps.cursors,
      isPaused: () => this.deps.settings().paused,
      reportError: (error, message) => this.recordError('unknown', error, message)
    }

    for (const adapter of this.adapters) {
      await this.startOne(adapter)
    }
    console.log(`[manager] ${this.adapters.length} adapters started`)
  }

  private async startOne(adapter: ToolAdapter): Promise<void> {
    if (!this.ctx) return
    const adapterCtx: AdapterContext = {
      ...this.ctx,
      reportError: (error, message) => this.recordError(adapter.id, error, message)
    }
    try {
      await adapter.start(adapterCtx)
      this.backoff.delete(adapter.id)
    } catch (error) {
      this.recordError(adapter.id, error, '启动失败')
    }
  }

  private recordError(id: string, error: unknown, message?: string): void {
    const prev = this.backoff.get(id) ?? { failures: 0, nextAttemptAt: 0 }
    const failures = prev.failures + 1
    const delay = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** (failures - 1))
    this.backoff.set(id, { failures, nextAttemptAt: Date.now() + delay })
    console.error(`[manager] ${id} error (${failures}), retry in ${delay}ms`, message, error)
  }

  /** 由调度器周期调用：重启处于退避期后到期的适配器 */
  async maintain(now = Date.now()): Promise<void> {
    if (!this.started) return
    for (const adapter of this.adapters) {
      const state = this.backoff.get(adapter.id)
      if (!state || now < state.nextAttemptAt) continue
      const health = adapter.health()
      if (health.status === 'ok') {
        this.backoff.delete(adapter.id)
        continue
      }
      console.log(`[manager] restarting adapter ${adapter.id}`)
      await adapter.stop().catch(() => undefined)
      await this.startOne(adapter)
    }
  }

  /** 重新探测所有适配器（用户点击"重新扫描"） */
  async rescan(): Promise<void> {
    for (const adapter of this.adapters) {
      this.backoff.delete(adapter.id)
      await adapter.stop().catch(() => undefined)
      await this.startOne(adapter)
    }
  }

  async stopAll(): Promise<void> {
    for (const adapter of this.adapters) {
      await adapter.stop().catch((error: unknown) => {
        console.error(`[manager] stop ${adapter.id} failed`, error)
      })
    }
    this.adapters = []
    this.started = false
  }

  getInfos(): AdapterInfo[] {
    const map = new Map<ToolId, AdapterInfo>()
    for (const adapter of this.adapters) {
      const info = adapter.info()
      const state = this.backoff.get(adapter.id)
      map.set(adapter.id, {
        ...info,
        status: state && state.failures > 0 && info.status === 'ok' ? 'degraded' : info.status,
        message: info.message
      })
    }
    // 未注册的工具也给出占位，界面保持 7 张卡稳定
    for (const tool of TOOL_IDS) {
      if (map.has(tool)) continue
      map.set(tool, {
        id: tool,
        displayName: tool,
        channel: 'process',
        capabilities: { tokens: false, liveStream: false, bridgeRequired: false },
        installed: false,
        dataPath: null,
        status: 'off',
        lastEventAt: null,
        errorCount: 0,
        message: '适配器未注册',
        eventsToday: 0
      })
    }
    return Array.from(map.values())
  }

  /** 桥接上报路由：按 tool 交给对应适配器，保留其健康度统计 */
  routeBridge(payload: BridgePayload): void {
    const adapter = this.adapters.find((a) => a.id === payload.tool)
    if (!adapter || !adapter.ingestBridge) {
      console.warn(`[manager] no bridge handler for ${payload.tool}`)
      return
    }
    adapter.ingestBridge(payload)
  }

  /** 探测哪些工具当前没有运行进程（用于结束任务） */
  async detectStoppedTools(): Promise<Set<ToolId>> {
    const stopped = new Set<ToolId>()
    for (const [tool, matchers] of Object.entries(PROCESS_MATCHERS)) {
      const running = await isAnyRunning(matchers).catch(() => true)
      if (!running) stopped.add(tool as ToolId)
    }
    return stopped
  }

  hasBridgeAdapter(tool: ToolId): boolean {
    return this.adapters.some((a) => a.id === tool && Boolean(a.ingestBridge))
  }
}
