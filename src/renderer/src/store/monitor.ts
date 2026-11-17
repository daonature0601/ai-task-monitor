import { create } from 'zustand'
import type { AdapterInfo, AppSettings, SnapshotPayload } from '@shared/types'

export type PageId = 'dashboard' | 'tasks' | 'analytics' | 'adapters' | 'settings'

export interface ToastState {
  id: number
  text: string
  tone: 'ok' | 'warn' | 'danger'
}

interface MonitorState {
  snapshot: SnapshotPayload | null
  page: PageId
  drawerTaskId: string | null
  settings: AppSettings | null
  adapters: AdapterInfo[]
  collapsed: boolean
  toast: ToastState | null
  setSnapshot: (snapshot: SnapshotPayload) => void
  setPage: (page: PageId) => void
  openDrawer: (taskId: string) => void
  closeDrawer: () => void
  setSettings: (settings: AppSettings) => void
  setAdapters: (adapters: AdapterInfo[]) => void
  toggleCollapsed: () => void
  notify: (text: string, tone?: ToastState['tone']) => void
  dismissToast: () => void
}

/**
 * 全局 UI 状态。快照由主进程推送，1s 计时器只在渲染层本地推进，
 * 因此这里不存放任何"当前时间"，避免整棵树每秒重渲染。
 */
export const useMonitor = create<MonitorState>((set) => ({
  snapshot: null,
  page: 'dashboard',
  drawerTaskId: null,
  settings: null,
  adapters: [],
  collapsed: false,
  toast: null,
  setSnapshot: (snapshot) => set({ snapshot }),
  setPage: (page) => set({ page }),
  openDrawer: (taskId) => set({ drawerTaskId: taskId }),
  closeDrawer: () => set({ drawerTaskId: null }),
  setSettings: (settings) => set({ settings }),
  setAdapters: (adapters) => set({ adapters }),
  toggleCollapsed: () => set((state) => ({ collapsed: !state.collapsed })),
  notify: (text, tone = 'ok') => set({ toast: { id: Date.now(), text, tone } }),
  dismissToast: () => set({ toast: null })
}))
