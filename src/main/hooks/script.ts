/**
 * 生成注入到各工具的状态钩子脚本（Node CJS，无外部依赖）。
 *
 * 设计约束：
 *  - 绝不阻塞宿主工具：写完即退出，异常一律吞掉，退出码恒为 0
 *  - 只上报「会话 id / 阶段 / 工作目录」，不读取任何对话内容
 *  - Codex 的 notify 可能已被其它工具占用，脚本会转调原命令（chain）
 */
export function buildHookScript(inboxPath: string, originPath: string): string {
  return `#!/usr/bin/env node
/* AI Task Monitor 状态钩子 —— 由应用生成，删除该文件即可停用 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const INBOX = ${JSON.stringify(inboxPath)}
const ORIGIN = ${JSON.stringify(originPath)}

function write(payload) {
  try {
    fs.mkdirSync(path.dirname(INBOX), { recursive: true })
    fs.appendFileSync(INBOX, JSON.stringify(payload) + '\\n')
  } catch (_) {
    /* 上报失败不能影响宿主工具 */
  }
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (raw += chunk))
    process.stdin.on('end', () => resolve(raw))
    process.stdin.on('error', () => resolve(''))
  })
}

function chain(original, args) {
  if (!original || !original.length) return
  try {
    const child = spawn(original[0], original.slice(1).concat(args), {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
  } catch (_) {
    /* 原 notify 失败与状态上报无关 */
  }
}

async function main() {
  const tool = process.argv[2] || 'unknown'
  const stdin = await readStdin()
  let event = {}
  try {
    event = JSON.parse(stdin.trim() || process.argv[3] || '{}')
  } catch (_) {
    event = {}
  }

  const name = event.hook_event_name || event.hookEventName || ''
  const type = event.type || ''
  const sessionId =
    event.session_id || event.sessionId || event.conversation_id || event.thread_id || ''

  let phase = 'active'
  if (name === 'UserPromptSubmit' || type === 'user-prompt-submit') phase = 'start'
  else if (name === 'Stop' || name === 'SessionEnd' || type === 'agent-turn-complete') phase = 'end'

  if (sessionId) {
    write({
      tool,
      sessionId,
      phase,
      ts: Date.now(),
      source: 'hook',
      workspace: event.cwd || undefined,
      model: event.model || undefined
    })
  }

  if (tool === 'codex') {
    let original = null
    try {
      original = JSON.parse(fs.readFileSync(ORIGIN, 'utf8')).notify || null
    } catch (_) {
      original = null
    }
    chain(original, [stdin.trim() || '{}'])
  }

  process.exit(0)
}

main().catch(() => process.exit(0))
`
}
