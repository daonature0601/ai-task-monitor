import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow } from 'electron'
import { closeDatabase, openDatabase } from './db'
import { createRuntime, startRuntime, type Runtime } from './runtime'
import { createMainWindow, showMainWindow } from './window'
import { TrayController } from './tray'
import { applyLoginItem, notifyRenderer, registerIpcHandlers } from './ipc/handlers'
import { closeAllReadonly } from './collectors/sqlite-reader'
import { appConfigDir } from './collectors/paths'

// 固定应用名，保证 dev 与打包后 userData 路径一致
app.setName('AI Task Monitor')

let runtime: Runtime | null = null
let tray: TrayController | null = null
let quitting = false

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    console.error('[main] bootstrap failed', error)
    app.quit()
  })
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData')
  const db = openDatabase(join(userData, 'monitor.db'))

  runtime = createRuntime(db, {
    bridgeTokenFile: join(appConfigDir(userData), 'bridge-token'),
    hooksDir: join(appConfigDir(userData), 'hooks'),
    stateDir: join(appConfigDir(userData), 'state'),
    hooks: {
      onSnapshot: (snapshot) => {
        notifyRenderer(snapshot)
        tray?.update()
      },
      onTray: () => tray?.update()
    }
  })

  tray = new TrayController({
    snapshot: () => runtime?.getSnapshot() ?? null,
    onTogglePause: () => {
      if (!runtime) return
      runtime.updateSettings({ paused: !runtime.getSettings().paused })
      runtime.publish()
    },
    onShow: () => showMainWindow(),
    onQuit: () => app.quit()
  })

  registerIpcHandlers(runtime)
  applyLoginItem(runtime.getSettings())

  if (process.env.ATM_SMOKE === '1') {
    // 自检模式：诊断代码按需动态加载，不进入生产路径
    await startRuntime(runtime)
    const { startSmokeMode } = await import('./dev/smoke')
    startSmokeMode(runtime)
    return
  }

  createMainWindow()
  tray.init()
  await startRuntime(runtime)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    else showMainWindow()
  })
}

// 托盘常驻：关闭窗口不退出应用
app.on('window-all-closed', () => {
  if (process.platform === 'win32') return
  // macOS / Linux 保持后台运行，由托盘菜单退出
})

app.on('before-quit', (event) => {
  if (quitting || !runtime) return
  event.preventDefault()
  quitting = true
  void runtime
    .shutdown()
    .catch((error: unknown) => console.error('[main] shutdown failed', error))
    .finally(() => {
      closeAllReadonly()
      closeDatabase()
      tray?.destroy()
      app.exit(0)
    })
})
