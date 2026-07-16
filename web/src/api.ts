export interface Bucket {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messages: number;
}

export interface State {
  verdict: { ok: boolean; reason: string | null };
  snapshot: {
    generatedAt: number;
    window5h: Bucket;
    week: Bucket;
    weekOwn: Bucket;
    weekUser: Bucket;
    lastUserActivityAt: number | null;
  };
  settings: {
    paused: boolean;
    stopped: boolean;
    reserve_pct: number;
    weekly_cap_usd: number;
    window_cap_usd: number;
    activity_backoff_min: number;
  };
  daemon: {
    running: boolean;
    idleReason: string | null;
    currentTask: { id: number; model: string; brief: string } | null;
  };
  stats: {
    escalationRate: number;
    cacheHitRatio: number;
    doneTasks: number;
    costPerDoneTask: number;
  };
  generatedAt: number;
}

export interface LiveTick {
  taskId: number;
  model: string;
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface TaskRow {
  id: number;
  project: string;
  task_type: string;
  status: string;
  model: string;
  attempts: number;
  priority: number;
  brief: string;
  error: string | null;
  validate_cmd: string | null;
  created_at: string;
  finished_at: string | null;
  tokens: number;
  cache_read: number;
  cost_usd: number;
}

export interface ProjectRow {
  id: number;
  name: string;
  lane: string | null;
  stage: string;
  status: string;
  revenue_cents: number;
  tasks: number;
  cost_usd: number;
  tokens: number;
}

export interface EventRow {
  id: number;
  kind: string;
  detail: string | null;
  created_at: string;
}

export async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function post(url: string, body?: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${url}: ${res.status} ${text}`);
  }
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${url}: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtAgo(epochMs: number | null): string {
  if (!epochMs) return 'never';
  const min = (Date.now() - epochMs) / 60_000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.floor(min)} min ago`;
  if (min < 60 * 24) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 1440)} d ago`;
}
