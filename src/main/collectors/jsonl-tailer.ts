import { createReadStream, promises as fsp } from 'node:fs'
import { basename, relative } from 'node:path'
import { createHash } from 'node:crypto'
import chokidar, { type FSWatcher } from 'chokidar'

export interface LineContext {
  filePath: string
  relPath: string
  /** 该行起始的字节偏移，用作幂等键的一部分 */
  offset: number
  mtimeMs: number
}

export interface CursorStore {
  get(path: string): { offset: number; inode: string | null } | null
  set(path: string, offset: number, inode: string | null, mtimeMs: number): void
}

export interface JsonlTailerOptions {
  roots: string[]
  /** chokidar glob 模式，例如 rollout-*.jsonl（按文件名匹配） */
  glob: string
  depth: number
  debounceMs: number
  /** 首轮扫描时只回填最近 N 天内修改过的文件，避免全量重扫 */
  backfillDays: number
  maxBytesPerRead: number
  cursors: CursorStore
  onLine: (line: string, ctx: LineContext) => void
  onError?: (error: unknown, filePath?: string) => void
}

/**
 * 基于字节游标的 JSONL 增量读取器：
 * - chokidar 监听 + 300ms 防抖
 * - 只读取追加区段，半行留待下次拼接
 * - 文件截断/替换（size 变小或 inode 变更）自动重置游标
 */
export class JsonlTailer {
  private watcher: FSWatcher | null = null
  private readonly pending = new Map<string, NodeJS.Timeout>()
  private readonly busy = new Set<string>()
  private stopped = false

  constructor(private readonly options: JsonlTailerOptions) {}

  async start(): Promise<void> {
    const existing = this.options.roots.filter(Boolean)
    if (existing.length === 0) return

    this.watcher = chokidar.watch(this.options.glob, {
      cwd: existing[0],
      ignoreInitial: true,
      depth: this.options.depth,
      followSymlinks: false,
      usePolling: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 60 },
      ignored: (p: string) => p.includes('node_modules') || p.endsWith('.lock')
    })

    this.watcher.on('add', (rel) => this.schedule(rel))
    this.watcher.on('change', (rel) => this.schedule(rel))
    this.watcher.on('error', (error) => this.options.onError?.(error))

    await this.initialScan()
  }

  private async initialScan(): Promise<void> {
    const root = this.options.roots[0]
    const cutoff = Date.now() - this.options.backfillDays * 86_400_000
    const files = await this.walk(root, this.options.depth).catch((error: unknown) => {
      this.options.onError?.(error, root)
      return [] as string[]
    })
    for (const file of files) {
      const stat = await fsp.stat(file).catch(() => null)
      if (!stat) continue
      const known = this.options.cursors.get(file)
      if (!known && stat.mtimeMs < cutoff) continue
      await this.readFile(file)
    }
  }

  private async walk(root: string, depth: number): Promise<string[]> {
    const out: string[] = []
    const pattern = this.globToRegExp(this.options.glob)
    const visit = async (dir: string, level: number): Promise<void> => {
      if (level > depth) return
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          await visit(full, level + 1)
        } else if (pattern.test(entry.name)) {
          out.push(full)
        }
      }
    }
    await visit(root, 0)
    return out
  }

  private globToRegExp(glob: string): RegExp {
    const name = glob.split('/').pop() ?? glob
    const escaped = name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    return new RegExp(`^${escaped}$`)
  }

  private schedule(rel: string): void {
    if (this.stopped) return
    const root = this.options.roots[0]
    const full = `${root}/${rel}`
    const timer = this.pending.get(full)
    if (timer) clearTimeout(timer)
    this.pending.set(
      full,
      setTimeout(() => {
        this.pending.delete(full)
        void this.readFile(full)
      }, this.options.debounceMs)
    )
  }

  private async readFile(filePath: string): Promise<void> {
    if (this.busy.has(filePath) || this.stopped) return
    this.busy.add(filePath)
    try {
      const stat = await fsp.stat(filePath)
      if (!stat.isFile() || stat.size === 0) return

      const inode = `${stat.ino}`
      const known = this.options.cursors.get(filePath)
      let offset = known?.offset ?? 0
      if (known && (known.inode !== inode || stat.size < offset)) offset = 0

      if (stat.size <= offset) return

      const root = this.options.roots[0]
      const relPath = relative(root, filePath)
      let cursor = offset
      let guard = 0

      while (cursor < stat.size && guard < 16) {
        guard += 1
        const end = Math.min(stat.size, cursor + this.options.maxBytesPerRead)
        const buffer = await this.readRange(filePath, cursor, end)
        const consumed = this.consume(buffer, cursor, {
          filePath,
          relPath,
          mtimeMs: stat.mtimeMs
        })
        cursor += consumed
        this.options.cursors.set(filePath, cursor, inode, stat.mtimeMs)
        if (consumed < buffer.length) break
      }
    } catch (error) {
      this.options.onError?.(error, filePath)
    } finally {
      this.busy.delete(filePath)
    }
  }

  private async readRange(filePath: string, start: number, end: number): Promise<Buffer> {
    const length = end - start
    const buffer = Buffer.allocUnsafe(length)
    const handle = await fsp.open(filePath, 'r')
    try {
      await handle.read(buffer, 0, length, start)
    } finally {
      await handle.close()
    }
    return buffer
  }

  /** 只消费完整行，返回已消费的字节数 */
  private consume(
    buffer: Buffer,
    baseOffset: number,
    meta: { filePath: string; relPath: string; mtimeMs: number }
  ): number {
    let lineStart = 0
    for (let i = 0; i < buffer.length; i += 1) {
      if (buffer[i] !== 0x0a) continue
      const raw = buffer.subarray(lineStart, i).toString('utf8').trim()
      if (raw.length > 0) {
        this.options.onLine(raw, {
          filePath: meta.filePath,
          relPath: meta.relPath,
          offset: baseOffset + lineStart,
          mtimeMs: meta.mtimeMs
        })
      }
      lineStart = i + 1
    }
    return lineStart
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
  }
}

export function stableFileKey(filePath: string): string {
  return createHash('sha1').update(filePath).digest('hex').slice(0, 10)
}

export function fileName(filePath: string): string {
  return basename(filePath)
}

/** 便捷函数：一次性读取整个文件的行（用于小型会话 JSON） */
export async function readAllLines(filePath: string, limitBytes = 8 * 1024 * 1024): Promise<string[]> {
  const lines: string[] = []
  await new Promise<void>((resolve, reject) => {
    let received = 0
    let tail = ''
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      if (tail.trim()) lines.push(tail.trim())
      resolve()
    }
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    stream.on('data', (chunk) => {
      if (settled) return
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      received += text.length
      if (received > limitBytes) {
        // 达到上限：destroy 只会触发 close 而非 end，必须主动收尾，
        // 否则调用方（如会话元信息回读）会永久挂起。
        stream.destroy()
        finish()
        return
      }
      const parts = (tail + text).split('\n')
      tail = parts.pop() ?? ''
      for (const part of parts) {
        const trimmed = part.trim()
        if (trimmed) lines.push(trimmed)
      }
    })
    stream.on('end', finish)
    stream.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
  return lines
}
