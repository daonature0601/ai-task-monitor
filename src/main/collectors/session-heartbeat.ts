import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * 会话心跳文件（实测于 CodeBuddy 与 WorkBuddy）：
 * `~/<tool>/sessions/<pid>.json`
 * {
 *   "pid": 31850,
 *   "lastHeartbeat": 1794836590584,
 *   "sessionId": "interactive-31850",
 *   "cwd": "/path/to/project",
 *   "startedAt": 1794836590582,
 *   "kind": "interactive"
 * }
 *
 * 该文件由工具进程周期性刷新，是"任务是否真的在运行"最可靠的信号，
 * 但**不包含任何 token 数据**，因此只能用于时长与活跃度，用量必须标 unavailable。
 */
export interface HeartbeatSession {
  filePath: string
  pid: number
  sessionId: string
  cwd?: string
  startedAt: number
  lastHeartbeat: number
  kind?: string
}

interface WatchOptions {
  /** 只关注最近这段时间内活跃过的文件，避免遍历历史会话 */
  maxAgeMs?: number
  /** 目录全量扫描的最小间隔；两次扫描之间只重读候选文件 */
  fullScanIntervalMs?: number
}

export class HeartbeatWatcher {
  private candidates: string[] = []
  private lastScanAt = 0
  private readonly maxAgeMs: number
  private readonly fullScanIntervalMs: number

  constructor(
    private readonly dir: string,
    options: WatchOptions = {}
  ) {
    this.maxAgeMs = options.maxAgeMs ?? 3 * 60 * 60 * 1000
    this.fullScanIntervalMs = options.fullScanIntervalMs ?? 15_000
  }

  async poll(now = Date.now()): Promise<HeartbeatSession[]> {
    const files = await this.resolveFiles(now)
    const sessions: HeartbeatSession[] = []
    for (const file of files) {
      const session = await this.readOne(file, now)
      if (session) sessions.push(session)
    }
    return sessions
  }

  private async resolveFiles(now: number): Promise<string[]> {
    const needScan = now - this.lastScanAt >= this.fullScanIntervalMs
    if (!needScan) return this.candidates

    this.lastScanAt = now
    const kept: string[] = []
    try {
      const entries = await fsp.readdir(this.dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const file = join(this.dir, entry.name)
        if (await this.isFresh(file, now)) kept.push(file)
      }
    } catch {
      // 目录不存在或不可读时静默返回，由适配器健康度体现
      this.candidates = []
      return []
    }
    this.candidates = kept
    return kept
  }

  private async isFresh(file: string, now: number): Promise<boolean> {
    try {
      const stat = await fsp.stat(file)
      return now - stat.mtimeMs <= this.maxAgeMs
    } catch {
      return false
    }
  }

  private async readOne(file: string, now: number): Promise<HeartbeatSession | null> {
    let raw: string
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch {
      return null
    }
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return null
    }
    if (!data || typeof data !== 'object') return null
    const obj = data as Record<string, unknown>
    const lastHeartbeat = Number(obj.lastHeartbeat)
    const startedAt = Number(obj.startedAt)
    const pid = Number(obj.pid)
    const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : ''
    if (!Number.isFinite(lastHeartbeat) || lastHeartbeat <= 0) return null
    if (now - lastHeartbeat > this.maxAgeMs) return null

    return {
      filePath: file,
      pid: Number.isFinite(pid) ? pid : 0,
      sessionId: sessionId || basename(file, '.json'),
      cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
      startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : lastHeartbeat,
      lastHeartbeat,
      kind: typeof obj.kind === 'string' ? obj.kind : undefined
    }
  }
}
