import type Database from 'better-sqlite3'
import type {
  AppSettings,
  BridgeStatus,
  PricingRow,
  SnapshotPayload,
  StatsPayload,
  TaskDetail,
  TaskQuery,
  TaskSnapshot
} from '@shared/types'
import {
  listPricing,
  readSettings,
  replacePricing,
  writeSettings
} from './db/repositories/settings'
import { getCursor, pruneCursors, setCursor } from './db/repositories/cursors'
import {
  deleteTasksBefore,
  getTaskRow,
  listRecentTasks,
  markStaleTasksEnded,
  queryTasks,
  rowToSnapshot
} from './db/repositories/tasks'
import { listEventsForTask } from './db/repositories/usage'
import { recomputeEventCosts } from './db/repositories/event-cost'
import { buildStats, summaryFor } from './db/repositories/stats'
import { TaskMachine } from './core/task-machine'
import { BatchWriter } from './core/batch-writer'
import { AdapterManager } from './core/adapter-manager'
import { BridgeServer } from './bridge/server'
import { Scheduler } from './core/scheduler'
import { buildSnapshot } from './core/snapshot'
import { evaluateTask } from './core/alerts'
import type { CursorStore } from './collectors/jsonl-tailer'

const EVENTS_COST_VERSION = 2

export interface RuntimeHooks {
  onSnapshot: (snapshot: SnapshotPayload) => void
  onTray: () => void
}

export interface Runtime {
  db: Database.Database
  machine: TaskMachine
  writer: BatchWriter
  adapters: AdapterManager
  bridge: BridgeServer
  scheduler: Scheduler
  getSettings: () => AppSettings
  getPricing: () => PricingRow[]
  updateSettings: (patch: Partial<AppSettings>) => AppSettings
  updatePricing: (rows: PricingRow[]) => PricingRow[]
  getSnapshot: () => SnapshotPayload | null
  publish: () => void
  queryTasks: (query: TaskQuery) => { rows: TaskSnapshot[]; total: number }
  getTaskDetail: (id: string) => TaskDetail | null
  getStats: (from: number, to: number) => StatsPayload
  bridgeStatus: () => BridgeStatus
  shutdown: () => Promise<void>
}

/**
 * 组装全部运行时依赖。调用顺序即为数据流顺序：
 * 适配器 → 状态机 → 批量写库 → 快照 → 界面/托盘
 */
export function createRuntime(
  db: Database.Database,
  options: { bridgeTokenFile: string; hooks: RuntimeHooks }
): Runtime {
  let settings = readSettings(db)
  let pricing = listPricing(db)
  let lastSnapshot: SnapshotPayload | null = null

  markStaleTasksEnded(db)

  const machine = new TaskMachine({ settings: () => settings, pricing: () => pricing })
  machine.hydrate(listRecentTasks(db, 800))
  // 心跳事件不再计入 event_count：清零历史遗留计数，
  // 否则会出现「0 token / 0 费用」却显示上百次事件的矛盾展示。
  for (const task of machine.list()) {
    const tokens =
      task.inputTokens + task.outputTokens + task.cacheReadTokens + task.cacheWriteTokens
    if (task.tokensSource === 'unavailable' && tokens === 0 && task.eventCount > 0) {
      task.eventCount = 0
    }
  }
  // 价目表口径可能已升级（如新增「待确认」态），启动时按当前价目重算成本标记
  machine.refreshConfig(settings, pricing)

  // 事件级费用回填：历史事件的模型名可能缺失，导致区间统计偏低
  if (settings.eventsCostVersion !== EVENTS_COST_VERSION) {
    const result = recomputeEventCosts(db, pricing)
    settings = writeSettings(db, { eventsCostVersion: EVENTS_COST_VERSION })
    console.log(
      `[db] recomputed event costs (${result.updated}/${result.total} rows) v${EVENTS_COST_VERSION}`
    )
  }

  const writer = new BatchWriter(() => db, machine, () => pricing)

  const cursors: CursorStore = {
    get: (path) => {
      const row = getCursor(db, path)
      return row ? { offset: row.offset, inode: row.inode } : null
    },
    set: (path, offset, inode, mtimeMs) =>
      setCursor(db, { path, offset, inode, mtime: mtimeMs })
  }

  const adapters = new AdapterManager({
    settings: () => settings,
    pricing: () => pricing,
    cursors,
    emit: (delta) => {
      const result = machine.ingest(delta)
      if (!result.applied) return
      // 心跳类事件只用于维持活跃度，不写入用量流水（否则每 30s 一行纯噪声）
      if (delta.skipEventLog) return
      writer.enqueue(result.taskId, delta, machine.getTask(result.taskId)?.model)
    }
  })

  const bridge = new BridgeServer({
    enabled: () => settings.bridgeEnabled,
    preferredPort: () => settings.bridgePort,
    tokenFile: options.bridgeTokenFile,
    onUsage: (payload) => adapters.routeBridge(payload)
  })

  /**
   * 推送快照。force=true 时跳过 500ms 去抖，
   * 用于币种切换等"必须立刻可见"的设置变更。
   */
  const publish = (force = false): void => {
    const now = Date.now()
    // 托盘与界面共用同一份「今日」口径：按用量事件时间归集的数据库汇总
    const dayStart = new Date(now)
    dayStart.setHours(0, 0, 0, 0)
    let summary: ReturnType<typeof summaryFor> | undefined
    try {
      summary = summaryFor(db, dayStart.getTime(), now)
    } catch (error) {
      console.error('[runtime] summary failed, fallback to memory', error)
    }
    const snapshot = buildSnapshot({
      machine,
      adapters: adapters.getInfos(),
      settings,
      now,
      summary
    })
    const previous = lastSnapshot
    lastSnapshot = snapshot
    if (!force && previous && snapshot.generatedAt - previous.generatedAt < 500) return
    options.hooks.onSnapshot(snapshot)
  }

  const scheduler = new Scheduler({
    settings: () => settings,
    signature: () => (lastSnapshot ? `${lastSnapshot.summary.runningCount}:${Math.round(lastSnapshot.summary.todayCostUsd * 1e6)}` : 'none'),
    isIdle: () => machine.summary().runningCount === 0,
    onTick: (now) => {
      if (machine.tick(now) > 0) publish()
    },
    onProbe: async () => {
      const stopped = await adapters.detectStoppedTools()
      if (machine.endIdleForStoppedTools(stopped) > 0) publish()
    },
    onPublish: publish,
    onTray: () => options.hooks.onTray(),
    onFlush: (force) => {
      writer.flush(force)
    },
    onMaintain: async () => {
      await adapters.maintain()
    },
    onRetention: () => {
      const cutoff = Date.now() - settings.retentionDays * 86_400_000
      const removed = deleteTasksBefore(db, cutoff)
      const cursorsRemoved = pruneCursors(db, cutoff)
      if (removed > 0 || cursorsRemoved > 0) {
        console.log(`[retention] removed ${removed} tasks / ${cursorsRemoved} cursors`)
      }
    }
  })

  machine.onEnded(() => {
    writer.flush(true)
  })

  const enrich = (task: TaskSnapshot): TaskSnapshot => ({
    ...task,
    alerts: evaluateTask(task, settings)
  })

  const runtime: Runtime = {
    db,
    machine,
    writer,
    adapters,
    bridge,
    scheduler,
    getSettings: () => settings,
    getPricing: () => pricing,
    updateSettings: (patch) => {
      const before = settings
      settings = writeSettings(db, patch)
      machine.refreshConfig(settings, pricing)
      if (
        before.bridgePort !== settings.bridgePort ||
        before.bridgeEnabled !== settings.bridgeEnabled
      ) {
        void bridge.stop().then(() => bridge.start())
      }
      scheduler.reschedule()
      // 立即推送：币种、汇率等展示项无需等待下一个调度周期
      publish(true)
      options.hooks.onTray()
      return settings
    },
    updatePricing: (rows) => {
      pricing = replacePricing(db, rows)
      machine.refreshConfig(settings, pricing)
      publish(true)
      return pricing
    },
    getSnapshot: () => lastSnapshot,
    publish,
    queryTasks: (query) => {
      const result = queryTasks(db, query)
      return { rows: result.rows.map(enrich), total: result.total }
    },
    getTaskDetail: (id) => {
      const row = getTaskRow(db, id)
      if (!row) return null
      const task = enrich(rowToSnapshot(row))
      return { task, events: listEventsForTask(db, id, 300) }
    },
    getStats: (from, to) => buildStats(db, from, to),
    bridgeStatus: () => bridge.status(),
    shutdown: async () => {
      scheduler.stop()
      await adapters.stopAll()
      await bridge.stop()
      writer.flush(true)
    }
  }

  return runtime
}

export async function startRuntime(runtime: Runtime): Promise<void> {
  await runtime.adapters.startAll()
  await runtime.bridge.start()
  runtime.scheduler.start()
  runtime.publish()
  console.log('[runtime] started')
}
