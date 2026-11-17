#!/usr/bin/env node
/**
 * 原生依赖就绪脚本：
 * 1) 确保 Electron 二进制已下载（--ignore-scripts 安装时会跳过）
 * 2) 为 better-sqlite3 拉取匹配 Electron ABI 的预编译产物（避免本地 node-gyp 编译）
 *
 * 之所以不用默认 npm install：better-sqlite3 的 install 脚本会针对 Node 运行时
 * 触发 node-gyp 编译，在较新的 Node 上可能失败，而这里只需要 Electron ABI。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const root = process.cwd()

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env })
}

function electronBinaryReady() {
  const dist = join(root, 'node_modules', 'electron', 'dist')
  return existsSync(dist) && existsSync(join(dist, 'Electron.app')) ||
    (existsSync(dist) && existsSync(join(dist, 'electron.exe'))) ||
    (existsSync(dist) && existsSync(join(dist, 'electron')))
}

let electronVersion = '33.4.11'
try {
  electronVersion = require('electron/package.json').version
} catch {
  console.warn('[setup] 未找到 electron 依赖，跳过 Electron 版本探测')
}

if (!electronBinaryReady()) {
  console.log('[setup] 下载 Electron 运行时…')
  try {
    run(process.execPath, [join(root, 'node_modules', 'electron', 'install.js')], root)
  } catch (error) {
    console.error('[setup] Electron 下载失败，请检查网络代理', error)
  }
}

const sqliteDir = join(root, 'node_modules', 'better-sqlite3')
if (existsSync(sqliteDir)) {
  console.log(`[setup] 为 better-sqlite3 安装 Electron ${electronVersion} 预编译产物…`)
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  try {
    run(
      npx,
      ['--no-install', 'prebuild-install', '-r', 'electron', '-t', electronVersion],
      sqliteDir
    )
  } catch (error) {
    console.error('[setup] 预编译产物下载失败，可退回 `npm run rebuild` 本地编译', error)
  }
}

console.log('[setup] 完成')
