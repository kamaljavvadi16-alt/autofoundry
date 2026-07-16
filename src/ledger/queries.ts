import path from 'node:path';
import { WORKSPACES_ROOT, DEFAULT_MAX_TURNS, DEFAULT_TOKEN_CAP, DEFAULT_MODEL } from '../config.js';
import { getDb } from './db.js';

export interface Project {
  id: number;
  name: string;
  lane: string | null;
  stage: string;
  status: string;
  workspace: string;
  token_budget: number | null;
  revenue_cents: number;
  autopilot: number;
  created_at: string;
}

export interface Task {
  id: number;
  project_id: number;
  brief: string;
  task_type: string;
  status: string;
  priority: number;
  model: string;
  max_turns: number;
  token_cap: number;
  allowed_tools: string | null;
  result: string | null;
  error: string | null;
  attempts: number;
  validate_cmd: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface SessionRow {
  id: number;
  task_id: number;
  claude_session_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  num_turns: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  exit_code: number | null;
  is_error: number;
  created_at: string;
}

export function getOrCreateProject(name: string, lane?: string): Project {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Project | undefined;
  if (existing) return existing;
  const workspace = path.join(WORKSPACES_ROOT, name);
  const info = db
    .prepare('INSERT INTO projects (name, lane, workspace) VALUES (?, ?, ?)')
    .run(name, lane ?? null, workspace);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid) as Project;
}

export function getProject(id: number): Project | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}

export function getProjectByName(name: string): Project | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE name = ?').get(name) as Project | undefined;
}

export function setProjectStage(id: number, stage: string): void {
  getDb().prepare('UPDATE projects SET stage = ? WHERE id = ?').run(stage, id);
}

export function setProjectAutopilot(id: number, on: boolean): void {
  getDb().prepare('UPDATE projects SET autopilot = ? WHERE id = ?').run(on ? 1 : 0, id);
}

export function setProjectStatus(id: number, status: string): void {
  getDb().prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, id);
}

export function listActiveAutopilotProjects(): Project[] {
  return getDb()
    .prepare("SELECT * FROM projects WHERE autopilot = 1 AND status = 'active'")
    .all() as Project[];
}

export function projectTaskCounts(projectId: number): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status')
    .all(projectId) as Array<{ status: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export function enqueueTask(opts: {
  projectId: number;
  brief: string;
  taskType?: string;
  model?: string;
  maxTurns?: number;
  tokenCap?: number;
  allowedTools?: string[];
  priority?: number;
  validateCmd?: string;
}): Task {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO tasks (project_id, brief, task_type, model, max_turns, token_cap, allowed_tools, priority, validate_cmd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.projectId,
      opts.brief,
      opts.taskType ?? 'dev',
      opts.model ?? DEFAULT_MODEL,
      opts.maxTurns ?? DEFAULT_MAX_TURNS,
      opts.tokenCap ?? DEFAULT_TOKEN_CAP,
      opts.allowedTools ? JSON.stringify(opts.allowedTools) : null,
      opts.priority ?? 5,
      opts.validateCmd ?? null
    );
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid) as Task;
}

export function escalateTask(id: number, newModel: string, failureNote: string): void {
  getDb()
    .prepare(
      `UPDATE tasks SET status = 'queued', model = ?, error = ?, attempts = attempts + 1,
         started_at = NULL, finished_at = NULL WHERE id = ?`
    )
    .run(newModel, failureNote, id);
}

export function markTaskReview(id: number, note: string): void {
  getDb()
    .prepare("UPDATE tasks SET status = 'review', error = ?, finished_at = datetime('now') WHERE id = ?")
    .run(note, id);
}

/** Put a task back in the queue untouched (no attempt bump, no model change). */
export function requeueTask(id: number): void {
  getDb()
    .prepare("UPDATE tasks SET status = 'queued', started_at = NULL, finished_at = NULL WHERE id = ?")
    .run(id);
}

export function cancelTask(id: number): boolean {
  const info = getDb()
    .prepare("UPDATE tasks SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status IN ('queued', 'review')")
    .run(id);
  return info.changes > 0;
}

export function nextQueuedTask(): Task | undefined {
  return getDb()
    .prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY priority ASC, id ASC LIMIT 1")
    .get() as Task | undefined;
}

export function getTask(id: number): Task | undefined {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

export function markTaskRunning(id: number): void {
  getDb()
    .prepare("UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?")
    .run(id);
}

export function markTaskFinished(id: number, status: 'done' | 'failed', result?: string, error?: string): void {
  getDb()
    .prepare(
      "UPDATE tasks SET status = ?, result = ?, error = ?, finished_at = datetime('now') WHERE id = ?"
    )
    .run(status, result ?? null, error ?? null, id);
}

export function insertSession(row: {
  taskId: number;
  claudeSessionId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
  exitCode?: number | null;
  isError: boolean;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (task_id, claude_session_id, model, input_tokens, output_tokens,
         cache_creation_tokens, cache_read_tokens, num_turns, duration_ms, cost_usd, exit_code, is_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.taskId,
      row.claudeSessionId ?? null,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.cacheCreationTokens,
      row.cacheReadTokens,
      row.numTurns ?? null,
      row.durationMs ?? null,
      row.costUsd ?? null,
      row.exitCode ?? null,
      row.isError ? 1 : 0
    );
}

export function sessionsForTask(taskId: number): SessionRow[] {
  return getDb().prepare('SELECT * FROM sessions WHERE task_id = ? ORDER BY id').all(taskId) as SessionRow[];
}

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function isPaused(): boolean {
  return getSetting('paused') === '1';
}

export function isStopped(): boolean {
  return getSetting('stopped') === '1';
}

export function logEvent(kind: string, detail?: string): void {
  getDb().prepare('INSERT INTO events (kind, detail) VALUES (?, ?)').run(kind, detail ?? null);
}
