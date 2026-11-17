import { promises as fsp, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

export interface LevelEntry {
  key: string
  value: string
}

const SNAPSHOT_ROOT = join(tmpdir(), 'ai-task-monitor-leveldb')
const DB_FILES = /^(CURRENT|LOCK|LOG|LOG\.old|MANIFEST-\d+|\d+\.(ldb|log|sst))$/

function dirSize(dir: string): number {
  let total = 0
  const walk = (p: string): void => {
    const stat = statSync(p)
    if (stat.isDirectory()) {
      for (const name of readdirSync(p)) walk(join(p, name))
    } else {
      total += stat.size
    }
  }
  walk(dir)
  return total
}

/**
 * Chrome/Electron Local Storage 的 LevelDB 无法被第二进程安全打开，
 * 因此先复制一份快照再只读遍历，读取完成后由调用方删除。
 */
export async function snapshotLevelDb(
  source: string,
  maxBytes = 300 * 1024 * 1024
): Promise<string | null> {
  if (!existsSync(source)) return null
  const size = dirSize(source)
  if (size > maxBytes) {
    console.warn(`[leveldb] skip snapshot, dir too large: ${(size / 1024 / 1024).toFixed(1)}MB`)
    return null
  }
  const target = join(SNAPSHOT_ROOT, `${basename(source)}-${Date.now()}`)
  mkdirSync(target, { recursive: true })
  const names = await fsp.readdir(source)
  for (const name of names) {
    if (!DB_FILES.test(name)) continue
    await fsp.copyFile(join(source, name), join(target, name))
  }
  return target
}

export async function removeSnapshot(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true })
}

function decodeLocalStorage(buffer: Buffer): string {
  if (buffer.length === 0) return ''
  const flag = buffer[0]
  if (flag === 0x01) return buffer.subarray(1).toString('utf16le')
  if (flag === 0x00) return buffer.subarray(1).toString('latin1')
  return buffer.toString('utf8')
}

/**
 * 遍历 LevelDB 快照并产出解码后的键值对。
 * classic-level 为可选依赖，不可用时静默降级（由桥接通道兜底）。
 */
export async function readLevelDbEntries(
  dir: string,
  options: { maxEntries?: number; maxValueBytes?: number; keyFilter?: (key: string) => boolean } = {}
): Promise<LevelEntry[]> {
  const { maxEntries = 4000, maxValueBytes = 2 * 1024 * 1024, keyFilter } = options
  const out: LevelEntry[] = []
  let module: typeof import('classic-level') | null = null
  try {
    module = await import('classic-level')
  } catch (error) {
    console.warn('[leveldb] classic-level unavailable, bridge channel only', error)
    return out
  }
  if (!module) return out

  let db: InstanceType<typeof module.ClassicLevel> | null = null
  try {
    db = new module.ClassicLevel(dir, { keyEncoding: 'buffer', valueEncoding: 'buffer' })
    await db.open()
    let count = 0
    for await (const entry of db.iterator()) {
      if (count >= maxEntries) break
      count += 1
      const rawKey = entry[0] as unknown
      const rawValue = entry[1] as unknown
      if (!Buffer.isBuffer(rawKey) || !Buffer.isBuffer(rawValue)) continue
      if (rawValue.length > maxValueBytes) continue
      const key = decodeLocalStorage(rawKey)
      if (keyFilter && !keyFilter(key)) continue
      out.push({ key, value: decodeLocalStorage(rawValue) })
    }
  } catch (error) {
    console.error('[leveldb] iterate failed', error)
  } finally {
    if (db) {
      try {
        await db.close()
      } catch (error) {
        console.error('[leveldb] close failed', error)
      }
    }
  }
  return out
}

export interface PickedUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * 在任意字符串中提取 usage 风格字段（保守解析：仅取显式字段，绝不推算）。
 * 用于 DeepSeek Harness 这类无 schema 的 Local Storage 数据。
 */
export function pickUsageFields(value: string): PickedUsage | null {
  if (!value.includes('oken') && !value.includes('sage')) return null
  const patterns: Array<[keyof PickedUsage, RegExp]> = [
    ['inputTokens', /"(?:input_tokens|inputTokens|prompt_tokens|promptTokens)"\s*:\s*(\d{1,12})/i],
    ['outputTokens', /"(?:output_tokens|outputTokens|completion_tokens|completionTokens)"\s*:\s*(\d{1,12})/i],
    [
      'cacheReadTokens',
      /"(?:cache_read_input_tokens|cacheReadInputTokens|cache_read_tokens|cached_tokens|cachedTokens)"\s*:\s*(\d{1,12})/i
    ],
    [
      'cacheWriteTokens',
      /"(?:cache_creation_input_tokens|cacheWriteInputTokens|cache_write_tokens)"\s*:\s*(\d{1,12})/i
    ]
  ]
  const picked: PickedUsage = {}
  let found = false
  for (const [field, pattern] of patterns) {
    const match = pattern.exec(value)
    if (!match) continue
    picked[field] = Number(match[1])
    found = true
  }
  return found ? picked : null
}
