import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from './migrations'
import { seedPricingIfEmpty } from './repositories/settings'

let instance: Database.Database | null = null

export function openDatabase(file: string): Database.Database {
  if (instance) return instance
  mkdirSync(dirname(file), { recursive: true })

  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  db.pragma('temp_store = MEMORY')

  runMigrations(db)
  seedPricingIfEmpty(db)

  instance = db
  console.log(`[db] opened ${file}`)
  return db
}

export function getDb(): Database.Database {
  if (!instance) throw new Error('database not initialized')
  return instance
}

export function closeDatabase(): void {
  if (!instance) return
  const db = instance
  instance = null
  if (db.open) {
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.close()
    console.log('[db] closed')
  }
}

export function isDatabaseOpen(): boolean {
  return instance !== null
}
