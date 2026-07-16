import fs from 'node:fs';
import { DEFAULT_ALLOWED_TOOLS, nextModel } from './config.js';
import {
  escalateTask,
  getProject,
  insertSession,
  isPaused,
  isStopped,
  logEvent,
  markTaskFinished,
  markTaskReview,
  markTaskRunning,
  nextQueuedTask,
  requeueTask,
  setSetting,
  type Task,
} from './ledger/queries.js';

const PLAN_LIMIT_RE = /rate.?limit|usage limit|limit (reached|exceeded|will reset)|too many requests|\b429\b|out of extra usage/i;
const COOLDOWN_MS = 60 * 60 * 1000;
import { canRunNow } from './policy/policy.js';
import { scanUsage } from './policy/usage.js';
import { advanceAutopilotProjects } from './pipeline/autopilot.js';
import { composeBrief } from './pipeline/briefs.js';
import { runHeadless } from './runner/run.js';
import { runLocalCheck } from './verify/local.js';

export interface QueueOutcome {
  processed: number;
  reason: string;
}

export interface QueueOptions {
  maxTasks?: number;
  /** Skip usage/activity policy checks (pause/stop still honored elsewhere). */
  force?: boolean;
}

export async function processQueue(opts: QueueOptions = {}): Promise<QueueOutcome> {
  let processed = 0;
  const max = opts.maxTasks ?? Infinity;

  while (processed < max) {
    // Pause and emergency stop are absolute — force never bypasses them.
    if (isStopped()) return { processed, reason: 'emergency stop is engaged' };
    if (isPaused()) return { processed, reason: 'queue is paused' };

    advanceAutopilotProjects();

    if (!opts.force) {
      const verdict = canRunNow();
      if (!verdict.ok) {
        logEvent('policy_block', verdict.reason);
        return { processed, reason: verdict.reason ?? 'blocked by policy' };
      }
    }

    const task = nextQueuedTask();
    if (!task) return { processed, reason: 'queue empty' };

    await runTask(task);
    processed++;
  }
  return { processed, reason: 'task limit reached' };
}

export interface RunTaskHooks {
  onSpawn?: (child: import('node:child_process').ChildProcess) => void;
}

export async function runTask(task: Task, hooks: RunTaskHooks = {}): Promise<void> {
  const project = getProject(task.project_id);
  if (!project) {
    markTaskFinished(task.id, 'failed', undefined, `project ${task.project_id} not found`);
    return;
  }

  fs.mkdirSync(project.workspace, { recursive: true });
  markTaskRunning(task.id);
  logEvent(
    'task_started',
    JSON.stringify({ taskId: task.id, model: task.model, attempt: task.attempts + 1, project: project.name })
  );

  const allowedTools = task.allowed_tools ? (JSON.parse(task.allowed_tools) as string[]) : DEFAULT_ALLOWED_TOOLS;

  const res = await runHeadless({
    brief: composeBrief(task, project),
    cwd: project.workspace,
    model: task.model,
    maxTurns: task.max_turns,
    allowedTools,
    onSpawn: hooks.onSpawn,
  });

  insertSession({
    taskId: task.id,
    claudeSessionId: res.sessionId,
    model: task.model,
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
    cacheCreationTokens: res.usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: res.usage?.cache_read_input_tokens ?? 0,
    numTurns: res.numTurns,
    durationMs: res.durationMs,
    costUsd: res.totalCostUsd,
    exitCode: res.exitCode,
    isError: !res.ok,
  });

  // Budget guard: a breach goes to human review — escalating a runaway task
  // would spend even more.
  const spent =
    (res.usage?.input_tokens ?? 0) +
    (res.usage?.output_tokens ?? 0) +
    (res.usage?.cache_creation_input_tokens ?? 0);
  if (spent > task.token_cap) {
    markTaskReview(task.id, `token cap breached: ${spent} > ${task.token_cap}`);
    logEvent('budget_breach', JSON.stringify({ taskId: task.id, spent, cap: task.token_cap }));
    return;
  }

  if (!res.ok) {
    const error = res.timedOut ? 'session timed out' : res.stderr.slice(0, 2000);

    // A plan-limit hit is not the task's fault: requeue it untouched and cool
    // down until the usage window resets, then the daemon resumes on its own.
    const combined = `${error}\n${res.resultText ?? ''}\n${res.rawStdout.slice(0, 500)}`;
    if (PLAN_LIMIT_RE.test(combined)) {
      requeueTask(task.id);
      const until = Date.now() + COOLDOWN_MS;
      setSetting('cooldown_until', String(until));
      // Ground truth: total est. spend at the moment the real limit bit IS the
      // window's observed capacity — the pressure gauge calibrates from this.
      const observed = scanUsage().window5h.costUsd;
      if (observed > 0) setSetting('observed_window_usd', observed.toFixed(2));
      logEvent(
        'window_exhausted',
        `task ${task.id} requeued; observed window capacity ~$${observed.toFixed(2)}; cooling down until ${new Date(until).toLocaleString()}`
      );
      return;
    }

    handleFailure(task, `session error: ${error}`);
    return;
  }

  if (task.validate_cmd) {
    const check = await runLocalCheck(task.validate_cmd, project.workspace);
    if (!check.pass) {
      handleFailure(task, `validation command failed (${task.validate_cmd}):\n${check.output}`);
      return;
    }
  }

  markTaskFinished(task.id, 'done', res.resultText);
  logEvent('task_done', JSON.stringify({ taskId: task.id, model: task.model, tokens: res.usage }));
}

function handleFailure(task: Task, note: string): void {
  const next = nextModel(task.model);
  if (next) {
    escalateTask(task.id, next, note);
    logEvent('escalated', JSON.stringify({ taskId: task.id, from: task.model, to: next }));
    return;
  }
  markTaskFinished(task.id, 'failed', undefined, note);
  logEvent('task_failed', JSON.stringify({ taskId: task.id, note: note.slice(0, 300) }));
}
