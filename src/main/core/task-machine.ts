import type {
  AppSettings,
  MonitorSummary,
  PricingRow,
  StateSignal,
  StateSource,
  TaskSnapshot,
  ToolId,
  UsageDelta
} from '@shared/types'
import { computeCacheHitRate, dayKey, startOfDay } from '@shared/format'
import { computeCost, matchPrice } from './pricing'
import { evaluateTask } from './alerts'

const SEEN_LIMIT = 120_000
/** 同一会话内两次事件间隔超过该阈值即视为新任务（连续活动段切分） */
const BURST_GAP_MS = 10 * 60_000
/** 状态来源的可信度：hook 最权威，process 最粗，none 表示没有运行时通道 */
const STATE_WEIGHT: Record<StateSource, number> = {
  hook: 5,
  bridge: 4,
  io: 3,
  heartbeat: 2,
  process: 1,
  none: 0
}

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
    let isBackfill = false

    // 乱序 / 历史回填：事件明显早于当前活动段的起点（例如合并进来的子代理
    // 昨天写的日志），不能塞进今天正在进行的任务，否则时间线会出现"昨天的时间"。
    // 这类事件按「天」聚合到独立的历史任务里。
    if (task && eventTs < task.startedAt - BURST_GAP_MS) {
      isBackfill = true
      taskId = `${baseId}~h${dayKey(eventTs)}`
      task = this.tasks.get(taskId)
    } else if (task && eventTs - task.lastEventAt > BURST_GAP_MS) {
      task = undefined
      taskId = `${baseId}~${eventTs}`
    }
    if (!task && !isBackfill) taskId = this.tasks.has(taskId) ? `${baseId}~${eventTs}` : taskId

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
        // 状态不由日志事件决定，等运行时状态信号；未收到前标记为未知来源
        status: 'idle',
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
        stateSource: 'none',
        lastStateAt: null,
        turnStartedAt: Math.min(delta.startedAtHint ?? eventTs, eventTs, now),
        alerts: []
      }
      this.tasks.set(taskId, task)
      if (!isBackfill) this.latestByBase.set(baseId, taskId)
    }

    this.remember(dedupe)
    if (!isBackfill) this.latestByBase.set(baseId, taskId)

    // 心跳类数据源一开始可能只有临时目录名（如 "T"），后续更具体的标题应覆盖它
    const incomingTitle = delta.title?.trim()
    if (
      incomingTitle &&
      (delta.authoritativeTitle || !task.title || task.title.trim().length <= 2)
    ) {
      task.title = incomingTitle
    }
    if (delta.workspace && !task.workspace) task.workspace = delta.workspace
    if (delta.project && task.project !== delta.project) task.project = delta.project
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

    // 当次问答边界：来自工具自身的 turn 事件（Codex task_started/task_complete、
    // Claude Code user 消息、hook 的 UserPromptSubmit）
    if (delta.turnStart) {
      task.turnStartedAt = Math.min(delta.startedAtHint ?? eventTs, eventTs, now)
      task.turnEndedAt = undefined
    } else if (delta.turnEnd && task.turnEndedAt === undefined) {
      task.turnEndedAt = eventTs
    }
    // 历史回填的同一活动段可能持续收到事件，结束时间与时长必须随之延伸。
    // 注意：这里只维护时间边界，**不再根据事件时间推断运行状态** ——
    // 状态由 applyState() 接收的运行时信号决定。
    const backfillEnded =
      task.stateSource === 'none' && now - task.lastEventAt > this.settings.idleThresholdMs * 2
    // 无任何运行时通道时（stateSource === 'none'）才回落到日志推断，
    // 且该任务会被标记来源，界面上可区分「Hook 状态」与「日志推断」。
    const logInferred = task.stateSource === 'none' && !backfillEnded && !delta.endSignal
    if (delta.endSignal || backfillEnded) {
      task.endedAt = task.lastEventAt
      task.durationMs = Math.max(0, task.lastEventAt - task.startedAt)
      task.status = 'ended'
    } else if (logInferred) {
      task.status = 'running'
      task.endedAt = undefined
    }

    this.recalculate(task, now)
    this.dirty.add(taskId)
    return { applied: true, taskId }
  }

  /**
   * 应用运行时状态信号 —— 任务状态的唯一权威来源。
   *
   * 与 ingest() 的分工：
   *  - ingest() 只负责 token / 费用 / 标题等「用量」信息
   *  - applyState() 负责 running / idle / ended 的迁移
   * 这样「状态」不再由日志里有没有新行推断出来。
   */
  applyState(signal: StateSignal): { applied: boolean; taskId: string } {
    const baseId = buildTaskId(signal.tool, signal.sessionId)
    const eventTs = signal.ts || Date.now()
    const now = Date.now()

    let taskId = this.latestByBase.get(baseId) ?? baseId
    let task = this.tasks.get(taskId)

    // 同一会话内的状态信号间隔过大，视为新一段工作
    if (task) {
      const anchor = task.lastStateAt ?? task.startedAt
      if (eventTs - anchor > BURST_GAP_MS) {
        task = undefined
        taskId = `${baseId}~${eventTs}`
      }
    }

    // 「进程存在」是最弱的信号：它只能证明应用开着，不能证明有人在用。
    // 因此它只用于维持已有任务的状态，绝不凭空新建任务 ——
    // 否则打开 DeepSeek Harness / 元宝这类无本地落盘的工具就会冒出一个"进程会话"。
    if (!task && signal.source === 'process') {
      return { applied: false, taskId }
    }

    if (!task) {
      task = {
        id: taskId,
        tool: signal.tool,
        externalSessionId: signal.sessionId,
        title: signal.title?.trim() || shortTitle(signal.sessionId),
        workspace: signal.workspace,
        model: signal.model,
        status: signal.phase === 'end' ? 'ended' : 'running',
        startedAt: Math.min(signal.startedAtHint ?? eventTs, eventTs, now),
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
        tokensSource: 'unavailable',
        eventCount: 0,
        stateSource: signal.source,
        lastStateAt: eventTs,
        turnStartedAt: Math.min(signal.startedAtHint ?? eventTs, eventTs, now),
        alerts: []
      }
      this.tasks.set(taskId, task)
      this.latestByBase.set(baseId, taskId)
    }

    // 来源只允许「升级」：hook 信号一旦出现，不被进程探活降级
    if (STATE_WEIGHT[signal.source] > STATE_WEIGHT[task.stateSource]) {
      task.stateSource = signal.source
    }

    const incomingTitle = signal.title?.trim()
    if (incomingTitle && (!task.title || task.title.trim().length <= 2)) {
      task.title = incomingTitle
    }
    if (signal.workspace && !task.workspace) task.workspace = signal.workspace
    if (signal.project && !task.project) task.project = signal.project
    if (signal.model) task.model = signal.model
    const previousStateAt = task.lastStateAt ?? 0
    task.lastStateAt = Math.max(previousStateAt, eventTs)

    // 当次问答边界：
    //  - phase=start（hook 的 UserPromptSubmit）是精确起点
    //  - 没有轮次事件的工具（心跳 / io / 进程），用「这一段活跃的起点」作为本轮起点，
    //    避免把整段会话的开始时间当成当前问答的开始时间
    const resumed = eventTs - previousStateAt > this.settings.idleThresholdMs
    if (signal.phase === 'start') {
      task.turnStartedAt = eventTs
      task.turnEndedAt = undefined
    } else if (signal.phase === 'active' && (resumed || previousStateAt === 0)) {
      task.turnStartedAt = eventTs
      task.turnEndedAt = undefined
    } else if (signal.phase === 'end' && task.turnEndedAt === undefined) {
      task.turnEndedAt = eventTs
    }

    if (signal.phase === 'end') {
      this.endTask(task, eventTs)
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
      // 状态 TTL 基于「最近一次运行时状态信号」，而不是日志事件时间。
      // stateSource === 'none' 表示该工具没有任何运行时通道，此时不做运行态推断，
      // 只把早已无信号的历史任务收尾，避免永久挂在进行中。
      const anchor = task.lastStateAt ?? task.startedAt
      const sinceState = now - anchor

      if (task.stateSource === 'none') {
        // 没有任何运行时通道：只能按日志事件时间维持最粗的活性判断，
        // 这类任务在界面上标记为「推断」状态。
        const sinceEvent = now - task.lastEventAt
        if (task.status === 'running' && sinceEvent > idleMs) {
          task.status = 'idle'
          changed += 1
        } else if (task.status === 'idle' && sinceEvent > staleMs) {
          this.endTask(task, task.lastEventAt)
          changed += 1
          continue
        }
      } else if (task.status === 'running' && sinceState > idleMs) {
        task.status = 'idle'
        changed += 1
      } else if (task.status === 'idle' && sinceState > staleMs) {
        this.endTask(task, anchor)
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
  /** 清空内存状态（重建历史索引时使用，数据库已先行清空） */
  reset(): void {
    this.tasks.clear()
    this.latestByBase.clear()
    this.seen.clear()
    this.seenOrder.length = 0
    this.dirty.clear()
  }

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
