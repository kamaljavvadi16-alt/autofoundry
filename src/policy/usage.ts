import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_PROJECTS_DIR, WORKSPACES_ROOT } from '../config.js';
import { estimateCostUsd } from './pricing.js';

const WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface Bucket {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  messages: number;
}

export interface UsageSnapshot {
  generatedAt: number;
  /** Estimated API-equivalent cost across ALL local Claude Code activity. */
  window5h: Bucket;
  /** Orchestrator-only share of the 5h window — this is what budgets meter. */
  window5hOwn: Bucket;
  week: Bucket;
  /** Split of the weekly bucket: orchestrator workspaces vs the user's own projects. */
  weekOwn: Bucket;
  weekUser: Bucket;
  /** Newest write to any non-workspace project log (epoch ms), or null. */
  lastUserActivityAt: number | null;
}

interface LogLine {
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

function emptyBucket(): Bucket {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, messages: 0 };
}

function slugify(p: string): string {
  return p.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
}

/** Project-log dirs created by orchestrator worker sessions live under the workspaces root. */
function isOrchestratorDir(dirName: string): boolean {
  return dirName.toLowerCase().startsWith(slugify(WORKSPACES_ROOT));
}

export function scanUsage(now = Date.now()): UsageSnapshot {
  const snapshot: UsageSnapshot = {
    generatedAt: now,
    window5h: emptyBucket(),
    window5hOwn: emptyBucket(),
    week: emptyBucket(),
    weekOwn: emptyBucket(),
    weekUser: emptyBucket(),
    lastUserActivityAt: null,
  };
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return snapshot;

  for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    const own = isOrchestratorDir(dir);

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      let mtime: number;
      try {
        mtime = fs.statSync(filePath).mtimeMs;
      } catch {
        continue;
      }

      if (!own && (snapshot.lastUserActivityAt === null || mtime > snapshot.lastUserActivityAt)) {
        snapshot.lastUserActivityAt = mtime;
      }
      if (mtime < now - WEEK_MS) continue;

      accumulateFile(filePath, own, now, snapshot);
    }
  }
  return snapshot;
}

function accumulateFile(filePath: string, own: boolean, now: number, snapshot: UsageSnapshot): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  // Streamed responses log the same message id repeatedly with cumulative
  // usage — keep only the last occurrence per id.
  const byId = new Map<string, { ts: number; model: string; usage: NonNullable<NonNullable<LogLine['message']>['usage']> }>();
  for (const line of content.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let obj: LogLine;
    try {
      obj = JSON.parse(line) as LogLine;
    } catch {
      continue;
    }
    const msg = obj.message;
    if (!msg?.usage || !msg.id || !obj.timestamp) continue;
    const ts = Date.parse(obj.timestamp);
    if (Number.isNaN(ts)) continue;
    byId.set(msg.id, { ts, model: msg.model ?? 'sonnet', usage: msg.usage });
  }

  for (const { ts, model, usage } of byId.values()) {
    if (ts < now - WEEK_MS) continue;
    const tokens = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
    };
    const cost = estimateCostUsd(model, tokens);

    add(snapshot.week, tokens, cost);
    add(own ? snapshot.weekOwn : snapshot.weekUser, tokens, cost);
    if (ts >= now - WINDOW_MS) {
      add(snapshot.window5h, tokens, cost);
      if (own) add(snapshot.window5hOwn, tokens, cost);
    }
  }
}

function add(b: Bucket, t: { input: number; output: number; cacheWrite: number; cacheRead: number }, cost: number): void {
  b.costUsd += cost;
  b.inputTokens += t.input;
  b.outputTokens += t.output;
  b.cacheWriteTokens += t.cacheWrite;
  b.cacheReadTokens += t.cacheRead;
  b.messages += 1;
}
