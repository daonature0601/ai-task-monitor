import type Database from 'better-sqlite3'
import { DEFAULT_SETTINGS, PRICING_SEED } from '@shared/defaults'
import type { AppSettings, PricingRow } from '@shared/types'

const SETTINGS_KEY = 'app'

export function readSettings(db: Database.Database): AppSettings {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value: string }
    | undefined
  if (!row) return { ...DEFAULT_SETTINGS }
  const parsed = safeParse(row.value)
  if (!parsed) return { ...DEFAULT_SETTINGS }
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed })
}

export function writeSettings(db: Database.Database, patch: Partial<AppSettings>): AppSettings {
  const next = normalizeSettings({ ...readSettings(db), ...patch })
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(SETTINGS_KEY, JSON.stringify(next))
  return next
}

function normalizeSettings(input: AppSettings): AppSettings {
  const s = { ...input }
  s.fxRate = clamp(s.fxRate, 1, 20)
  s.fileDebounceMs = clamp(s.fileDebounceMs, 100, 5000)
  s.processProbeMs = clamp(s.processProbeMs, 2000, 120000)
  s.desktopPollMs = clamp(s.desktopPollMs, 2000, 300000)
  s.snapshotPushMs = clamp(s.snapshotPushMs, 1000, 30000)
  s.trayRefreshMs = clamp(s.trayRefreshMs, 2000, 60000)
  s.idleThresholdMs = clamp(s.idleThresholdMs, 15000, 3600000)
  s.alertCostWarnUsd = Math.max(0, s.alertCostWarnUsd)
  s.alertCostDangerUsd = Math.max(s.alertCostWarnUsd, s.alertCostDangerUsd)
  s.alertDurationWarnMs = Math.max(60000, s.alertDurationWarnMs)
  s.alertDurationDangerMs = Math.max(s.alertDurationWarnMs, s.alertDurationDangerMs)
  s.alertCacheHitMinRate = clamp(s.alertCacheHitMinRate, 0, 1)
  s.retentionDays = Math.round(clamp(s.retentionDays, 1, 3650))
  s.bridgePort = Math.round(clamp(s.bridgePort, 1024, 65535))
  if (s.currency !== 'USD' && s.currency !== 'CNY') s.currency = 'USD'
  return s
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function safeParse(raw: string): Partial<AppSettings> | null {
  try {
    return JSON.parse(raw) as Partial<AppSettings>
  } catch (error) {
    console.error('[settings] parse failed', error)
    return null
  }
}

export function listPricing(db: Database.Database): PricingRow[] {
  const rows = db
    .prepare(
      `SELECT id, provider, match, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m,
              status, source, note
       FROM pricing ORDER BY provider, id`
    )
    .all() as Array<{
    id: string
    provider: string
    match: string
    input_per_m: number
    output_per_m: number
    cache_read_per_m: number
    cache_write_per_m: number
    status: string
    source: string | null
    note: string | null
  }>
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    match: r.match,
    inputPerM: r.input_per_m,
    outputPerM: r.output_per_m,
    cacheReadPerM: r.cache_read_per_m,
    cacheWritePerM: r.cache_write_per_m,
    status: r.status === 'verified' ? 'verified' : 'pending',
    source: r.source ?? undefined,
    note: r.note ?? undefined
  }))
}

export function replacePricing(db: Database.Database, rows: PricingRow[]): PricingRow[] {
  const insert = db.prepare(
    `INSERT INTO pricing (id, provider, match, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, status, source, note)
     VALUES (@id, @provider, @match, @inputPerM, @outputPerM, @cacheReadPerM, @cacheWritePerM, @status, @source, @note)`
  )
  const tx = db.transaction((list: PricingRow[]) => {
    db.prepare('DELETE FROM pricing').run()
    for (const row of list) {
      if (!row.id || !row.match) continue
      const status = row.status === 'verified' ? 'verified' : 'pending'
      insert.run({
        id: row.id,
        provider: row.provider || '未知',
        match: row.match,
        // 待确认的行强制归零，避免残留旧单价被当成已核实数据
        inputPerM: status === 'verified' ? Math.max(0, row.inputPerM || 0) : 0,
        outputPerM: status === 'verified' ? Math.max(0, row.outputPerM || 0) : 0,
        cacheReadPerM: status === 'verified' ? Math.max(0, row.cacheReadPerM || 0) : 0,
        cacheWritePerM: status === 'verified' ? Math.max(0, row.cacheWritePerM || 0) : 0,
        status,
        source: row.source ?? null,
        note: row.note ?? null
      })
    }
  })
  tx(rows)
  return listPricing(db)
}

export function seedPricingIfEmpty(db: Database.Database): void {
  const count = db.prepare('SELECT COUNT(*) AS c FROM pricing').get() as { c: number }
  if (count.c > 0) return
  replacePricing(db, PRICING_SEED)
  console.log(`[db] seeded ${PRICING_SEED.length} pricing rows`)
}
