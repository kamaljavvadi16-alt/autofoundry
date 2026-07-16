import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { CLAUDE_PROJECTS_DIR, WORKSPACES_ROOT } from '../config.js';
import { isPaused, isStopped, logEvent, nextQueuedTask, type Task } from '../ledger/queries.js';
import { advanceAutopilotProjects } from '../pipeline/autopilot.js';
import { refreshLimits } from '../policy/limits.js';
import { canRunNow } from '../policy/policy.js';
import { runTask } from '../queue.js';
import { sumSessionUsage } from '../watcher/jsonl.js';

const IDLE_POLL_MS = 30_000;
const BLOCKED_POLL_MS = 60_000;
const LIVE_TICK_MS = 2_500;

export interface LiveTick {
  taskId: number;
  model: string;
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export class Daemon extends EventEmitter {
  running = false;
  currentTask: Task | null = null;
  lastVerdictReason: string | null = null;
  private child: ChildProcess | null = null;
  private wake: (() => void) | null = null;

  start(): void {
    if (this.running) return;
    this.running = true;
    logEvent('daemon_started');
    void this.loop();
    this.emit('state');
  }

  stop(): void {
    this.running = false;
    logEvent('daemon_stopped');
    this.wake?.();
    this.emit('state');
  }

  /** Emergency: kill the in-flight headless session immediately. */
  killCurrent(): boolean {
    if (this.child && !this.child.killed) {
      this.child.kill();
      logEvent('session_killed', `task ${this.currentTask?.id}`);
      return true;
    }
    return false;
  }

  poke(): void {
    this.wake?.();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      await refreshLimits();

      if (isStopped() || isPaused()) {
        this.lastVerdictReason = isStopped() ? 'emergency stop is engaged' : 'queue is paused';
        this.emit('state');
        await this.sleep(IDLE_POLL_MS);
        continue;
      }

      const verdict = canRunNow();
      if (!verdict.ok) {
        this.lastVerdictReason = verdict.reason ?? 'blocked by policy';
        this.emit('state');
        await this.sleep(BLOCKED_POLL_MS);
        continue;
      }

      advanceAutopilotProjects();

      const task = nextQueuedTask();
      if (!task) {
        this.lastVerdictReason = 'queue empty';
        this.emit('state');
        await this.sleep(IDLE_POLL_MS);
        continue;
      }

      this.lastVerdictReason = null;
      this.currentTask = task;
      const startedAt = Date.now();
      this.emit('state');

      const tick = setInterval(() => {
        const live = readLiveUsage(task, startedAt);
        if (live) this.emit('live', live);
      }, LIVE_TICK_MS);

      try {
        await runTask(task, { onSpawn: (child) => (this.child = child) });
      } finally {
        clearInterval(tick);
        this.child = null;
        this.currentTask = null;
        this.emit('state');
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}

/**
 * The session id isn't known until the session exits, so find the newest JSONL
 * under any orchestrator-workspace log dir modified since the task started.
 */
function readLiveUsage(task: Task, startedAt: number): LiveTick | null {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
  const wsSlug = WORKSPACES_ROOT.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();

  let newest: { path: string; mtime: number } | null = null;
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    if (!dir.toLowerCase().startsWith(wsSlug)) continue;
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(dirPath, f);
      try {
        const mtime = fs.statSync(p).mtimeMs;
        if (mtime >= startedAt - 5_000 && (!newest || mtime > newest.mtime)) {
          newest = { path: p, mtime };
        }
      } catch {
        // file may vanish mid-scan
      }
    }
  }
  if (!newest) return null;

  const usage = sumSessionUsage(newest.path);
  return {
    taskId: task.id,
    model: task.model,
    startedAt,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
  };
}
