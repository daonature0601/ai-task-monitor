import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { startOfDay } from '@shared/format'
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
import { StateInbox } from './collectors/state-inbox'
import { BatchWriter } from './core/batch-writer'
import { AdapterManager } from './core/adapter-manager'
import { BridgeServer } from './bridge/server'
import { Scheduler } from './core/scheduler'
import { buildSnapshot } from './core/snapshot'
import { evaluateTask } from './core/alerts'
import type { CursorStore } from './collectors/jsonl-tailer'

const EVENTS_COST_VERSION = 9

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
  stateInbox: { start: () => Promise<void>; stop: () => Promise<void> }
  /**
   * 重建历史索引：清空派生的任务/流水表与读取游标，按指定天数重新扫描日志。
   * 用于恢复因回填窗口过小而未导入的历史数据。
   */
  rebuildHistory: (days: number) => Promise<AppSettings>
  shutdown: () => Promise<void>
}

/**
 * 组装全部运行时依赖。调用顺序即为数据流顺序：
 * 适配器 → 状态机 → 批量写库 → 快照 → 界面/托盘
 */
export function createRuntime(
  db: Database.Database,
  options: {
    bridgeTokenFile: string
    /** 钩子脚本目录 */
    hooksDir: string
    /** 状态收件箱目录 */
    stateDir: string
    hooks: RuntimeHooks
  }
): Runtime {
  let settings = readSettings(db)
  let pricing = listPricing(db)
  let lastSnapshot: SnapshotPayload | null = null

  markStaleTasksEnded(db)

  // 历史任务补「项目名」：旧版本没有这一列，按工作目录末段回填一次
  const needProject = db
    .prepare('SELECT id, workspace FROM tasks WHERE project IS NULL AND workspace IS NOT NULL')
    .all() as Array<{ id: string; workspace: string }>
  if (needProject.length > 0) {
    const update = db.prepare('UPDATE tasks SET project = ? WHERE id = ?')
    const apply = db.transaction((rows: Array<{ id: string; workspace: string }>) => {
      for (const row of rows) {
        const seg = row.workspace.split('/').filter(Boolean).pop()
        if (seg) update.run(seg, row.id)
      }
    })
    apply(needProject)
    console.log(`[db] backfilled project for ${needProject.length} tasks`)
  }

  // 历史 Codex 任务改名：旧版本用的是工作目录名，这里按 session_index.jsonl
  // 的 thread_name 对齐到 Codex 侧边栏显示的会话名。
  try {
    const indexPath = join(homedir(), '.codex', 'session_index.jsonl')
    if (existsSync(indexPath)) {
      const titles = new Map<string, string>()
      for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
        const text = line.trim()
        if (!text) continue
        const obj = JSON.parse(text) as { id?: string; thread_name?: string }
        if (obj.id && obj.thread_name) titles.set(obj.id, obj.thread_name)
      }
      const rows = db
        .prepare("SELECT id, external_session_id, title FROM tasks WHERE tool = 'codex'")
        .all() as Array<{ id: string; external_session_id: string; title: string }>
      const update = db.prepare('UPDATE tasks SET title = ? WHERE id = ?')
      let renamed = 0
      db.transaction(() => {
        for (const row of rows) {
          const name = titles.get(row.external_session_id)
          if (!name || name === row.title) continue
          update.run(name, row.id)
          renamed += 1
        }
      })()
      if (renamed > 0) console.log(`[db] aligned ${renamed} codex task titles with session_index`)
    }
  } catch (error) {
    console.error('[runtime] align codex titles failed', error)
  }

  // 事件级费用回填：必须在 hydrate 之前完成 —— 否则内存里装载的是旧的任务费用，
  // 下一次落盘又会把它写回去，重算等于没做。
  if (settings.eventsCostVersion !== EVENTS_COST_VERSION) {
    const result = recomputeEventCosts(db, pricing)
    settings = writeSettings(db, { eventsCostVersion: EVENTS_COST_VERSION })
    console.log(
      `[db] recomputed event costs (${result.updated}/${result.total} rows) v${EVENTS_COST_VERSION}`
    )
  }

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
    },
    emitState: (signal) => {
      // 状态只由运行时信号驱动：写库 + 立即推送，避免界面滞后
      machine.applyState(signal)
      publish()
    }
  })

  // 运行时状态收件箱：hook / 心跳 / 进程 / 桥接把状态写进 inbox.jsonl，
  // 这里按字节游标增量读取，状态直接应用到状态机，不经过任何日志推断。
  const stateInbox = new StateInbox({
    dir: options.stateDir,
    cursors,
    onSignal: (signal) => {
      const result = machine.applyState(signal)
      if (!result.applied) return
      publish(true)
    },
    onError: (error) => console.error('[state] inbox failed', error)
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
    // 「今日」按北京时间切分，与界面显示口径一致
    const dayStart = new Date(startOfDay(now))
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
    stateInbox: {
      start: () => stateInbox.start(),
      stop: () => stateInbox.stop()
    },

    rebuildHistory: async (days) => {
      const window = Math.min(Math.max(Math.round(days) || 7, 1), 365)
      console.log(`[rebuild] 开始重建，回填窗口 ${window} 天`)
      scheduler.stop()
      await stateInbox.stop()
      await adapters.stopAll()
      // 任务与流水都是日志的派生数据，可以安全重建；
      // 设置与价目表属于用户配置，不动。
      db.prepare('DELETE FROM usage_events').run()
      db.prepare('DELETE FROM tasks').run()
      db.prepare('DELETE FROM file_cursors').run()
      machine.reset()
      settings = writeSettings(db, { backfillDays: window })
      await adapters.startAll()
      scheduler.start()
      publish(true)
      console.log('[rebuild] 适配器已按新窗口重启扫描')
      return settings
    },

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
  await runtime.stateInbox.start()
  await runtime.bridge.start()
  runtime.scheduler.start()
  runtime.publish()
  console.log('[runtime] started')
}
