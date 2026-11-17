import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type MonitorApi } from '@shared/ipc-contract'
import type { SnapshotPayload } from '@shared/types'

/** 白名单式 API 暴露：渲染进程无法直接触达 fs / db / node */
const api: MonitorApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshotGet),
  onSnapshot: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: SnapshotPayload): void => {
      handler(snapshot)
    }
    ipcRenderer.on(IPC.snapshotPush, listener)
    return () => {
      ipcRenderer.removeListener(IPC.snapshotPush, listener)
    }
  },
  queryTasks: (query) => ipcRenderer.invoke(IPC.tasksQuery, query),
  getTaskDetail: (id) => ipcRenderer.invoke(IPC.taskDetail, id),
  getStats: (from, to) => ipcRenderer.invoke(IPC.statsQuery, { from, to }),
  exportCsv: (from, to) => ipcRenderer.invoke(IPC.exportCsv, { from, to }),
  getAdapters: () => ipcRenderer.invoke(IPC.adaptersGet),
  rescanAdapters: () => ipcRenderer.invoke(IPC.adaptersRescan),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  rebuildHistory: (days) => ipcRenderer.invoke(IPC.settingsRebuild, days),
  getPricing: () => ipcRenderer.invoke(IPC.pricingGet),
  updatePricing: (rows) => ipcRenderer.invoke(IPC.pricingUpdate, rows),
  resetPricing: () => ipcRenderer.invoke(IPC.pricingReset),
  togglePause: () => ipcRenderer.invoke(IPC.pauseToggle),
  getBridgeStatus: () => ipcRenderer.invoke(IPC.bridgeStatus),
  getBridgeScript: (tool) => ipcRenderer.invoke(IPC.bridgeScript, tool),
  openDataDir: () => ipcRenderer.invoke(IPC.openDataDir),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  hideWindow: () => ipcRenderer.invoke(IPC.windowHide),
  quit: () => ipcRenderer.invoke(IPC.appQuit)
}

contextBridge.exposeInMainWorld('monitor', api)
