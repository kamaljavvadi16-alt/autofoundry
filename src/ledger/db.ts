import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      lane TEXT,
      stage TEXT NOT NULL DEFAULT 'validate',
      status TEXT NOT NULL DEFAULT 'active',
      workspace TEXT NOT NULL,
      token_budget INTEGER,
      revenue_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      brief TEXT NOT NULL,
      task_type TEXT NOT NULL DEFAULT 'dev',
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 5,
      model TEXT NOT NULL DEFAULT 'haiku',
      max_turns INTEGER NOT NULL DEFAULT 30,
      token_cap INTEGER NOT NULL DEFAULT 200000,
      allowed_tools TEXT,
      result TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      claude_session_id TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      num_turns INTEGER,
      duration_ms INTEGER,
      cost_usd REAL,
      exit_code INTEGER,
      is_error INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority, id);
    CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);
  `);

  ensureColumn(db, 'tasks', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'tasks', 'validate_cmd', 'TEXT');

  const seed = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  seed.run('paused', '0');
  seed.run('stopped', '0');
  seed.run('reserve_pct', '30');
  seed.run('weekly_cap_usd', '200');
  seed.run('window_cap_usd', '25');
  seed.run('activity_backoff_min', '30');
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
