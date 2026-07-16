import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { Command } from 'commander';
import { ROOT, WORKSPACES_ROOT, DEFAULT_MODEL, DEFAULT_MAX_TURNS } from './config.js';
import { getDb } from './ledger/db.js';
import {
  cancelTask,
  enqueueTask,
  getOrCreateProject,
  getProjectByName,
  getSetting,
  getTask,
  sessionsForTask,
  setProjectAutopilot,
  setProjectStage,
  setSetting,
  logEvent,
} from './ledger/queries.js';
import { launchIdea } from './pipeline/go.js';
import { packageProject } from './pipeline/package.js';
import { refreshLimits } from './policy/limits.js';
import { browserExtensionStage, STAGE_ORDER, type Stage } from './pipeline/stages.js';
import { locateClaude } from './runner/locate.js';
import { canRunNow } from './policy/policy.js';
import { processQueue } from './queue.js';
import { findSessionFile, sumSessionUsage } from './watcher/jsonl.js';

const program = new Command();
program.name('foundry').description('AutoFoundry — token-efficient Claude orchestrator');

program
  .command('doctor')
  .description('Check environment: claude binary, database, workspaces')
  .action(() => {
    const bin = locateClaude();
    console.log(`claude binary : ${bin}`);
    getDb();
    console.log('database      : ok (foundry.db)');
    fs.mkdirSync(WORKSPACES_ROOT, { recursive: true });
    console.log(`workspaces    : ${WORKSPACES_ROOT}`);
  });

program
  .command('enqueue')
  .description('Add a task to the queue')
  .argument('<brief>', 'the task brief (what the session should do)')
  .option('-p, --project <name>', 'project name', 'sandbox')
  .option('-m, --model <model>', 'model to use', DEFAULT_MODEL)
  .option('-t, --max-turns <n>', 'max agent turns', String(DEFAULT_MAX_TURNS))
  .option('--tools <list>', 'comma-separated allowed tools')
  .option('--type <type>', 'task type (dev|raw)', 'dev')
  .option('--validate <cmd>', 'shell command run in the workspace; non-zero exit = failed, triggers escalation')
  .action((brief: string, opts) => {
    const project = getOrCreateProject(opts.project);
    const task = enqueueTask({
      projectId: project.id,
      brief,
      taskType: opts.type,
      model: opts.model,
      maxTurns: Number(opts.maxTurns),
      allowedTools: opts.tools ? String(opts.tools).split(',') : undefined,
      validateCmd: opts.validate,
    });
    console.log(`queued task #${task.id} [${task.model}] in project "${project.name}"`);
  });

program
  .command('cancel')
  .description('Cancel a queued or review task')
  .argument('<taskId>')
  .action((taskId: string) => {
    const ok = cancelTask(Number(taskId));
    console.log(ok ? `task ${taskId} cancelled` : `task ${taskId} not cancellable (not queued/review)`);
  });

program
  .command('run')
  .description('Process the queue until empty or blocked by policy')
  .option('-n, --max-tasks <n>', 'process at most N tasks')
  .option('-f, --force', 'ignore usage/activity policy (still respects task queue)')
  .action(async (opts) => {
    const outcome = await processQueue({
      maxTasks: opts.maxTasks ? Number(opts.maxTasks) : undefined,
      force: Boolean(opts.force),
    });
    console.log(`processed ${outcome.processed} task(s); stopped: ${outcome.reason}`);
  });

program
  .command('status')
  .description('Show control flags, real plan limits, usage snapshot, and policy verdict')
  .action(async () => {
    const limits = await refreshLimits(true);
    if (limits) {
      const fmt = (l: { percent: number; resetsAt: number | null } | null) =>
        l ? `${l.percent}% used — resets ${l.resetsAt ? new Date(l.resetsAt).toLocaleString() : 'unknown'}` : 'unavailable';
      console.log(`session (real) : ${fmt(limits.session)}`);
      console.log(`weekly (real)  : ${fmt(limits.weekly)}`);
      console.log(`extra usage    : ${limits.extraUsageEnabled ? 'ENABLED — disable it to guarantee $0 billing!' : 'disabled (no billing possible)'}`);
    } else {
      console.log('real limits    : unavailable — falling back to estimates');
    }
    const verdict = canRunNow();
    const s = verdict.snapshot;
    const fmt = (b: typeof s.week) =>
      `$${b.costUsd.toFixed(2)} est (${b.messages} msgs, in ${b.inputTokens}, out ${b.outputTokens}, cache w/r ${b.cacheWriteTokens}/${b.cacheReadTokens})`;

    console.log(`paused         : ${getSetting('paused') === '1'}`);
    console.log(`stopped        : ${getSetting('stopped') === '1'}`);
    console.log(`reserve        : ${getSetting('reserve_pct')}% of weekly cap ($${getSetting('weekly_cap_usd')})`);
    console.log(`window cap     : $${getSetting('window_cap_usd')} per 5h`);
    console.log(`last user act. : ${s.lastUserActivityAt ? new Date(s.lastUserActivityAt).toLocaleString() : 'none'}`);
    console.log(`5h window      : ${fmt(s.window5h)}`);
    console.log(`7d total       : ${fmt(s.week)}`);
    console.log(`7d orchestrator: ${fmt(s.weekOwn)}`);
    console.log(`7d user (yours): ${fmt(s.weekUser)}`);
    console.log(`verdict        : ${verdict.ok ? 'CLEAR TO RUN' : `BLOCKED — ${verdict.reason}`}`);
  });

program
  .command('set')
  .description('Update a setting (reserve_pct, weekly_cap_usd, window_cap_usd, activity_backoff_min)')
  .argument('<key>')
  .argument('<value>')
  .action((key: string, value: string) => {
    setSetting(key, value);
    logEvent('setting_changed', `${key}=${value}`);
    console.log(`${key} = ${value}`);
  });

program
  .command('report')
  .description('Show tasks and token usage')
  .action(() => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT t.id, p.name AS project, t.task_type AS type, t.status, t.model,
                COALESCE(SUM(s.input_tokens), 0)  AS input,
                COALESCE(SUM(s.output_tokens), 0) AS output,
                COALESCE(SUM(s.cache_creation_tokens), 0) AS cache_w,
                COALESCE(SUM(s.cache_read_tokens), 0)     AS cache_r,
                ROUND(COALESCE(SUM(s.cost_usd), 0), 4)    AS cost_usd
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN sessions s ON s.task_id = t.id
         GROUP BY t.id ORDER BY t.id`
      )
      .all();
    console.table(rows);

    const totals = db
      .prepare(
        `SELECT model,
                COUNT(*) AS sessions,
                SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                SUM(cache_creation_tokens) AS cache_w, SUM(cache_read_tokens) AS cache_r,
                ROUND(SUM(cost_usd), 4) AS cost_usd
         FROM sessions GROUP BY model`
      )
      .all();
    if (totals.length) {
      console.log('\nPer-model totals:');
      console.table(totals);
    }
  });

program
  .command('verify')
  .description('Cross-check a task\'s ledger tokens against the raw session JSONL log')
  .argument('<taskId>', 'task id')
  .action((taskId: string) => {
    const task = getTask(Number(taskId));
    if (!task) throw new Error(`task ${taskId} not found`);
    const sessions = sessionsForTask(task.id);
    if (!sessions.length) throw new Error(`task ${taskId} has no sessions`);

    for (const s of sessions) {
      if (!s.claude_session_id) {
        console.log(`session ${s.id}: no claude session id recorded`);
        continue;
      }
      const file = findSessionFile(s.claude_session_id);
      if (!file) {
        console.log(`session ${s.id}: JSONL not found for ${s.claude_session_id}`);
        continue;
      }
      const jsonl = sumSessionUsage(file);
      console.log(`session ${s.id} (${s.claude_session_id}):`);
      console.table([
        { source: 'ledger', input: s.input_tokens, output: s.output_tokens, cache_w: s.cache_creation_tokens, cache_r: s.cache_read_tokens },
        { source: 'jsonl', input: jsonl.inputTokens, output: jsonl.outputTokens, cache_w: jsonl.cacheCreationTokens, cache_r: jsonl.cacheReadTokens },
      ]);
    }
  });

program
  .command('go')
  .description('Fire-and-forget: give an extension idea, walk away. Autopilots validate→prototype→polish→ship→zip.')
  .argument('<idea>', 'the product idea, in plain words')
  .option('--name <name>', 'project name (default: derived from the idea)')
  .action((idea: string, opts) => {
    const project = launchIdea(idea, opts.name as string | undefined);
    console.log(`🚀 "${project.name}" is on autopilot.`);
    console.log('It will move through every stage on its own and end as a zip in packages\\.');
    console.log('Problems (failed validation, budget breach) pause it in the review queue — progress never needs you.');
    console.log('Make sure the daemon is running: start-foundry.cmd or "npm run foundry -- serve -p 4321 --daemon"');
  });

program
  .command('autopilot')
  .description('Turn fire-and-forget mode on/off for an existing project')
  .argument('<project>')
  .argument('<mode>', 'on | off')
  .action((projectName: string, mode: string) => {
    const project = getProjectByName(projectName);
    if (!project) throw new Error(`project "${projectName}" not found`);
    setProjectAutopilot(project.id, mode === 'on');
    logEvent('autopilot_toggled', `${projectName} ${mode}`);
    console.log(`autopilot ${mode} for "${projectName}"`);
  });

program
  .command('stage')
  .description('Enqueue all tasks for a pipeline stage of a project (human gate between stages)')
  .argument('<project>', 'project name')
  .argument('<stage>', 'validate | prototype | polish | ship')
  .option('--idea <text>', 'the product idea (required for the validate stage)')
  .action((projectName: string, stage: string, opts) => {
    if (!STAGE_ORDER.includes(stage as Stage)) {
      throw new Error(`unknown stage "${stage}" — use one of: ${STAGE_ORDER.join(', ')}`);
    }
    if (stage === 'validate' && !opts.idea) {
      throw new Error('the validate stage needs --idea "<the product idea>"');
    }
    const project = getOrCreateProject(projectName, 'browser-extension');
    const tasks = browserExtensionStage(stage as Stage, String(opts.idea ?? ''));
    for (const t of tasks) {
      const task = enqueueTask({
        projectId: project.id,
        brief: t.brief,
        taskType: t.taskType,
        model: t.model,
        maxTurns: t.maxTurns,
        validateCmd: t.validateCmd,
      });
      console.log(`queued task #${task.id} [${t.model}] — ${t.brief.slice(0, 70)}...`);
    }
    setProjectStage(project.id, stage);
    logEvent('stage_started', JSON.stringify({ project: project.name, stage, tasks: tasks.length }));
    console.log(`project "${project.name}" is now in stage "${stage}" (${tasks.length} task(s) queued)`);
  });

program
  .command('package')
  .description('Zip a project workspace for shipping (excludes handoff/progress files)')
  .argument('<project>', 'project name')
  .action((projectName: string) => {
    const project = getProjectByName(projectName);
    if (!project) throw new Error(`project "${projectName}" not found`);
    console.log(`packaged: ${packageProject(project)}`);
  });

program
  .command('schedule')
  .description('Manage the overnight Windows Task Scheduler job (runs the queue on surplus tokens)')
  .argument('<action>', 'install | remove | status')
  .option('--time <hh:mm>', 'daily start time', '00:30')
  .action((action: string, opts: { time: string }) => {
    const taskName = 'AutoFoundry-Nightly';
    const time = opts.time;
    if (action === 'install') {
      const cmd = `cmd /c "cd /d ${ROOT} && npm run --silent foundry -- run >> nightly.log 2>&1"`;
      const out = execFileSync('schtasks.exe', ['/Create', '/F', '/TN', taskName, '/TR', cmd, '/SC', 'DAILY', '/ST', time], {
        encoding: 'utf8',
      });
      logEvent('schedule_installed', `${taskName} at ${time}`);
      console.log(out.trim());
      console.log('Nightly job armed. It drains the queue but every policy check (reserve, caps, activity backoff, pause, stop) still applies.');
    } else if (action === 'remove') {
      const out = execFileSync('schtasks.exe', ['/Delete', '/F', '/TN', taskName], { encoding: 'utf8' });
      logEvent('schedule_removed', taskName);
      console.log(out.trim());
    } else if (action === 'status') {
      try {
        const out = execFileSync('schtasks.exe', ['/Query', '/TN', taskName, '/V', '/FO', 'LIST'], { encoding: 'utf8' });
        console.log(out.trim().split('\n').slice(0, 12).join('\n'));
      } catch {
        console.log('not installed');
      }
    } else {
      throw new Error(`unknown action "${action}" — use install | remove | status`);
    }
  });

program
  .command('serve')
  .description('Start the dashboard server (and optionally the work daemon)')
  .option('-p, --port <port>', 'port', '4321')
  .option('-d, --daemon', 'auto-start the work daemon')
  .action(async (opts) => {
    const { startServer } = await import('./server/server.js');
    startServer(Number(opts.port), Boolean(opts.daemon));
  });

program
  .command('now')
  .description('Start working immediately, ignoring your recent activity (budgets still apply)')
  .argument('[hours]', 'how long the override lasts; 0 turns it off', '4')
  .action((hours: string) => {
    const h = Number(hours);
    if (h <= 0) {
      setSetting('boost_until', '0');
      logEvent('boost_off', 'via CLI');
      console.log('start-now override off — normal activity backoff applies again');
      return;
    }
    const until = Date.now() + h * 60 * 60 * 1000;
    setSetting('boost_until', String(until));
    logEvent('boost_on', `start now (${h}h) via CLI`);
    console.log(`working immediately until ${new Date(until).toLocaleTimeString()} — make sure the daemon is running`);
  });

program
  .command('pause')
  .description('Pause the queue (finishes nothing new; current task completes)')
  .action(() => {
    setSetting('paused', '1');
    logEvent('paused', 'via CLI');
    console.log('paused');
  });

program
  .command('resume')
  .description('Resume the queue')
  .action(() => {
    setSetting('paused', '0');
    setSetting('stopped', '0');
    logEvent('resumed', 'via CLI');
    console.log('resumed');
  });

program
  .command('stop')
  .description('Stop the queue (emergency brake; resume clears it)')
  .action(() => {
    setSetting('stopped', '1');
    logEvent('stopped', 'via CLI');
    console.log('stopped');
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
