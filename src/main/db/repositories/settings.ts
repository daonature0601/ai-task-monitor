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
              status, source, note, peak_json, currency
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
    peak_json: string | null
    currency: string | null
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
    note: r.note ?? undefined,
    currency: r.currency === 'CNY' ? 'CNY' : 'USD',
    ...parsePeak(r.peak_json)
  }))
}

export function replacePricing(db: Database.Database, rows: PricingRow[]): PricingRow[] {
  const insert = db.prepare(
    `INSERT INTO pricing (id, provider, match, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, status, source, note, peak_json, currency)
     VALUES (@id, @provider, @match, @inputPerM, @outputPerM, @cacheReadPerM, @cacheWritePerM, @status, @source, @note, @peakJson, @currency)`
  )
  // 界面保存的行不带分时配置，这里从库里按 id 继承，避免编辑一次就把 DeepSeek 的峰谷价清掉
  const existingPeak = new Map<string, string | null>()
  for (const row of db.prepare('SELECT id, peak_json FROM pricing').all() as Array<{ id: string; peak_json: string | null }>) {
    existingPeak.set(row.id, row.peak_json)
  }

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
        note: row.note ?? null,
        peakJson: status === 'verified' ? (serializePeak(row) ?? existingPeak.get(row.id) ?? null) : null,
        currency: row.currency === 'CNY' ? 'CNY' : 'USD'
      })
    }
  })
  tx(rows)
  return listPricing(db)
}

/** 分时配置的存储形态：高峰四价 + 时段 + 是否仅工作日 */
interface PeakPayload {
  inputPerM: number
  outputPerM: number
  cacheReadPerM: number
  cacheWritePerM: number
  hours: Array<[number, number]>
  weekdaysOnly: boolean
}

function parsePeak(json: string | null): Pick<
  PricingRow,
  'peak' | 'peakHoursUtc' | 'peakWeekdaysOnly'
> {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json) as Partial<PeakPayload>
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.hours)) return {}
    return {
      peak: {
        inputPerM: Number(parsed.inputPerM) || 0,
        outputPerM: Number(parsed.outputPerM) || 0,
        cacheReadPerM: Number(parsed.cacheReadPerM) || 0,
        cacheWritePerM: Number(parsed.cacheWritePerM) || 0
      },
      peakHoursUtc: parsed.hours,
      peakWeekdaysOnly: Boolean(parsed.weekdaysOnly)
    }
  } catch {
    return {}
  }
}

function serializePeak(row: PricingRow): string | null {
  if (!row.peak || !row.peakHoursUtc || row.peakHoursUtc.length === 0) return null
  const payload: PeakPayload = {
    ...row.peak,
    hours: row.peakHoursUtc,
    weekdaysOnly: Boolean(row.peakWeekdaysOnly)
  }
  return JSON.stringify(payload)
}

export function seedPricingIfEmpty(db: Database.Database): void {
  const count = db.prepare('SELECT COUNT(*) AS c FROM pricing').get() as { c: number }
  if (count.c > 0) return
  replacePricing(db, PRICING_SEED)
  console.log(`[db] seeded ${PRICING_SEED.length} pricing rows`)
}
