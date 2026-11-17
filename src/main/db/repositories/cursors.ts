import type Database from 'better-sqlite3'

export interface FileCursor {
  path: string
  offset: number
  inode: string | null
  mtime: number | null
}

export function getCursor(db: Database.Database, path: string): FileCursor | null {
  const row = db
    .prepare('SELECT path, offset, inode, mtime FROM file_cursors WHERE path = ?')
    .get(path) as { path: string; offset: number; inode: string | null; mtime: number | null } | undefined
  if (!row) return null
  return { path: row.path, offset: row.offset, inode: row.inode, mtime: row.mtime }
}

export function setCursor(db: Database.Database, cursor: FileCursor): void {
  db.prepare(
    `INSERT INTO file_cursors (path, offset, inode, mtime, last_read_at)
     VALUES (@path, @offset, @inode, @mtime, @now)
     ON CONFLICT(path) DO UPDATE SET
       offset = excluded.offset,
       inode = excluded.inode,
       mtime = excluded.mtime,
       last_read_at = excluded.last_read_at`
  ).run({ ...cursor, now: Date.now() })
}

export function resetCursor(db: Database.Database, path: string): void {
  db.prepare('DELETE FROM file_cursors WHERE path = ?').run(path)
}

export function pruneCursors(db: Database.Database, olderThan: number): number {
  const info = db.prepare('DELETE FROM file_cursors WHERE last_read_at < ?').run(olderThan)
  return info.changes
}
