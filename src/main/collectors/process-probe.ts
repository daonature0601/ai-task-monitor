import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { appSupportDir, homePath, isMac, isWindows } from './paths'
import { join } from 'node:path'

const exec = promisify(execFile)

export interface ProcessInfo {
  pid: number
  command: string
}

let cached: { at: number; list: ProcessInfo[] } = { at: 0, list: [] }
const CACHE_MS = 2500

/**
 * 轻量进程列表：macOS/Linux 用 `ps`，Windows 用 `tasklist`。
 * 结果缓存 2.5s，多个适配器共享一次调用。
 */
export async function listProcesses(): Promise<ProcessInfo[]> {
  const now = Date.now()
  if (now - cached.at < CACHE_MS && cached.list.length > 0) return cached.list

  let list: ProcessInfo[] = []
  try {
    if (isWindows()) {
      const { stdout } = await exec('tasklist', ['/FO', 'CSV', '/NH'], { maxBuffer: 4 * 1024 * 1024 })
      list = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const cells = line.split('","')
          const name = (cells[0] ?? '').replace(/^"|"$/g, '')
          const pid = Number((cells[1] ?? '0').replace(/[^0-9]/g, ''))
          return { pid, command: name }
        })
        .filter((p) => p.command.length > 0)
    } else {
      const { stdout } = await exec('ps', ['-Ao', 'pid=,comm='], { maxBuffer: 8 * 1024 * 1024 })
      list = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^(\d+)\s+(.+)$/)
          if (!match) return { pid: 0, command: '' }
          return { pid: Number(match[1]), command: match[2] }
        })
        .filter((p) => p.pid > 0)
    }
  } catch (error) {
    console.error('[probe] list processes failed', error)
    list = []
  }

  cached = { at: now, list }
  return list
}

/** 任一匹配串命中进程命令即视为运行中 */
export async function isAnyRunning(matchers: string[]): Promise<boolean> {
  const list = await listProcesses()
  const lowered = matchers.map((m) => m.toLowerCase())
  return list.some((proc) => {
    const cmd = proc.command.toLowerCase()
    return lowered.some((m) => cmd.includes(m))
  })
}

/** 各工具用于进程探活的匹配串（macOS/Windows 共用命令名片段） */
export const PROCESS_MATCHERS: Record<string, string[]> = {
  codex: ['codex'],
  'claude-code': ['claude'],
  'deepseek-harness': ['dsh-desktop', 'deepseek harness'],
  codebuddy: ['codebuddy'],
  workbuddy: ['workbuddy'],
  cursor: ['cursor'],
  yuanbao: ['yuanbao', '元宝']
}

const APP_BUNDLES: Record<string, string[]> = {
  codex: ['/Applications/ChatGPT.app', '/Applications/Codex.app'],
  'claude-code': ['/Applications/Claude.app'],
  'deepseek-harness': ['/Applications/DeepSeek Harness.app'],
  codebuddy: ['/Applications/CodeBuddy CN.app', '/Applications/CodeBuddy.app'],
  workbuddy: ['/Applications/WorkBuddy.app', '/Applications/WorkBuddy AI.app'],
  cursor: ['/Applications/Cursor.app'],
  yuanbao: ['/Applications/Yuanbao.app', '/Applications/元宝.app']
}

/** 安装状态探测：应用包 / 数据目录 / 命令行可执行文件 */
export function isInstalled(toolId: string, dataPath: string | null): boolean {
  if (dataPath) return true
  for (const bundle of APP_BUNDLES[toolId] ?? []) {
    if (existsSync(bundle)) return true
  }
  if (isMac()) {
    const cliPaths: Record<string, string[]> = {
      codex: [homePath('.codex')],
      'claude-code': [homePath('.claude')],
      codebuddy: [homePath('.codebuddy')],
      workbuddy: [homePath('.workbuddy')],
      cursor: [homePath('.cursor')],
      'deepseek-harness': [join(appSupportDir(), '@deepseek-ai')],
      yuanbao: [join(appSupportDir(), 'com.tencent.yuanbao')]
    }
    for (const p of cliPaths[toolId] ?? []) {
      if (existsSync(p)) return true
    }
  }
  return false
}
