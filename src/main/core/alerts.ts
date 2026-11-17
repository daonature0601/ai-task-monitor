import type { AlertItem, AlertKind, AppSettings, TaskSnapshot } from '@shared/types'
import { ALERT_LABEL, formatCost, formatRate } from '@shared/format'

/** 缓存命中率告警的最小样本量，避免 1~2 次调用的小任务被误判 */
const CACHE_ALERT_MIN_TOKENS = 1000

/**
 * 任务告警判定（纯函数，可单测）。
 * 返回去重后的告警类型列表，顺序固定便于界面稳定渲染。
 */
export function evaluateTask(
  task: TaskSnapshot,
  settings: AppSettings,
  now = Date.now()
): AlertKind[] {
  const flags: AlertKind[] = []
  const duration =
    task.status === 'ended' && task.endedAt ? task.endedAt - task.startedAt : now - task.startedAt

  if (task.costUsd >= settings.alertCostDangerUsd) flags.push('cost_danger')
  else if (task.costUsd >= settings.alertCostWarnUsd) flags.push('cost_warn')

  if (duration >= settings.alertDurationDangerMs) flags.push('duration_danger')
  else if (duration >= settings.alertDurationWarnMs) flags.push('duration_warn')

  const sample = task.inputTokens + task.cacheReadTokens + task.cacheWriteTokens
  if (
    task.cacheHitRate !== null &&
    sample >= CACHE_ALERT_MIN_TOKENS &&
    task.cacheHitRate < settings.alertCacheHitMinRate
  ) {
    flags.push('cache_low')
  }

  return flags
}

export function alertMessage(kind: AlertKind, task: TaskSnapshot, settings: AppSettings): string {
  switch (kind) {
    case 'cost_danger':
      return `${task.title} 费用已达 ${formatCost(task.costUsd, 'USD')}，超过 ${formatCost(settings.alertCostDangerUsd, 'USD')} 警示线`
    case 'cost_warn':
      return `${task.title} 费用达 ${formatCost(task.costUsd, 'USD')}，超过 ${formatCost(settings.alertCostWarnUsd, 'USD')} 提醒线`
    case 'duration_danger':
      return `${task.title} 已运行超过 ${Math.round(settings.alertDurationDangerMs / 60000)} 分钟`
    case 'duration_warn':
      return `${task.title} 已运行超过 ${Math.round(settings.alertDurationWarnMs / 60000)} 分钟`
    case 'cache_low':
      return `${task.title} 输入缓存命中率仅 ${formatRate(task.cacheHitRate)}，低于 ${formatRate(settings.alertCacheHitMinRate)}`
    default:
      return `${task.title} 采集异常`
  }
}

export function buildAlertItems(
  tasks: TaskSnapshot[],
  settings: AppSettings,
  now = Date.now()
): AlertItem[] {
  const items: AlertItem[] = []
  for (const task of tasks) {
    for (const kind of task.alerts) {
      if (kind === 'adapter_error') continue
      items.push({
        id: `${task.id}:${kind}`,
        taskId: task.id,
        title: task.title,
        tool: task.tool,
        kind,
        message: alertMessage(kind, task, settings),
        raisedAt: now
      })
    }
  }
  const weight: Record<AlertKind, number> = {
    cost_danger: 0,
    duration_danger: 1,
    cost_warn: 2,
    duration_warn: 3,
    cache_low: 4,
    adapter_error: 5
  }
  return items.sort((a, b) => weight[a.kind] - weight[b.kind]).slice(0, 30)
}

export function alertLabel(kind: AlertKind): string {
  return ALERT_LABEL[kind] ?? kind
}
