import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { ROOT } from '../config.js';
import { getDb } from '../ledger/db.js';
import {
  cancelTask,
  enqueueTask,
  getOrCreateProject,
  getSetting,
  logEvent,
  setSetting,
} from '../ledger/queries.js';
import { launchIdea } from '../pipeline/go.js';
import { canRunNow } from '../policy/policy.js';
import { Daemon } from './daemon.js';

const SETTING_KEYS = ['reserve_pct', 'weekly_cap_usd', 'window_cap_usd', 'activity_backoff_min'] as const;

export function startServer(port: number, autoStartDaemon: boolean): void {
  const app = express();
  app.use(express.json());
  const daemon = new Daemon();
  const clients = new Set<Response>();

  function broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  }

  daemon.on('state', () => broadcast('state', buildState(daemon)));
  daemon.on('live', (tick) => broadcast('live', tick));

  app.get('/api/state', (_req, res) => res.json(buildState(daemon)));

  app.get('/api/tasks', (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT t.id, p.name AS project, t.task_type, t.status, t.model, t.attempts, t.priority,
                t.brief, t.error, t.validate_cmd, t.created_at, t.finished_at,
                COALESCE(SUM(s.input_tokens + s.output_tokens + s.cache_creation_tokens), 0) AS tokens,
                COALESCE(SUM(s.cache_read_tokens), 0) AS cache_read,
                ROUND(COALESCE(SUM(s.cost_usd), 0), 4) AS cost_usd
         FROM tasks t JOIN projects p ON p.id = t.project_id
         LEFT JOIN sessions s ON s.task_id = t.id
         GROUP BY t.id ORDER BY t.id DESC LIMIT 200`
      )
      .all();
    res.json(rows);
  });

  app.get('/api/projects', (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT p.id, p.name, p.lane, p.stage, p.status, p.revenue_cents,
                COUNT(DISTINCT t.id) AS tasks,
                ROUND(COALESCE(SUM(s.cost_usd), 0), 4) AS cost_usd,
                COALESCE(SUM(s.input_tokens + s.output_tokens + s.cache_creation_tokens), 0) AS tokens
         FROM projects p
         LEFT JOIN tasks t ON t.project_id = p.id
         LEFT JOIN sessions s ON s.task_id = t.id
         GROUP BY p.id ORDER BY p.id`
      )
      .all();
    res.json(rows);
  });

  app.get('/api/events', (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM events ORDER BY id DESC LIMIT 150').all());
  });

  app.get('/api/stream', (req: Request, res: Response) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`event: state\ndata: ${JSON.stringify(buildState(daemon))}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });

  app.post('/api/control', (req, res) => {
    const action = String(req.body?.action ?? '');
    switch (action) {
      case 'pause':
        setSetting('paused', '1');
        logEvent('paused', 'via dashboard');
        break;
      case 'resume':
        setSetting('paused', '0');
        setSetting('stopped', '0');
        logEvent('resumed', 'via dashboard');
        daemon.poke();
        break;
      case 'stop':
        setSetting('stopped', '1');
        daemon.killCurrent();
        logEvent('stopped', 'EMERGENCY STOP via dashboard');
        break;
      case 'daemon_start':
        daemon.start();
        break;
      case 'daemon_stop':
        daemon.stop();
        break;
      case 'run_now':
        setSetting('boost_until', String(Date.now() + 4 * 60 * 60 * 1000));
        setSetting('paused', '0');
        setSetting('stopped', '0');
        daemon.start();
        daemon.poke();
        logEvent('boost_on', 'start now (4h) via dashboard');
        break;
      case 'boost_off':
        setSetting('boost_until', '0');
        logEvent('boost_off', 'via dashboard');
        break;
      default:
        res.status(400).json({ error: `unknown action: ${action}` });
        return;
    }
    broadcast('state', buildState(daemon));
    res.json({ ok: true });
  });

  app.post('/api/settings', (req, res) => {
    const { key, value } = req.body ?? {};
    if (!SETTING_KEYS.includes(key) || !Number.isFinite(Number(value))) {
      res.status(400).json({ error: 'invalid setting' });
      return;
    }
    setSetting(String(key), String(Number(value)));
    logEvent('setting_changed', `${key}=${value} via dashboard`);
    broadcast('state', buildState(daemon));
    res.json({ ok: true });
  });

  app.post('/api/go', (req, res) => {
    const idea = String(req.body?.idea ?? '').trim();
    if (idea.length < 10) {
      res.status(400).json({ error: 'describe the idea in at least a few words' });
      return;
    }
    const name = String(req.body?.name ?? '').trim() || undefined;
    const project = launchIdea(idea, name);
    daemon.poke();
    broadcast('state', buildState(daemon));
    res.json({ name: project.name });
  });

  app.post('/api/tasks', (req, res) => {
    const { brief, project, model, maxTurns, validate, type } = req.body ?? {};
    if (!brief || typeof brief !== 'string') {
      res.status(400).json({ error: 'brief is required' });
      return;
    }
    const proj = getOrCreateProject(String(project || 'sandbox'));
    const task = enqueueTask({
      projectId: proj.id,
      brief,
      taskType: type ? String(type) : 'dev',
      model: model ? String(model) : undefined,
      maxTurns: maxTurns ? Number(maxTurns) : undefined,
      validateCmd: validate ? String(validate) : undefined,
    });
    logEvent('task_enqueued', `#${task.id} via dashboard`);
    daemon.poke();
    broadcast('state', buildState(daemon));
    res.json(task);
  });

  app.post('/api/tasks/:id/cancel', (req, res) => {
    const ok = cancelTask(Number(req.params.id));
    broadcast('state', buildState(daemon));
    res.json({ ok });
  });

  app.post('/api/tasks/:id/requeue', (req, res) => {
    const info = getDb()
      .prepare(
        `UPDATE tasks SET status = 'queued', started_at = NULL, finished_at = NULL
         WHERE id = ? AND status IN ('failed', 'review', 'cancelled')`
      )
      .run(Number(req.params.id));
    if (info.changes > 0) {
      logEvent('task_requeued', `#${req.params.id} via dashboard`);
      daemon.poke();
    }
    broadcast('state', buildState(daemon));
    res.json({ ok: info.changes > 0 });
  });

  app.post('/api/tasks/:id/approve', (req, res) => {
    const info = getDb()
      .prepare("UPDATE tasks SET status = 'done', finished_at = datetime('now') WHERE id = ? AND status = 'review'")
      .run(Number(req.params.id));
    if (info.changes > 0) logEvent('task_approved', `#${req.params.id} via dashboard`);
    broadcast('state', buildState(daemon));
    res.json({ ok: info.changes > 0 });
  });

  app.post('/api/projects/:id/revenue', (req, res) => {
    const cents = Number(req.body?.cents);
    if (!Number.isFinite(cents) || cents < 0) {
      res.status(400).json({ error: 'invalid cents' });
      return;
    }
    getDb().prepare('UPDATE projects SET revenue_cents = ? WHERE id = ?').run(Math.round(cents), Number(req.params.id));
    broadcast('state', buildState(daemon));
    res.json({ ok: true });
  });

  const dist = path.join(ROOT, 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    app.get('/', (_req, res) =>
      res.type('text/plain').send('Dashboard not built yet. Run: cd web && npm install && npm run build')
    );
  }

  // Periodic refresh so gauges track the rolling windows even when idle.
  setInterval(() => broadcast('state', buildState(daemon)), 30_000).unref();

  const server = app.listen(port, () => {
    console.log(`AutoFoundry dashboard: http://localhost:${port}`);
    if (autoStartDaemon) daemon.start();
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use — AutoFoundry is probably already running.`);
      console.error(`Open http://localhost:${port} in your browser instead of starting it again.`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  });
}

function buildState(daemon: Daemon) {
  const verdict = canRunNow();
  const db = getDb();

  const escalations = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'escalated'").get() as { n: number }).n;
  const starts = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'task_started'").get() as { n: number }).n;
  const cache = db
    .prepare(
      `SELECT COALESCE(SUM(cache_read_tokens), 0) AS r,
              COALESCE(SUM(input_tokens + cache_creation_tokens), 0) AS w
       FROM sessions`
    )
    .get() as { r: number; w: number };
  const doneCost = db
    .prepare(
      `SELECT COUNT(*) AS n, ROUND(COALESCE(SUM(s.cost_usd), 0), 4) AS cost
       FROM tasks t LEFT JOIN sessions s ON s.task_id = t.id WHERE t.status = 'done'`
    )
    .get() as { n: number; cost: number };

  return {
    verdict: { ok: verdict.ok, reason: verdict.reason ?? null },
    snapshot: verdict.snapshot,
    settings: {
      paused: getSetting('paused') === '1',
      stopped: getSetting('stopped') === '1',
      reserve_pct: Number(getSetting('reserve_pct')),
      weekly_cap_usd: Number(getSetting('weekly_cap_usd')),
      window_cap_usd: Number(getSetting('window_cap_usd')),
      activity_backoff_min: Number(getSetting('activity_backoff_min')),
      observed_window_usd: getSetting('observed_window_usd') ? Number(getSetting('observed_window_usd')) : null,
      boost_until: Number(getSetting('boost_until') ?? 0),
    },
    daemon: {
      running: daemon.running,
      idleReason: daemon.lastVerdictReason,
      currentTask: daemon.currentTask
        ? { id: daemon.currentTask.id, model: daemon.currentTask.model, brief: daemon.currentTask.brief.slice(0, 160) }
        : null,
    },
    stats: {
      escalationRate: starts > 0 ? escalations / starts : 0,
      cacheHitRatio: cache.r + cache.w > 0 ? cache.r / (cache.r + cache.w) : 0,
      doneTasks: doneCost.n,
      costPerDoneTask: doneCost.n > 0 ? doneCost.cost / doneCost.n : 0,
    },
    generatedAt: Date.now(),
  };
}
