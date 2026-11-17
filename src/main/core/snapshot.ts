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
/** 零时长且已结束 = 只有回合信号、没有实际推进的空回合 */
export function isEmptyRound(task: {
  status: string
  turnStartedAt: number
  turnEndedAt?: number
  endedAt?: number
  lastEventAt: number
  eventCount?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): boolean {
  if (task.status !== 'ended') return false
  // 只有标题、没有任何用量事件的会话（多为中断的对话）不进入列表
  const events = task.eventCount ?? 0
  const tokens =
    (task.inputTokens ?? 0) + (task.outputTokens ?? 0) + (task.cacheReadTokens ?? 0) + (task.cacheWriteTokens ?? 0)
  if (events === 0 && tokens === 0) return true
  const end = task.turnEndedAt ?? task.endedAt ?? task.lastEventAt
  return end <= task.turnStartedAt
}

export function buildSnapshot(input: SnapshotInput): SnapshotPayload {
  const now = input.now ?? Date.now()
  // 零长度的已结束任务（只有回合开始信号、没有任何推进）在列表里没有信息量，
  // 直接隐藏；它们可能仍带着历史 token，但用量统计走 usage_events，不受影响。
  const all = input.machine.list().filter((task) => !isEmptyRound(task))
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
