import type Database from 'better-sqlite3'

export interface AdapterStateRow {
  id: string
  errorCount: number
  eventsToday: number
  lastEventAt: number | null
  message: string | null
}

export function listAdapterStates(db: Database.Database): Map<string, AdapterStateRow> {
  const rows = db
    .prepare('SELECT id, error_count, events_today, last_event_at, message FROM adapter_state')
    .all() as Array<{
    id: string
    error_count: number
    events_today: number
    last_event_at: number | null
    message: string | null
  }>
  const map = new Map<string, AdapterStateRow>()
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      errorCount: r.error_count,
      eventsToday: r.events_today,
      lastEventAt: r.last_event_at,
      message: r.message
    })
  }
  return map
}

export function saveAdapterState(
  db: Database.Database,
  id: string,
  patch: Partial<Omit<AdapterStateRow, 'id'>>
): void {
  db.prepare(
    `INSERT INTO adapter_state (id, error_count, events_today, last_event_at, message, updated_at)
     VALUES (@id, @errorCount, @eventsToday, @lastEventAt, @message, @now)
     ON CONFLICT(id) DO UPDATE SET
       error_count = COALESCE(@errorCount, adapter_state.error_count),
       events_today = COALESCE(@eventsToday, adapter_state.events_today),
       last_event_at = COALESCE(@lastEventAt, adapter_state.last_event_at),
       message = @message,
       updated_at = @now`
  ).run({
    id,
    errorCount: patch.errorCount ?? null,
    eventsToday: patch.eventsToday ?? null,
    lastEventAt: patch.lastEventAt ?? null,
    message: patch.message ?? null,
    now: Date.now()
  })
}

export function resetDailyAdapterCounters(db: Database.Database): void {
  db.prepare('UPDATE adapter_state SET events_today = 0').run()
}
