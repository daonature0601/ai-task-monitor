import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { buildHookScript } from './script'

/**
 * 状态挂钩安装器。
 *
 * 只做两件可控的事：写入一个无依赖的 Node 脚本，并在工具自己的配置文件里
 * 追加一条指向它的命令。所有改动都先备份，可一键还原。
 *
 * 支持情况（实测）：
 *  - Claude Code：settings.json 的 hooks，UserPromptSubmit/Stop 提供完整的
 *    「回合开始 / 回合结束」，PreToolUse 提供回合内的活动心跳
 *  - Codex：config.toml 的 notify，仅在回合结束时触发；若已有 notify，
 *    会被链式接管（原命令仍会被调用）
 */
export interface HookPaths {
  /** 用户数据目录下的 hooks 子目录 */
  dir: string
  /** 状态收件箱文件 */
  inbox: string
}

export interface HookStatus {
  scriptPath: string
  inboxPath: string
  claude: boolean
  codex: boolean
  /** Codex 原有 notify 是否已被接管（存在备份即视为接管过） */
  codexChained: boolean
}

const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json')
const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml')

export function hookPaths(dir: string): HookPaths {
  return { dir, inbox: join(dir, '..', 'state', 'inbox.jsonl') }
}

function scriptPath(dir: string): string {
  return join(dir, 'atm-hook.cjs')
}

function originPath(dir: string): string {
  return join(dir, 'codex-origin.json')
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function isOurCommand(command: unknown): boolean {
  return typeof command === 'string' && command.includes('atm-hook.cjs')
}

/** 安装 Claude Code 的 hooks（幂等：先剔除自家条目再写入） */
function installClaude(dir: string): boolean {
  if (!existsSync(CLAUDE_SETTINGS)) return false
  const settings = readJson(CLAUDE_SETTINGS)
  if (!settings) return false

  const backup = `${CLAUDE_SETTINGS}.atm-backup`
  if (!existsSync(backup)) copyFileSync(CLAUDE_SETTINGS, backup)

  const command = `node ${JSON.stringify(scriptPath(dir))} claude-code`
  const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<
    string,
    unknown
  >

  const strip = (event: string): Array<Record<string, unknown>> => {
    const list = Array.isArray(hooks[event]) ? (hooks[event] as Array<Record<string, unknown>>) : []
    return list.filter((entry) => {
      const inner = Array.isArray(entry.hooks) ? (entry.hooks as Array<Record<string, unknown>>) : []
      return !inner.some((h) => isOurCommand(h.command))
    })
  }

  for (const event of ['UserPromptSubmit', 'Stop', 'PreToolUse']) {
    const list = strip(event)
    list.push({ hooks: [{ type: 'command', command }] })
    hooks[event] = list
  }

  settings.hooks = hooks
  writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`)
  return true
}

function removeClaude(): void {
  const settings = readJson(CLAUDE_SETTINGS)
  if (!settings) return
  const hooks = settings.hooks as Record<string, unknown> | undefined
  if (!hooks) return

  for (const event of Object.keys(hooks)) {
    const list = Array.isArray(hooks[event]) ? (hooks[event] as Array<Record<string, unknown>>) : []
    const kept = list.filter((entry) => {
      const inner = Array.isArray(entry.hooks) ? (entry.hooks as Array<Record<string, unknown>>) : []
      return !inner.some((h) => isOurCommand(h.command))
    })
    if (kept.length > 0) hooks[event] = kept
    else delete hooks[event]
  }

  writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`)
}

/** 安装 Codex notify（链式：保留原命令） */
function installCodex(dir: string): boolean {
  if (!existsSync(CODEX_CONFIG)) return false
  const text = readFileSync(CODEX_CONFIG, 'utf8')
  const match = text.match(/^notify\s*=\s*(\[[^\n]*\])/m)

  if (match && !match[1].includes('atm-hook.cjs')) {
    try {
      const original = JSON.parse(match[1].replace(/'/g, '"')) as string[]
      writeFileSync(originPath(dir), `${JSON.stringify({ notify: original }, null, 2)}\n`)
    } catch {
      // 解析失败就不接管，避免破坏用户配置
      return false
    }
  }

  const line = `notify = ["node", ${JSON.stringify(scriptPath(dir))}, "codex"]`
  const next = match ? text.replace(match[0], line) : `${line}\n${text}`
  writeFileSync(CODEX_CONFIG, next)
  return true
}

function removeCodex(dir: string): void {
  if (!existsSync(CODEX_CONFIG)) return
  const text = readFileSync(CODEX_CONFIG, 'utf8')
  if (!text.includes('atm-hook.cjs')) return

  const origin = readJson(originPath(dir))
  const original = Array.isArray(origin?.notify) ? (origin?.notify as string[]) : null
  const replacement = original ? `notify = ${JSON.stringify(original)}` : ''
  const next = text.replace(/^notify\s*=\s*\[[^\n]*\]$/m, replacement).replace(/\n{3,}/g, '\n\n')
  writeFileSync(CODEX_CONFIG, next)
}

export function hookStatus(dir: string): HookStatus {
  const claudeSettings = readJson(CLAUDE_SETTINGS)
  const claudeHooks = (claudeSettings?.hooks ?? {}) as Record<string, unknown>
  const claude = ['UserPromptSubmit', 'Stop', 'PreToolUse'].some((event) => {
    const list = Array.isArray(claudeHooks[event]) ? (claudeHooks[event] as Array<Record<string, unknown>>) : []
    return list.some((entry) => {
      const inner = Array.isArray(entry.hooks) ? (entry.hooks as Array<Record<string, unknown>>) : []
      return inner.some((h) => isOurCommand(h.command))
    })
  })

  const codexText = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, 'utf8') : ''
  const codex = codexText.includes('atm-hook.cjs')

  return {
    scriptPath: scriptPath(dir),
    inboxPath: hookPaths(dir).inbox,
    claude,
    codex,
    codexChained: existsSync(originPath(dir))
  }
}

export function installHooks(dir: string): HookStatus {
  mkdirSync(dir, { recursive: true })
  const paths = hookPaths(dir)
  mkdirSync(join(paths.inbox, '..'), { recursive: true })
  writeFileSync(scriptPath(dir), buildHookScript(paths.inbox, originPath(dir)), { mode: 0o755 })

  installClaude(dir)
  installCodex(dir)
  return hookStatus(dir)
}

export function removeHooks(dir: string): HookStatus {
  removeClaude()
  removeCodex(dir)
  return hookStatus(dir)
}
