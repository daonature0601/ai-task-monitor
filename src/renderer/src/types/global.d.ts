import type { MonitorApi } from '@shared/ipc-contract'

declare global {
  interface Window {
    monitor: MonitorApi
  }
}

export {}
