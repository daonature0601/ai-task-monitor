import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { StatePhase, StateSignal, StateSource, ToolId } from '@shared/types'
import { JsonlTailer, type CursorStore } from './jsonl-tailer'

/**
 * 运行时状态收件箱。
 *
 * 各工具的 hook / 心跳 / 桥接把状态信号以 JSONL 追加到一个固定文件，
 * 主进程按字节游标增量读取 —— 状态从此只来源于工具自己的运行时事件，
 * 与「日志里有没有新行」彻底解耦。
 */
export interface StateInboxOptions {
  /** 收件箱目录（其下 inbox.jsonl 为唯一入口） */
  dir: string
  cursors: CursorStore
  onSignal: (signal: StateSignal) => void
  onError?: (error: unknown) => void
}

const VALID_TOOLS: ToolId[] = [
  'codex',
  'claude-code',
  'deepseek-harness',
  'codebuddy',
  'workbuddy',
  'cursor',
  'yuanbao'
]

const PHASES: StatePhase[] = ['start', 'active', 'end']
const SOURCES: StateSource[] = ['hook', 'bridge', 'io', 'heartbeat', 'process']

export class StateInbox {
  private tailer: JsonlTailer | null = null
  private readonly options: StateInboxOptions

  constructor(options: StateInboxOptions) {
    this.options = options
  }

  static path(dir: string): string {
    return join(dir, 'inbox.jsonl')
  }

  async start(): Promise<void> {
    // 收件箱可能尚未创建（首次运行）
    await fsp.mkdir(this.options.dir, { recursive: true })
    this.tailer = new JsonlTailer({
      roots: [this.options.dir],
      glob: '*.jsonl',
      depth: 0,
      debounceMs: 150,
      // 收件箱是短期状态流，重启后从上次游标继续；窗口给足避免丢信号
      backfillDays: 7,
      maxBytesPerRead: 2 * 1024 * 1024,
      cursors: this.options.cursors,
      onLine: (line) => this.handleLine(line),
      onError: (error) => this.options.onError?.(error)
    })
    await this.tailer.start()
  }

  async stop(): Promise<void> {
    await this.tailer?.stop()
    this.tailer = null
  }

  private handleLine(line: string): void {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }

    const tool = raw.tool as ToolId
    if (!VALID_TOOLS.includes(tool)) return

    const phase = raw.phase as StatePhase
    if (!PHASES.includes(phase)) return

    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
    if (!sessionId) return

    const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now()
    const source = SOURCES.includes(raw.source as StateSource)
      ? (raw.source as StateSource)
      : 'hook'

    this.options.onSignal({
      tool,
      sessionId,
      phase,
      ts,
      source,
      title: typeof raw.title === 'string' ? raw.title : undefined,
      workspace: typeof raw.workspace === 'string' ? raw.workspace : undefined,
      model: typeof raw.model === 'string' ? raw.model : undefined,
      startedAtHint: typeof raw.startedAtHint === 'number' ? raw.startedAtHint : undefined
    })
  }
}
