import type {
  AdapterInfo,
  AppSettings,
  BridgeStatus,
  PricingRow,
  SnapshotPayload,
  StatsPayload,
  TaskDetail,
  TaskQuery,
  TaskSnapshot
} from './types'

/** IPC 通道常量与契约 — main 与 preload 共用，渲染进程通过 window.monitor 访问 */

export const IPC = {
  snapshotGet: 'monitor:snapshot:get',
  snapshotPush: 'monitor:snapshot:push',
  tasksQuery: 'monitor:tasks:query',
  taskDetail: 'monitor:tasks:detail',
  statsQuery: 'monitor:stats:query',
  exportCsv: 'monitor:stats:export',
  adaptersGet: 'monitor:adapters:get',
  adaptersRescan: 'monitor:adapters:rescan',
  settingsGet: 'monitor:settings:get',
  settingsUpdate: 'monitor:settings:update',
  settingsRebuild: 'monitor:settings:rebuild',
  pricingGet: 'monitor:pricing:get',
  pricingUpdate: 'monitor:pricing:update',
  pricingReset: 'monitor:pricing:reset',
  pauseToggle: 'monitor:pause:toggle',
  bridgeStatus: 'monitor:bridge:status',
  bridgeScript: 'monitor:bridge:script',
  openDataDir: 'monitor:app:data-dir',
  openExternal: 'monitor:app:open-external',
  windowHide: 'monitor:window:hide',
  appQuit: 'monitor:app:quit'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** preload 通过 contextBridge 暴露给渲染进程的 API 契约 */
export interface MonitorApi {
  getSnapshot: () => Promise<SnapshotPayload | null>
  onSnapshot: (handler: (snapshot: SnapshotPayload) => void) => () => void
  queryTasks: (query: TaskQuery) => Promise<{ rows: TaskSnapshot[]; total: number }>
  getTaskDetail: (id: string) => Promise<TaskDetail | null>
  getStats: (from: number, to: number) => Promise<StatsPayload>
  exportCsv: (from: number, to: number) => Promise<{ saved: boolean; path?: string; rows?: number }>
  getAdapters: () => Promise<AdapterInfo[]>
  rescanAdapters: () => Promise<AdapterInfo[]>
  getSettings: () => Promise<AppSettings>
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  /** 清空派生数据并按指定天数重扫日志，用于恢复更早的历史 */
  rebuildHistory: (days: number) => Promise<AppSettings>
  getPricing: () => Promise<PricingRow[]>
  updatePricing: (rows: PricingRow[]) => Promise<PricingRow[]>
  resetPricing: () => Promise<PricingRow[]>
  togglePause: () => Promise<AppSettings>
  getBridgeStatus: () => Promise<BridgeStatus>
  getBridgeScript: (tool: 'yuanbao' | 'deepseek-harness') => Promise<string>
  openDataDir: () => Promise<void>
  openExternal: (url: string) => Promise<void>
  hideWindow: () => Promise<void>
  quit: () => Promise<void>
}
