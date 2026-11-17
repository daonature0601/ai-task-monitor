import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const HOME = homedir()
const PLATFORM = platform()

/** macOS: ~/Library/Application Support；Windows: %APPDATA%；Linux: ~/.config */
export function appSupportDir(): string {
  if (PLATFORM === 'darwin') return join(HOME, 'Library', 'Application Support')
  if (PLATFORM === 'win32') return process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming')
  return join(HOME, '.config')
}

export function homePath(...segments: string[]): string {
  return join(HOME, ...segments)
}

export interface ToolPathSpec {
  /** 主数据目录（可能不存在） */
  primary: string
  /** 备选目录，按顺序探测 */
  alternates: string[]
}

export const TOOL_PATHS = {
  codex: (): ToolPathSpec => ({
    primary: homePath('.codex', 'sessions'),
    alternates: [homePath('.codex', 'archived_sessions')]
  }),
  claudeCode: (): ToolPathSpec => ({
    primary: homePath('.claude', 'projects'),
    alternates: [homePath('.claude', 'sessions'), homePath('.claude', 'session-data')]
  }),
  workbuddy: (): ToolPathSpec => ({
    primary: homePath('.workbuddy', 'workbuddy.db'),
    alternates: [homePath('.workbuddy', 'sessions')]
  }),
  codebuddy: (): ToolPathSpec => ({
    primary: homePath('.codebuddy', 'projects'),
    alternates: [
      homePath('.codebuddy', 'logs'),
      join(appSupportDir(), 'CodeBuddy CN', 'Local Storage', 'leveldb')
    ]
  }),
  cursor: (): ToolPathSpec => ({
    primary: join(appSupportDir(), 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    alternates: [
      homePath('.cursor', 'projects'),
      join(appSupportDir(), 'Cursor', 'User', 'workspaceStorage')
    ]
  }),
  deepseekHarness: (): ToolPathSpec => ({
    primary: join(appSupportDir(), '@deepseek-ai', 'dsh-desktop'),
    alternates: [join(appSupportDir(), 'DeepSeek Harness')]
  }),
  yuanbao: (): ToolPathSpec => ({
    primary: join(appSupportDir(), 'com.tencent.yuanbao'),
    alternates: [join(appSupportDir(), 'Yuanbao')]
  })
}

/** 返回首个存在的路径，全部不存在时返回 null */
export function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) return p
  }
  return null
}

export function isMac(): boolean {
  return PLATFORM === 'darwin'
}

export function isWindows(): boolean {
  return PLATFORM === 'win32'
}

/** 应用自身的配置/数据目录（不放业务数据库，仅 token 与缓存） */
export function appConfigDir(userDataDir: string): string {
  return join(userDataDir, 'monitor')
}
