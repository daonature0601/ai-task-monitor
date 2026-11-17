import { Menu, Tray, app } from 'electron'
import type { SnapshotPayload } from '@shared/types'
import { formatCost, formatDurationShort, formatTokens, turnElapsed } from '@shared/format'
import { createTrayIcon } from './assets/tray-icon'

export interface TrayDeps {
  snapshot: () => SnapshotPayload | null
  onTogglePause: () => void
  onShow: () => void
  onQuit: () => void
}

/**
 * 菜单栏/托盘控制器。
 * 缩略信息：进行中任务数 + 实时累计费用；展开后逐行展示每个任务（工具 · 时长 · 费用）。
 * 仅在文案变化时重建菜单，避免高频刷新造成的闪烁与 CPU 占用。
 */
export class TrayController {
  private tray: Tray | null = null
  private lastKey = ''
  private lastActive = false

  constructor(private readonly deps: TrayDeps) {}

  init(): void {
    if (this.tray) return
    this.tray = new Tray(createTrayIcon(false))
    this.tray.setToolTip('AI Task Monitor · 暂无运行中任务')
    this.tray.on('click', () => {
      if (process.platform === 'darwin') this.deps.onShow()
      else this.deps.onShow()
    })
    this.update(true)
  }

  update(force = false): void {
    if (!this.tray) return
    const snapshot = this.deps.snapshot()
    if (!snapshot) {
      this.setTitle('—')
      return
    }

    const { summary, currency, fxRate } = snapshot
    const idleCount = summary.idleCount
    const activeCount = summary.runningCount + idleCount
    const active = activeCount > 0
    const live = snapshot.tasks.filter((t) => t.status !== 'ended').slice(0, 5)
    const key = [
      active,
      activeCount,
      summary.runningCount,
      idleCount,
      Math.round(summary.runningCostUsd * 1000),
      snapshot.paused,
      live.map((t) => `${t.id}:${Math.floor(t.durationMs / 1000)}:${Math.round(t.costUsd * 1000)}`).join(',')
    ].join('|')

    if (!force && key === this.lastKey) return
    this.lastKey = key

    if (active !== this.lastActive) {
      this.lastActive = active
      this.tray.setImage(createTrayIcon(active))
    }

    const costText = formatCost(summary.runningCostUsd, currency, fxRate)
    this.setTitle(active ? `${activeCount} · ${costText}` : costText)
    this.tray.setToolTip(
      active
        ? `${activeCount} 个任务进行中（运行中 ${summary.runningCount} / 静默 ${idleCount}）· 实时费用 ${costText}`
        : `AI Task Monitor · 今日 ${formatCost(summary.todayCostUsd, currency, fxRate)}`
    )

    const items: Electron.MenuItemConstructorOptions[] = [
      {
        label: active
          ? `${activeCount} 个任务进行中（运行中 ${summary.runningCount} / 静默 ${idleCount}）`
          : '暂无进行中任务',
        enabled: false
      },
      {
        label: `今日 ${summary.todayTasks} 个任务 · ${formatTokens(summary.todayInputTokens + summary.todayOutputTokens)} tokens · ${formatCost(summary.todayCostUsd, currency, fxRate)}`,
        enabled: false
      },
      { type: 'separator' }
    ]

    if (live.length === 0) {
      items.push({ label: '开始使用任一 AI 工具，数据会自动出现', enabled: false })
    } else {
      for (const task of live) {
        items.push({
          // 与界面一致：显示当次问答的耗时，而不是整段会话
          label: `${task.title} · ${formatDurationShort(turnElapsed(task))} · ${formatCost(task.costUsd, currency, fxRate)}`,
          click: () => this.deps.onShow()
        })
      }
    }

    items.push(
      { type: 'separator' },
      {
        label: snapshot.paused ? '继续采集' : '暂停采集',
        click: () => this.deps.onTogglePause()
      },
      { label: '显示主窗口', click: () => this.deps.onShow() },
      { type: 'separator' },
      { label: `AI Task Monitor ${app.getVersion()}`, enabled: false },
      { label: '退出', click: () => this.deps.onQuit() }
    )

    this.tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  private setTitle(title: string): void {
    if (!this.tray) return
    if (process.platform === 'darwin') this.tray.setTitle(` ${title}`, { fontType: 'monospacedDigit' })
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
