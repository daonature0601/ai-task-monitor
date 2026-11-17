import type {
  AdapterInfo,
  AppSettings,
  MonitorSummary,
  SnapshotPayload,
  TaskSnapshot
} from '@shared/types'
import { buildAlertItems } from './alerts'
import type { TaskMachine } from './task-machine'

export interface SnapshotInput {
  machine: TaskMachine
  adapters: AdapterInfo[]
  settings: AppSettings
  now?: number
  /** 外部注入的汇总（按用量事件时间归集），保证与统计页同源 */
  summary?: MonitorSummary
}

/**
 * 构建推送给界面/托盘的快照：
 * 只包含运行中、空闲任务与最近 40 条已结束任务，避免长历史撑大 IPC 载荷。
 */
export function buildSnapshot(input: SnapshotInput): SnapshotPayload {
  const now = input.now ?? Date.now()
  const all = input.machine.list()
  const live = all.filter((t) => t.status !== 'ended')
  const recentEnded = all.filter((t) => t.status === 'ended').slice(0, 40)
  const tasks = [...live, ...recentEnded]
  const summary = input.summary ?? input.machine.summary(now)

  return {
    generatedAt: now,
    tasks,
    summary,
    adapters: input.adapters,
    alerts: buildAlertItems(live, input.settings, now),
    paused: input.settings.paused,
    currency: input.settings.currency,
    fxRate: input.settings.fxRate
  }
}

/** 托盘与界面共用的稳定签名，用于判断是否需要重绘 */
export function snapshotSignature(snapshot: SnapshotPayload): string {
  const { runningCount, todayCostUsd, todayTasks } = snapshot.summary
  const firstTask = snapshot.tasks[0]
  return [
    runningCount,
    Math.round(todayCostUsd * 1e6),
    todayTasks,
    snapshot.adapters.filter((a) => a.status !== 'off').length,
    firstTask ? `${firstTask.id}:${firstTask.lastEventAt}` : 'none'
  ].join('|')
}

export function rankTasks(tasks: TaskSnapshot[]): TaskSnapshot[] {
  const weight: Record<TaskSnapshot['status'], number> = { running: 0, idle: 1, ended: 2 }
  return [...tasks].sort((a, b) => {
    const diff = weight[a.status] - weight[b.status]
    if (diff !== 0) return diff
    return b.lastEventAt - a.lastEventAt
  })
}
