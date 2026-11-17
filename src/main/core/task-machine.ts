import type {
  AppSettings,
  MonitorSummary,
  PricingRow,
  TaskSnapshot,
  ToolId,
  UsageDelta
} from '@shared/types'
import { computeCacheHitRate, startOfDay } from '@shared/format'
import { computeCost, matchPrice } from './pricing'
import { evaluateTask } from './alerts'

const SEEN_LIMIT = 120_000
/** 同一会话内两次事件间隔超过该阈值即视为新任务（连续活动段切分） */
const BURST_GAP_MS = 10 * 60_000
const SOURCE_WEIGHT: Record<TaskSnapshot['tokensSource'], number> = {
  native: 3,
  bridge: 2,
  partial: 1,
  unavailable: 0
}

export interface TaskMachineDeps {
  settings: () => AppSettings
  pricing: () => PricingRow[]
}

/**
 * 任务状态机：内存中维护实时任务视图，是界面与托盘的唯一数据源。
 * 写入数据库由 BatchWriter 从此处取脏任务，保证"内存先行、落库异步"。
 */
export class TaskMachine {
  private readonly tasks = new Map<string, TaskSnapshot>()
  /** 会话基础 id → 当前活跃任务 id（用于 burst 切分） */
  private readonly latestByBase = new Map<string, string>()
  private readonly seen = new Set<string>()
  private readonly seenOrder: string[] = []
  private dirty = new Set<string>()
  private settings: AppSettings
  private pricingRows: PricingRow[]
  private endedHook: ((task: TaskSnapshot) => void) | null = null

  constructor(private readonly deps: TaskMachineDeps) {
    this.settings = deps.settings()
    this.pricingRows = deps.pricing()
  }

  onEnded(hook: (task: TaskSnapshot) => void): void {
    this.endedHook = hook
  }

  hydrate(list: TaskSnapshot[]): void {
    for (const task of list) {
      this.tasks.set(task.id, { ...task, alerts: [] })
      this.dirty.add(task.id)
      const base = buildTaskId(task.tool, task.externalSessionId)
      const currentId = this.latestByBase.get(base)
      const current = currentId ? this.tasks.get(currentId) : undefined
      if (!current || task.lastEventAt > current.lastEventAt) {
        this.latestByBase.set(base, task.id)
      }
    }
    console.log(`[machine] hydrated ${list.length} tasks`)
  }

  refreshConfig(settings: AppSettings, pricing: PricingRow[]): void {
    this.settings = settings
    this.pricingRows = pricing
    for (const task of this.tasks.values()) this.recalculate(task, Date.now())
    for (const id of this.tasks.keys()) this.dirty.add(id)
  }

  /**
   * 处理一条归一化增量。
   * 关键规则：一个"任务"是会话内的一段连续活动（burst）。
   * 若与上一次事件间隔超过 BURST_GAP_MS，则开启新任务，
   * 否则 Codex/Claude 这类跨天存活的会话会显示成数百小时。
   */
  ingest(delta: UsageDelta): { applied: boolean; taskId: string } {
    const baseId = buildTaskId(delta.tool, delta.externalSessionId)
    const eventTs = delta.ts || Date.now()
    let taskId = this.latestByBase.get(baseId) ?? baseId
    let task = this.tasks.get(taskId)

    if (task && eventTs - task.lastEventAt > BURST_GAP_MS) {
      task = undefined
      taskId = `${baseId}~${eventTs}`
    }
    if (!task) taskId = this.tasks.has(taskId) ? `${baseId}~${eventTs}` : taskId

    const dedupe = `${taskId}#${delta.dedupeKey}`
    if (this.seen.has(dedupe)) return { applied: false, taskId }

    const now = Date.now()
    if (!task) {
      task = {
        id: taskId,
        tool: delta.tool,
        externalSessionId: delta.externalSessionId,
        title: delta.title?.trim() || shortTitle(delta.externalSessionId),
        workspace: delta.workspace,
        model: delta.model,
        status: 'running',
        // 心跳类数据源可给出真实的会话起始时间（早于首个事件）
        startedAt: Math.min(delta.startedAtHint ?? eventTs, eventTs, now),
        lastEventAt: eventTs,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        costKnown: false,
        cacheHitRate: null,
        tokensSource: delta.tokensSource,
        eventCount: 0,
        alerts: []
      }
      this.tasks.set(taskId, task)
      this.latestByBase.set(baseId, taskId)
    }

    this.remember(dedupe)
    this.latestByBase.set(baseId, taskId)

    // 心跳类数据源一开始可能只有临时目录名（如 "T"），后续更具体的标题应覆盖它
    const incomingTitle = delta.title?.trim()
    if (
      incomingTitle &&
      (delta.authoritativeTitle || !task.title || task.title.trim().length <= 2)
    ) {
      task.title = incomingTitle
    }
    if (delta.workspace && !task.workspace) task.workspace = delta.workspace
    if (delta.model) task.model = delta.model

    task.inputTokens += positive(delta.inputTokens)
    task.outputTokens += positive(delta.outputTokens)
    task.cacheReadTokens += positive(delta.cacheReadTokens)
    task.cacheWriteTokens += positive(delta.cacheWriteTokens)
    task.reasoningTokens += positive(delta.reasoningTokens)
    // 心跳只维持活跃度，不是用量事件，不计入事件数
    if (!delta.skipEventLog) task.eventCount += 1

    if (SOURCE_WEIGHT[delta.tokensSource] > SOURCE_WEIGHT[task.tokensSource]) {
      task.tokensSource = delta.tokensSource
    }

    task.lastEventAt = Math.max(task.lastEventAt, eventTs)
    // 历史回填（事件时间明显早于当前）不应把任务标为"运行中"
    const historical = now - task.lastEventAt > this.settings.idleThresholdMs * 2
    if (delta.endSignal || historical) {
      // 历史回填的同一活动段可能持续收到事件，结束时间与时长必须随之延伸
      task.endedAt = task.lastEventAt
      task.durationMs = Math.max(0, task.lastEventAt - task.startedAt)
      task.status = 'ended'
    } else {
      task.status = 'running'
      task.endedAt = undefined
    }

    this.recalculate(task, now)
    this.dirty.add(taskId)
    return { applied: true, taskId }
  }

  /** 每秒调用：推进时长、迁移状态、刷新告警 */
  tick(now = Date.now()): number {
    let changed = 0
    const idleMs = this.settings.idleThresholdMs
    const staleMs = Math.max(idleMs * 20, 30 * 60_000)

    for (const task of this.tasks.values()) {
      if (task.status === 'ended') continue
      const sinceEvent = now - task.lastEventAt

      if (task.status === 'running' && sinceEvent > idleMs) {
        task.status = 'idle'
        changed += 1
      } else if (task.status === 'idle' && sinceEvent > staleMs) {
        this.endTask(task, task.lastEventAt)
        changed += 1
        continue
      }

      task.durationMs = this.computeDuration(task, now)
      const flags = evaluateTask(task, this.settings, now)
      if (!sameFlags(flags, task.alerts)) {
        task.alerts = flags
        changed += 1
      }
      this.dirty.add(task.id)
    }
    return changed
  }

  /** 工具进程已退出：仅结束已空闲且超过判定窗口的任务，避免误杀 */
  endIdleForStoppedTools(stopped: Set<ToolId>, now = Date.now()): number {
    let ended = 0
    for (const task of this.tasks.values()) {
      if (task.status !== 'idle') continue
      if (!stopped.has(task.tool)) continue
      if (now - task.lastEventAt < this.settings.idleThresholdMs * 2) continue
      this.endTask(task, task.lastEventAt)
      ended += 1
    }
    return ended
  }

  endTask(task: TaskSnapshot, at: number): void {
    // 已结束的任务若收到更晚的结束时间，允许向后延伸（历史回填场景）
    if (task.status === 'ended' && (task.endedAt ?? 0) >= at) return
    task.status = 'ended'
    task.endedAt = at
    task.durationMs = Math.max(0, at - task.startedAt)
    task.alerts = evaluateTask(task, this.settings, at)
    this.dirty.add(task.id)
    this.endedHook?.(task)
  }

  getTask(id: string): TaskSnapshot | null {
    return this.tasks.get(id) ?? null
  }

  list(): TaskSnapshot[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.lastEventAt - a.lastEventAt)
  }

  /** 取走脏任务（供批量写库） */
  drainDirty(): TaskSnapshot[] {
    if (this.dirty.size === 0) return []
    const out: TaskSnapshot[] = []
    for (const id of this.dirty) {
      const task = this.tasks.get(id)
      if (task) out.push(task)
    }
    this.dirty = new Set()
    return out
  }

  hasDirty(): boolean {
    return this.dirty.size > 0
  }

  summary(now = Date.now()): MonitorSummary {
    const today = startOfDay(now)
    let runningCount = 0
    let idleCount = 0
    let todayTasks = 0
    let todayInputTokens = 0
    let todayOutputTokens = 0
    let todayCacheReadTokens = 0
    let todayCacheWriteTokens = 0
    let todayCostUsd = 0
    let runningCostUsd = 0

    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        runningCount += 1
        runningCostUsd += task.costUsd
      } else if (task.status === 'idle') {
        idleCount += 1
        runningCostUsd += task.costUsd
      }
      if (task.startedAt >= today) {
        todayTasks += 1
        todayInputTokens += task.inputTokens
        todayOutputTokens += task.outputTokens
        todayCacheReadTokens += task.cacheReadTokens
        todayCacheWriteTokens += task.cacheWriteTokens
        todayCostUsd += task.costUsd
      }
    }

    const denom = todayInputTokens + todayCacheReadTokens + todayCacheWriteTokens
    return {
      runningCount,
      idleCount,
      todayTasks,
      todayInputTokens,
      todayOutputTokens,
      todayCacheReadTokens,
      todayCostUsd,
      avgCacheHitRate: denom > 0 ? todayCacheReadTokens / denom : null,
      runningCostUsd
    }
  }

  private recalculate(task: TaskSnapshot, now: number): void {
    const price = matchPrice(task.model, this.pricingRows)
    // 只有原生落盘/桥接上报的完整 token 拆分、且模型单价已核实，才可计价；
    // partial（如 WorkBuddy 上下文占用量）、unavailable 与「待确认」价目一律为 0，
    // 界面据 costKnown 显示 "—"，不做任何推算。
    const billable =
      (task.tokensSource === 'native' || task.tokensSource === 'bridge') && !price.pending
    task.costKnown = billable
    task.costUsd = billable ? computeCost(task, price.row) : 0
    task.cacheHitRate = computeCacheHitRate(task)
    task.durationMs = this.computeDuration(task, now)
    task.alerts = evaluateTask(task, this.settings, now)
  }

  private computeDuration(task: TaskSnapshot, now: number): number {
    if (task.status === 'ended' && task.endedAt) {
      return Math.max(0, task.endedAt - task.startedAt)
    }
    return Math.max(0, now - task.startedAt)
  }

  private remember(key: string): void {
    this.seen.add(key)
    this.seenOrder.push(key)
    if (this.seenOrder.length > SEEN_LIMIT) {
      const drop = this.seenOrder.splice(0, Math.floor(SEEN_LIMIT * 0.2))
      for (const key of drop) this.seen.delete(key)
    }
  }
}

export function buildTaskId(tool: ToolId, externalSessionId: string): string {
  return `${tool}:${externalSessionId}`
}

function shortTitle(id: string): string {
  return id.length > 12 ? `会话 ${id.slice(0, 8)}` : `会话 ${id}`
}

function positive(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0
  if (!Number.isFinite(value) || value <= 0) return 0
  return value
}

function sameFlags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}
