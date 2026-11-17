import type Database from 'better-sqlite3'

interface Migration {
  version: number
  name: string
  up: (db: Database.Database) => void
}

const V1 = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  external_session_id TEXT NOT NULL,
  title TEXT,
  workspace TEXT,
  model TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  tokens_source TEXT NOT NULL DEFAULT 'unavailable',
  event_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_tool_time ON tasks(tool, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_time ON tasks(started_at DESC);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  dedupe_key TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_dedupe ON usage_events(task_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts DESC);

CREATE TABLE IF NOT EXISTS file_cursors (
  path TEXT PRIMARY KEY,
  offset INTEGER NOT NULL DEFAULT 0,
  inode TEXT,
  mtime INTEGER,
  last_read_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pricing (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  match TEXT NOT NULL,
  input_per_m REAL NOT NULL DEFAULT 0,
  output_per_m REAL NOT NULL DEFAULT 0,
  cache_read_per_m REAL NOT NULL DEFAULT 0,
  cache_write_per_m REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS adapter_state (
  id TEXT PRIMARY KEY,
  error_count INTEGER NOT NULL DEFAULT 0,
  events_today INTEGER NOT NULL DEFAULT 0,
  last_event_at INTEGER,
  message TEXT,
  updated_at INTEGER
);
`

/**
 * v2：价目表增加可信度标记。
 * 旧种子价目（含未核实的推算值）会被清空，由 seedPricingIfEmpty 重新写入
 * 「已核实 / 待确认」两态数据，避免历史错误的单价继续参与计费。
 */
const V2 = `
ALTER TABLE pricing ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE pricing ADD COLUMN source TEXT;
ALTER TABLE pricing ADD COLUMN note TEXT;
DELETE FROM pricing;

ALTER TABLE tasks ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 0;
UPDATE tasks SET cost_known = 0, cost_usd = 0;
`

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(V1)
    }
  },
  {
    version: 2,
    name: 'pricing-verification',
    up: (db) => {
      db.exec(V2)
    }
  },
  {
    /**
     * v3：任务状态改为「运行时信号驱动」。
     * state_source 记录状态来自 hook / heartbeat / bridge / process，
     * 'none' 表示该工具没有运行时通道、状态只能由日志推断。
     */
    version: 3,
    name: 'runtime-state-source',
    up: (db) => {
      db.exec(`
ALTER TABLE tasks ADD COLUMN state_source TEXT NOT NULL DEFAULT 'none';
ALTER TABLE tasks ADD COLUMN last_state_at INTEGER;
`)
    }
  },
  {
    /**
     * v4：时间口径改为「当次问答」。
     * turn_started_at 记录用户提交当前问题的时刻，turn_ended_at 记录本轮回复完成时刻。
     * 界面上的「开始时间 / 时长」用这两个字段，而不是会话起始时间。
     */
    version: 4,
    name: 'turn-boundary',
    up: (db) => {
      db.exec(`
ALTER TABLE tasks ADD COLUMN turn_started_at INTEGER;
ALTER TABLE tasks ADD COLUMN turn_ended_at INTEGER;
UPDATE tasks SET turn_started_at = started_at WHERE turn_started_at IS NULL;
`)
    }
  },
  {
    /**
     * v5：任务名改为「会话展示名」，并单独记录所属项目。
     * 旧数据的 title 多为工作目录名，project 从 workspace 末段补齐。
     */
    version: 5,
    name: 'task-project',
    up: (db) => {
      db.exec(`
ALTER TABLE tasks ADD COLUMN project TEXT;
`)
    }
  },
  {
    /**
     * v6：价目表支持分时计价（DeepSeek 的高峰 / 非高峰）。
     * peak_json 存放高峰四价与时段，为空表示全天同价。
     */
    version: 6,
    name: 'pricing-peak',
    up: (db) => {
      db.exec(`ALTER TABLE pricing ADD COLUMN peak_json TEXT;`)
    }
  },
  {
    /**
     * v7：价目表记录报价币种。
     * 国外厂商（OpenAI / Anthropic / DeepSeek）为 USD，国内厂商（智谱 / 腾讯）为 CNY，
     * 入库保持厂商原币种，计价时统一折算成 USD 存储。
     */
    version: 7,
    name: 'pricing-currency',
    up: (db) => {
      db.exec(`ALTER TABLE pricing ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';`)
    }
  }
]

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

export function runMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  if (current >= LATEST_VERSION) return

  const apply = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue
      migration.up(db)
      db.pragma(`user_version = ${migration.version}`)
    }
  })

  apply()
  console.log(`[db] migrated ${current} -> ${LATEST_VERSION}`)
}
