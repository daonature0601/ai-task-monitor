import { writeFile } from 'node:fs/promises'
import { app, dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc-contract'
import { PRICING_SEED } from '@shared/defaults'
import type { AppSettings, PricingRow, ToolId } from '@shared/types'
import { computeCacheHitRate, formatTimeFull, turnElapsed } from '@shared/format'
import { buildUserscript, scriptFileName } from '../bridge/userscripts'
import type { Runtime } from '../runtime'
import { getMainWindow, showMainWindow } from '../window'
import { hookStatus, installHooks, removeHooks } from '../hooks/installer'
import { appConfigDir } from '../collectors/paths'
import { join } from 'node:path'

/** 钩子脚本统一放在用户数据目录下，便于清理 */
function hooksDir(): string {
  return join(appConfigDir(app.getPath('userData')), 'hooks')
}

export function registerIpcHandlers(runtime: Runtime): void {
  ipcMain.handle(IPC.snapshotGet, () => runtime.getSnapshot())

  ipcMain.handle(IPC.tasksQuery, (_event, query: unknown) => {
    const safe = typeof query === 'object' && query !== null ? query : {}
    return runtime.queryTasks(safe as Parameters<Runtime['queryTasks']>[0])
  })

  ipcMain.handle(IPC.taskDetail, (_event, id: unknown) => {
    if (typeof id !== 'string') return null
    return runtime.getTaskDetail(id)
  })

  ipcMain.handle(IPC.statsQuery, (_event, range: unknown) => {
    const obj = (typeof range === 'object' && range !== null ? range : {}) as {
      from?: number
      to?: number
    }
    const to = typeof obj.to === 'number' ? obj.to : Date.now()
    const from = typeof obj.from === 'number' ? obj.from : to - 7 * 86_400_000
    return runtime.getStats(from, to)
  })

  ipcMain.handle(IPC.exportCsv, async (_event, range: unknown) => {
    const obj = (typeof range === 'object' && range !== null ? range : {}) as {
      from?: number
      to?: number
    }
    const to = typeof obj.to === 'number' ? obj.to : Date.now()
    const from = typeof obj.from === 'number' ? obj.from : to - 7 * 86_400_000
    const { rows } = runtime.queryTasks({ from, to, limit: 1000 })

    const header = [
      '任务',
      '工具',
      '项目',
      '本轮开始',
      '本轮耗时(秒)',
      '会话开始',
      '会话时长(秒)',
      '输入Token',
      '输出Token',
      '缓存读Token',
      '缓存写Token',
      '输入缓存命中率',
      '费用USD',
      '模型',
      '数据来源',
      '状态'
    ]
    const lines = rows.map((task) =>
      [
        task.title,
        task.tool,
        task.project ?? '',
        formatTimeFull(task.turnStartedAt ?? task.startedAt),
        Math.round(turnElapsed(task) / 1000),
        formatTimeFull(task.startedAt),
        Math.round(task.durationMs / 1000),
        task.inputTokens,
        task.outputTokens,
        task.cacheReadTokens,
        task.cacheWriteTokens,
        computeCacheHitRate(task)?.toFixed(4) ?? '',
        task.costUsd.toFixed(6),
        task.model ?? '',
        task.tokensSource,
        task.status
      ]
        .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
        .join(',')
    )
    const csv = `\uFEFF${header.join(',')}\n${lines.join('\n')}\n`

    const result = await dialog.showSaveDialog({
      title: '导出任务明细',
      defaultPath: `ai-task-monitor-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    await writeFile(result.filePath, csv, 'utf8')
    return { saved: true, path: result.filePath, rows: rows.length }
  })

  ipcMain.handle(IPC.adaptersGet, () => runtime.adapters.getInfos())
  ipcMain.handle(IPC.adaptersRescan, async () => {
    await runtime.adapters.rescan()
    runtime.publish()
    return runtime.adapters.getInfos()
  })

  ipcMain.handle(IPC.settingsGet, () => runtime.getSettings())
  ipcMain.handle(IPC.settingsUpdate, (_event, patch: unknown) => {
    const safe = typeof patch === 'object' && patch !== null ? patch : {}
    const next = runtime.updateSettings(safe as Partial<AppSettings>)
    applyLoginItem(next)
    return next
  })

  ipcMain.handle(IPC.settingsRebuild, async (_event, days: unknown) => {
    const window = typeof days === 'number' && Number.isFinite(days) ? days : 30
    return runtime.rebuildHistory(window)
  })

  ipcMain.handle(IPC.hooksStatus, () => hookStatus(hooksDir()))
  ipcMain.handle(IPC.hooksInstall, () => installHooks(hooksDir()))
  ipcMain.handle(IPC.hooksRemove, () => removeHooks(hooksDir()))

  ipcMain.handle(IPC.pricingGet, () => runtime.getPricing())
  ipcMain.handle(IPC.pricingUpdate, (_event, rows: unknown) => {
    const list = Array.isArray(rows) ? (rows as PricingRow[]) : []
    return runtime.updatePricing(list)
  })
  ipcMain.handle(IPC.pricingReset, () => runtime.updatePricing(PRICING_SEED))

  ipcMain.handle(IPC.pauseToggle, () => {
    const next = runtime.updateSettings({ paused: !runtime.getSettings().paused })
    runtime.publish()
    return next
  })

  ipcMain.handle(IPC.bridgeStatus, () => runtime.bridgeStatus())
  ipcMain.handle(IPC.bridgeScript, (_event, tool: unknown) => {
    const status = runtime.bridgeStatus()
    const id = (tool === 'deepseek-harness' ? 'deepseek-harness' : 'yuanbao') as ToolId
    return buildUserscript(id, status.port, status.token)
  })

  ipcMain.handle(IPC.openDataDir, async () => {
    await shell.openPath(app.getPath('userData'))
  })
  ipcMain.handle(IPC.openExternal, async (_event, url: unknown) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) await shell.openExternal(url)
  })
  ipcMain.handle(IPC.windowHide, () => {
    getMainWindow()?.hide()
  })
  ipcMain.handle(IPC.appQuit, () => {
    app.quit()
  })
}

export function applyLoginItem(settings: AppSettings): void {
  if (process.platform === 'linux') return
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, openAsHidden: true })
}

export function notifyRenderer(snapshot: unknown): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.snapshotPush, snapshot)
}

export { showMainWindow, scriptFileName }
