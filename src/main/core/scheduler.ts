import type { AppSettings } from '@shared/types'

export interface SchedulerDeps {
  settings: () => AppSettings
  /** 当前快照签名，用于判断是否需要推送 */
  signature: () => string
  isIdle: () => boolean
  onTick: (now: number) => void
  onProbe: () => Promise<void> | void
  onPublish: () => void
  onTray: () => void
  onFlush: (force?: boolean) => void
  onMaintain: () => Promise<void> | void
  onRetention: () => void
}

const IDLE_PUSH_FLOOR_MS = 10_000
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * 采集调度器：集中编排所有周期任务，空闲时自动降频。
 * 计时器职责单一，避免多个模块各自 setInterval 造成抖动。
 */
export class Scheduler {
  private timers: NodeJS.Timeout[] = []
  private started = false
  private lastPushAt = 0
  private lastSignature = ''

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.reschedule()
    this.timers.push(
      setInterval(() => {
        void this.deps.onMaintain()
      }, 5_000)
    )
    this.timers.push(
      setInterval(() => {
        this.deps.onRetention()
      }, RETENTION_INTERVAL_MS)
    )
    console.log('[scheduler] started')
  }

  /** 设置变更后重建周期（无需重启进程） */
  reschedule(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    if (!this.started) return

    const settings = this.deps.settings()
    this.timers.push(
      setInterval(() => {
        this.deps.onTick(Date.now())
        this.deps.onFlush(false)
      }, 1_000)
    )
    this.timers.push(
      setInterval(() => {
        void this.deps.onProbe()
      }, Math.max(2000, settings.processProbeMs))
    )
    this.timers.push(
      setInterval(() => {
        this.publishIfNeeded()
      }, Math.max(1000, settings.snapshotPushMs))
    )
    this.timers.push(
      setInterval(() => {
        this.deps.onTray()
      }, Math.max(2000, settings.trayRefreshMs))
    )
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    this.started = false
  }

  /** 有变化立即推送；无运行中任务时把最小间隔放宽到 10s */
  private publishIfNeeded(): void {
    const now = Date.now()
    const settings = this.deps.settings()
    const signature = this.deps.signature()
    const minGap = this.deps.isIdle() ? Math.max(IDLE_PUSH_FLOOR_MS, settings.snapshotPushMs) : 0

    if (signature === this.lastSignature && now - this.lastPushAt < minGap) return
    this.lastSignature = signature
    this.lastPushAt = now
    this.deps.onPublish()
  }

  forcePublish(): void {
    this.lastPushAt = Date.now()
    this.lastSignature = this.deps.signature()
    this.deps.onPublish()
  }
}
