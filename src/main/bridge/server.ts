import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BridgePayload, BridgeStatus } from '@shared/types'

const ALLOWED_ORIGINS = new Set([
  'https://yuanbao.tencent.com',
  'https://chat.deepseek.com',
  'https://www.deepseek.com'
])
const MAX_BODY = 64 * 1024
const RATE_LIMIT_PER_SEC = 30

export interface BridgeServerOptions {
  enabled: () => boolean
  preferredPort: () => number
  tokenFile: string
  onUsage: (payload: BridgePayload) => void
}

/**
 * 本地桥接服务：只监听 127.0.0.1，供网页端脚本上报真实用量。
 * 安全策略：随机 token + Origin 白名单 + 64KB 体积上限 + 30 req/s 限流。
 */
export class BridgeServer {
  private server: Server | null = null
  private port = 0
  private token = ''
  private received = 0
  private lastAt: number | null = null
  private error: string | null = null
  private windowStart = 0
  private windowCount = 0

  constructor(private readonly options: BridgeServerOptions) {
    this.token = this.loadToken()
  }

  getToken(): string {
    return this.token
  }

  async start(): Promise<void> {
    if (!this.options.enabled()) {
      this.error = '桥接已在设置中关闭'
      return
    }
    if (this.server) return

    const preferred = this.options.preferredPort()
    for (let port = preferred; port <= Math.min(preferred + 83, 43200); port += 1) {
      const ok = await this.tryListen(port)
      if (ok) {
        this.port = port
        this.error = null
        console.log(`[bridge] listening on 127.0.0.1:${port}`)
        return
      }
    }
    this.error = '端口 43117-43200 均被占用，桥接未启动'
    console.error(`[bridge] ${this.error}`)
  }

  private tryListen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => this.handle(req, res))
      server.once('error', () => {
        server.close()
        resolve(false)
      })
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        resolve(true)
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve())
    })
    this.server = null
    this.port = 0
  }

  status(): BridgeStatus {
    return {
      enabled: this.options.enabled(),
      port: this.port || this.options.preferredPort(),
      token: this.token,
      listening: this.server !== null,
      received: this.received,
      lastAt: this.lastAt,
      error: this.error
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-bridge-token')
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
      res.setHeader('Access-Control-Max-Age', '600')
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    const url = req.url ?? '/'
    if (req.method === 'GET' && (url === '/v1/health' || url === '/health')) {
      this.json(res, 200, { ok: true, tools: ['yuanbao', 'deepseek-harness'], version: 1 })
      return
    }
    if (req.method !== 'POST' || url !== '/v1/usage') {
      this.json(res, 404, { ok: false, error: 'not_found' })
      return
    }
    if (!this.allowRate()) {
      this.json(res, 429, { ok: false, error: 'rate_limited' })
      return
    }
    const token = req.headers['x-bridge-token']
    if (typeof token !== 'string' || !safeEqual(token, this.token)) {
      this.json(res, 401, { ok: false, error: 'invalid_token' })
      return
    }

    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        this.json(res, 413, { ok: false, error: 'payload_too_large' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size > MAX_BODY) return
      const parsed = this.parseBody(Buffer.concat(chunks).toString('utf8'))
      if (!parsed) {
        this.json(res, 400, { ok: false, error: 'invalid_payload' })
        return
      }
      this.received += 1
      this.lastAt = Date.now()
      this.options.onUsage(parsed)
      this.json(res, 200, { ok: true })
    })
  }

  private parseBody(raw: string): BridgePayload | null {
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      return null
    }
    if (!data || typeof data !== 'object') return null
    const obj = data as Record<string, unknown>
    const tool = obj.tool
    if (tool !== 'yuanbao' && tool !== 'deepseek-harness') return null
    const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId.slice(0, 200) : ''
    if (!sessionId) return null
    return {
      tool,
      sessionId,
      title: typeof obj.title === 'string' ? obj.title.slice(0, 200) : undefined,
      model: typeof obj.model === 'string' ? obj.model.slice(0, 120) : undefined,
      inputTokens: clampInt(obj.inputTokens),
      outputTokens: clampInt(obj.outputTokens),
      cacheReadTokens: clampInt(obj.cacheReadTokens),
      cacheWriteTokens: clampInt(obj.cacheWriteTokens),
      ts: typeof obj.ts === 'number' && Number.isFinite(obj.ts) ? obj.ts : Date.now(),
      end: obj.end === true
    }
  }

  private allowRate(): boolean {
    const now = Date.now()
    if (now - this.windowStart >= 1000) {
      this.windowStart = now
      this.windowCount = 0
    }
    this.windowCount += 1
    return this.windowCount <= RATE_LIMIT_PER_SEC
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    if (res.headersSent) return
    const payload = JSON.stringify(body)
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload)
    })
    res.end(payload)
  }

  private loadToken(): string {
    const file = this.options.tokenFile
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing.length >= 16) return existing
    }
    const token = randomBytes(24).toString('hex')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, token, { mode: 0o600 })
    return token
  }
}

function clampInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.round(value), 10_000_000)
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
