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
  attachTurnStats,
  deleteTasksBefore,
  getTaskRow,
  listRecentTasks,
  markStaleTasksEnded,
  queryTasks,
  rowToSnapshot
} from './db/repositories/tasks'
import { listEventsForTask, listTaskTurns } from './db/repositories/usage'
import { recomputeEventCosts } from './db/repositories/event-cost'
import { rebuildTaskTurns, TURNS_VERSION } from './core/turn-backfill'
import { listCbIdeWorkspaceModels } from './collectors/codebuddy-ide'
import { appSupportDir } from './collectors/paths'
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

const EVENTS_COST_VERSION = 20

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

  // 尾部空轮次：用户发了一句但 AI 没有产出（中断 / 重发），
  // 它落在该任务最后一次事件之后，窗口内没有任何事件 —— 不进入轮次历史
  const tail = db
    .prepare(
      `DELETE FROM task_turns
        WHERE NOT EXISTS (
                SELECT 1 FROM usage_events e
                 WHERE e.task_id = task_turns.task_id
                   AND e.ts >= task_turns.started_at
                   AND e.ts < COALESCE(task_turns.ended_at, 9223372036854775807)
              )
          AND task_turns.started_at > COALESCE(
                (SELECT MAX(e2.ts) FROM usage_events e2 WHERE e2.task_id = task_turns.task_id), 0)`
    )
    .run()
  if (tail.changes > 0) console.log(`[turns] pruned ${tail.changes} tail turns without events`)

  // 空轮次清理：历史上同一秒的重试请求会留下「窗口内没有任何事件」的行，
  // 它们在轮次历史里显示成「0 in / 0 out」。只删除有同秒兄弟且自身无事件的行。
  const pruned = db
    .prepare(
      `DELETE FROM task_turns
        WHERE NOT EXISTS (
                SELECT 1 FROM usage_events e
                 WHERE e.task_id = task_turns.task_id
                   AND e.ts >= task_turns.started_at
                   AND e.ts < COALESCE(task_turns.ended_at, 9223372036854775807)
              )
          AND EXISTS (
                SELECT 1 FROM task_turns t2
                 WHERE t2.task_id = task_turns.task_id
                   AND t2.rowid <> task_turns.rowid
                   AND ABS(t2.started_at - task_turns.started_at) < 3000
              )`
    )
    .run()
  if (pruned.changes > 0) console.log(`[turns] pruned ${pruned.changes} empty turns`)

  // 孤儿事件清理：任务被删除（重建索引、手工清理）后，它的用量流水会留在表里，
  // 造成「任务累计 token ≠ 事件总量」。事件必须挂在存在的任务上。
  const orphans = db.prepare('DELETE FROM usage_events WHERE task_id NOT IN (SELECT id FROM tasks)').run()
  if (orphans.changes > 0) console.log(`[db] removed ${orphans.changes} orphan events`)

  // 补齐「当前这一轮」：轮次表是按源日志重建的，进行中的那一轮往往还没落盘，
  // 这里用车任务上的本轮边界补一条，保证抽屉的轮次首行 = 上方「本轮」。
  const repaired = db
    .prepare(
      `INSERT OR IGNORE INTO task_turns (task_id, started_at, ended_at)
       SELECT t.id, t.turn_started_at, t.turn_ended_at
         FROM tasks t
        WHERE t.turn_started_at IS NOT NULL
          -- 只有该时刻之后确实有用量事件，才说明这是一轮真实发生的对话；
          -- 续写分段的「开始」信号没有事件，补进来会多出一轮
          AND EXISTS (
                SELECT 1 FROM usage_events e
                 WHERE e.task_id = t.id AND e.ts >= t.turn_started_at
              )
          AND t.turn_started_at > COALESCE(
            (SELECT MAX(tt.started_at) FROM task_turns tt WHERE tt.task_id = t.id), 0)
          -- 还要求晚于上一轮的结束：续写分段的旧起点落在上一轮区间内，
          -- 不满足就会凭空补出一轮（Codex 的 22:28 就是这么来的）
          AND t.turn_started_at > COALESCE(
            (SELECT MAX(tt.ended_at) FROM task_turns tt WHERE tt.task_id = t.id), 0)`
    )
    .run()
  if (repaired.changes > 0) {
    console.log(`[turns] restored ${repaired.changes} current turns (from tasks.turn_started_at)`)
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

  // 任务行的 token / 费用必须等于事件之和。合并任务、重扫、游标重置都可能
  // 让两者短暂不一致（本轮有 3.25M 而会话累计只有 1.01M 就是这么来的）。
  // 每次启动只修正「不一致」的行，代价很小。
  const reconciled = db
    .prepare(
      `UPDATE tasks SET
         input_tokens = COALESCE((SELECT SUM(e.input_tokens) FROM usage_events e WHERE e.task_id = tasks.id), 0),
         output_tokens = COALESCE((SELECT SUM(e.output_tokens) FROM usage_events e WHERE e.task_id = tasks.id), 0),
         cache_read_tokens = COALESCE((SELECT SUM(e.cache_read_tokens) FROM usage_events e WHERE e.task_id = tasks.id), 0),
         cache_write_tokens = COALESCE((SELECT SUM(e.cache_write_tokens) FROM usage_events e WHERE e.task_id = tasks.id), 0),
         event_count = COALESCE((SELECT COUNT(*) FROM usage_events e WHERE e.task_id = tasks.id), 0),
         cost_usd = COALESCE((SELECT SUM(e.cost_usd) FROM usage_events e WHERE e.task_id = tasks.id), 0)
       WHERE ABS(input_tokens - COALESCE((SELECT SUM(e.input_tokens) FROM usage_events e WHERE e.task_id = tasks.id), 0)) > 1
          OR ABS(cache_read_tokens - COALESCE((SELECT SUM(e.cache_read_tokens) FROM usage_events e WHERE e.task_id = tasks.id), 0)) > 1
          OR ABS(cost_usd - COALESCE((SELECT SUM(e.cost_usd) FROM usage_events e WHERE e.task_id = tasks.id), 0)) > 0.01`
    )
    .run()
  if (reconciled.changes > 0) console.log(`[db] reconciled ${reconciled.changes} task totals`)

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

    // 概览卡片用的也是「本轮」口径，必须与列表 / 抽屉同源：
    // 内存里的计数在重启或重扫后会与库不一致，这里统一用事件聚合覆盖。
    try {
      attachTurnStats(db, snapshot.tasks)
    } catch (error) {
      console.error('[runtime] attach turn stats failed', error)
    }
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
      // 详情与列表必须同口径：本轮用量按事件时间重算，否则抽屉里的「本轮」会与列表不一致
      const [task] = attachTurnStats(db, [enrich(rowToSnapshot(row))])
      // 兜底：轮次表里没有「当前这一轮」时补一条，避免上方显示本轮、下方列表却没有它
      let turns = listTaskTurns(db, id)
      const currentStart = task.turnStartedAt
      if (currentStart && (!turns[0] || turns[0].startedAt < currentStart)) {
        db.prepare('INSERT OR IGNORE INTO task_turns (task_id, started_at, ended_at) VALUES (?, ?, ?)').run(
          id,
          currentStart,
          task.turnEndedAt ?? null
        )
        turns = listTaskTurns(db, id)
      }
      const latest = turns[0]
      // 「本轮」即最新一轮：源日志可能已经开新轮，而任务行还停在上一条，
      // 这里以轮次表为准，避免上方「本轮」与下方首行显示不同的两轮。
      // 无条件以轮次表首行为「本轮」：源日志可能比任务行滞后，两边各取一套
      // 就会出现「上面 14:33、下面 14:26」的矛盾。列表与详情必须同一行数据。
      if (latest) {
        task.turnStartedAt = latest.startedAt
        task.turnEndedAt = latest.endedAt ?? task.turnEndedAt
        task.turnInputTokens = latest.inputTokens
        task.turnOutputTokens = latest.outputTokens
        task.turnCacheReadTokens = latest.cacheReadTokens
        task.turnCacheWriteTokens = latest.cacheWriteTokens
        task.turnCostUsd = latest.costUsd
      }
      return { task, events: listEventsForTask(db, id, 300), turns }
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
  // CodeBuddy IDE 的模型补录：工作区索引里带 selectedModelId（本机 38/170 覆盖），
  // 适配器只对活跃会话推送模型，历史会话在这里一次性补齐。
  {
    const models = await listCbIdeWorkspaceModels(
      join(appSupportDir(), 'CodeBuddyExtension', 'Data')
    )
    if (models.size > 0) {
      const update = runtime.db.prepare(
        "UPDATE tasks SET model = ? WHERE tool = 'codebuddy' AND external_session_id = ? AND (model IS NULL OR model = '')"
      )
      let filled = 0
      runtime.db.transaction(() => {
        for (const [conversationId, model] of models) {
          filled += update.run(model, conversationId).changes
        }
      })()
      if (filled > 0) {
        console.log(`[model] filled ${filled} codebuddy tasks from workspace index`)
        // 模型是费用计算的前提：补上模型后必须按新模型重算一次事件费用，
        // 否则历史事件仍是「模型未知时算出的 0」，界面继续显示 —。
        const result = recomputeEventCosts(runtime.db, runtime.getPricing())
        console.log(`[model] repriced ${result.updated}/${result.total} events`)
      }
    }
  }


  // 轮次按源日志重建（版本变化时执行一次）：任务主表只保存「当前这一轮」的边界，
  // 历史轮次必须回到各工具的原始记录里还原。
  if ((runtime.getSettings().turnsVersion ?? 0) !== TURNS_VERSION) {
    const startedAt = Date.now()
    try {
      const result = await rebuildTaskTurns(runtime.db)
      runtime.updateSettings({ turnsVersion: TURNS_VERSION })
      console.log(
        `[turns] rebuilt ${result.rows} rows from ${result.spans} spans in ${Date.now() - startedAt}ms`
      )
    } catch (error) {
      console.error('[turns] rebuild failed', error)
    }
  }

  await runtime.adapters.startAll()
  await runtime.stateInbox.start()
  await runtime.bridge.start()
  runtime.scheduler.start()
  runtime.publish()
  console.log('[runtime] started')
}
