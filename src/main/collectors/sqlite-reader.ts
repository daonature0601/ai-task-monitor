import { statSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'

interface Cached {
  db: Database.Database
  signature: string
  copyPath: string | null
}

const cache = new Map<string, Cached>()
const COPY_DIR = join(tmpdir(), 'ai-task-monitor-snapshots')

function signatureOf(file: string): string {
  const stat = statSync(file)
  return `${stat.mtimeMs}:${stat.size}`
}

/**
 * 只读打开外部 SQLite（如 WorkBuddy / Cursor 的库）。
 * 若因 WAL 锁无法只读打开，则拷贝快照到临时目录后读取，绝不写入外部库。
 */
export function withReadonlyDb<T>(file: string, fn: (db: Database.Database) => T): T | null {
  if (!existsSync(file)) return null
  try {
    const signature = signatureOf(file)
    const cached = cache.get(file)
    if (cached && cached.signature === signature) {
      return fn(cached.db)
    }
    if (cached) closeEntry(file, cached)

    try {
      const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 3000 })
      db.pragma('query_only = true')
      cache.set(file, { db, signature, copyPath: null })
      return fn(db)
    } catch (error) {
      console.error(`[sqlite] readonly open failed, using snapshot: ${file}`, error)
      const snapshot = makeSnapshot(file)
      if (!snapshot) return null
      const db = new Database(snapshot.path, { readonly: true, fileMustExist: true, timeout: 3000 })
      db.pragma('query_only = true')
      cache.set(file, { db, signature, copyPath: snapshot.dir })
      return fn(db)
    }
  } catch (error) {
    console.error(`[sqlite] read failed: ${file}`, error)
    return null
  }
}

function makeSnapshot(file: string): { path: string; dir: string } | null {
  const stamp = Date.now()
  const dir = join(COPY_DIR, `${basename(file)}-${stamp}`)
  try {
    mkdirSync(dir, { recursive: true })
    const target = join(dir, basename(file))
    copyFileSync(file, target)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${file}${suffix}`)) copyFileSync(`${file}${suffix}`, `${target}${suffix}`)
    }
    return { path: target, dir }
  } catch (error) {
    console.error('[sqlite] snapshot failed', error)
    rmSync(dir, { recursive: true, force: true })
    return null
  }
}

function closeEntry(file: string, entry: Cached): void {
  try {
    if (entry.db.open) entry.db.close()
  } catch (error) {
    console.error('[sqlite] close failed', error)
  }
  if (entry.copyPath) rmSync(entry.copyPath, { recursive: true, force: true })
  cache.delete(file)
}

export function closeAllReadonly(): void {
  for (const [file, entry] of Array.from(cache.entries())) closeEntry(file, entry)
}

/** 读取 sqlite 的 ItemTable 键值（Cursor state.vscdb 结构） */
export function readItemTable(db: Database.Database, keys: string[]): string[] {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ItemTable'")
    .get() as { name: string } | undefined
  if (!hasTable) return []
  const placeholders = keys.map(() => '?').join(', ')
  const rows = db.prepare(`SELECT value FROM ItemTable WHERE key IN (${placeholders})`).all(
    ...keys
  ) as Array<{ value: string | Uint8Array }>
  return rows
    .map((row) => {
      if (typeof row.value === 'string') return row.value
      if (row.value instanceof Uint8Array) return Buffer.from(row.value).toString('utf8')
      return ''
    })
    .filter((v) => v.length > 0)
}

export function listItemKeys(db: Database.Database, limit = 200): string[] {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ItemTable'")
    .get() as { name: string } | undefined
  if (!hasTable) return []
  const rows = db.prepare('SELECT key FROM ItemTable LIMIT ?').all(limit) as Array<{ key: string }>
  return rows.map((r) => r.key)
}
