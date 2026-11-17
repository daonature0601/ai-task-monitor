import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'

let mainWindow: BrowserWindow | null = null

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0A0E14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 20 },
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 自检截图时需要正常的 rAF/动画推进；正常使用时保持节流以降低资源占用
      backgroundThrottling: process.env.ATM_SMOKE_CAPTURE !== '1'
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 外部链接交给系统浏览器，窗口内不允许导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function showMainWindow(): void {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function toggleMainWindow(): void {
  const win = getMainWindow()
  if (!win) {
    createMainWindow()
    return
  }
  if (win.isVisible() && win.isFocused()) win.hide()
  else showMainWindow()
}
