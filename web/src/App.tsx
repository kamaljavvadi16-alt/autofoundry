import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fmtAgo,
  fmtTokens,
  fmtUsd,
  get,
  post,
  type EventRow,
  type LiveTick,
  type ProjectRow,
  type State,
  type TaskRow,
} from './api';

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [live, setLive] = useState<LiveTick | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);

  const refreshTables = useCallback(() => {
    void get<TaskRow[]>('/api/tasks').then(setTasks).catch(() => {});
    void get<ProjectRow[]>('/api/projects').then(setProjects).catch(() => {});
    void get<EventRow[]>('/api/events').then(setEvents).catch(() => {});
  }, []);

  useEffect(() => {
    refreshTables();
    const es = new EventSource('/api/stream');
    es.addEventListener('state', (e) => {
      const next = JSON.parse((e as MessageEvent).data) as State;
      setState(next);
      if (!next.daemon.currentTask) setLive(null);
      refreshTables();
    });
    es.addEventListener('live', (e) => setLive(JSON.parse((e as MessageEvent).data) as LiveTick));
    return () => es.close();
  }, [refreshTables]);

  if (!state) return <p style={{ padding: 24 }}>Connecting to AutoFoundry…</p>;

  return (
    <>
      <TopBar state={state} />
      <Banner state={state} />
      <Tiles state={state} />
      {state.daemon.currentTask && <LivePanel state={state} live={live} />}
      <div className="columns">
        <div>
          <ReviewQueue tasks={tasks} />
          <TaskTable tasks={tasks} />
          <EnqueueForm />
        </div>
        <div>
          <ControlsCard state={state} />
          <ProjectsCard projects={projects} />
          <EventLog events={events} />
        </div>
      </div>
    </>
  );
}

function TopBar({ state }: { state: State }) {
  const d = state.daemon;
  return (
    <div className="topbar">
      <h1>⚒ AutoFoundry</h1>
      <span className={`pill ${d.running ? 'on' : 'off'}`}>
        <span className="dot" /> daemon {d.running ? 'running' : 'off'}
      </span>
      <div className="spacer" />
      {d.running ? (
        <button onClick={() => void post('/api/control', { action: 'daemon_stop' })}>Stop daemon</button>
      ) : (
        <button onClick={() => void post('/api/control', { action: 'daemon_start' })}>Start daemon</button>
      )}
      {state.settings.paused ? (
        <button onClick={() => void post('/api/control', { action: 'resume' })}>Resume</button>
      ) : (
        <button onClick={() => void post('/api/control', { action: 'pause' })}>Pause</button>
      )}
      <button
        className="danger"
        onClick={() => {
          if (confirm('Emergency stop: kills the running session and halts everything. Continue?')) {
            void post('/api/control', { action: 'stop' });
          }
        }}
      >
        ■ EMERGENCY STOP
      </button>
    </div>
  );
}

function Banner({ state }: { state: State }) {
  const { settings, verdict, daemon } = state;
  if (settings.stopped)
    return (
      <div className="banner stopped">
        ⛔ <strong>Emergency stop engaged.</strong>&nbsp;Nothing will run until you press Resume.
      </div>
    );
  if (settings.paused)
    return (
      <div className="banner blocked">
        ⏸ <strong>Paused.</strong>&nbsp;Queue is held; your main-project tokens are safe.
      </div>
    );
  if (!verdict.ok)
    return (
      <div className="banner blocked">
        🛡 <strong>Holding back:</strong>&nbsp;{verdict.reason}
      </div>
    );
  return (
    <div className="banner clear">
      ✅ <strong>Clear to run.</strong>&nbsp;
      {daemon.currentTask ? `Working on task #${daemon.currentTask.id}.` : daemon.running ? 'Waiting for tasks.' : 'Daemon is off — start it to process the queue.'}
    </div>
  );
}

function Meter({ value, cap, mark }: { value: number; cap: number; mark?: number }) {
  const pct = cap > 0 ? Math.min(100, (value / cap) * 100) : 0;
  const cls = pct >= 100 ? 'crit' : pct >= 80 ? 'warn' : '';
  return (
    <div className="meter">
      <div className={`fill ${cls}`} style={{ width: `${pct}%` }} />
      {mark !== undefined && cap > 0 && <div className="mark" style={{ left: `${Math.min(100, (mark / cap) * 100)}%` }} />}
    </div>
  );
}

function Tiles({ state }: { state: State }) {
  const s = state.snapshot;
  const set = state.settings;
  const weeklyBudget = set.weekly_cap_usd * (1 - set.reserve_pct / 100);
  const totalWeek = s.weekOwn.costUsd + s.weekUser.costUsd;

  return (
    <div className="grid-tiles">
      <div className="tile">
        <div className="label">5h window (est)</div>
        <div className="value">{fmtUsd(s.window5h.costUsd)}</div>
        <div className="sub">cap {fmtUsd(set.window_cap_usd)}</div>
        <Meter value={s.window5h.costUsd} cap={set.window_cap_usd} />
      </div>
      <div className="tile">
        <div className="label">Weekly burn (est)</div>
        <div className="value">{fmtUsd(s.week.costUsd)}</div>
        <div className="sub">
          orchestrator budget {fmtUsd(weeklyBudget)} · reserve {set.reserve_pct}%
        </div>
        <Meter value={s.week.costUsd} cap={set.weekly_cap_usd} mark={weeklyBudget} />
      </div>
      <div className="tile">
        <div className="label">Who spent it (7d)</div>
        <div className="value">{totalWeek > 0 ? `${Math.round((s.weekOwn.costUsd / totalWeek) * 100)}%` : '0%'}</div>
        <div className="sub">of spend is orchestrator</div>
        <div className="split">
          <div className="user" style={{ flex: Math.max(s.weekUser.costUsd, 0.0001) }} />
          <div className="own" style={{ flex: Math.max(s.weekOwn.costUsd, 0.0001) }} />
        </div>
        <div className="legend">
          <span>
            <span className="sw" style={{ background: 'var(--blue)' }} />
            you {fmtUsd(s.weekUser.costUsd)}
          </span>
          <span>
            <span className="sw" style={{ background: 'var(--green)' }} />
            foundry {fmtUsd(s.weekOwn.costUsd)}
          </span>
        </div>
      </div>
      <div className="tile">
        <div className="label">Cache hit ratio</div>
        <div className="value">{(state.stats.cacheHitRatio * 100).toFixed(0)}%</div>
        <div className="sub">reads vs fresh+written (all sessions)</div>
      </div>
      <div className="tile">
        <div className="label">Escalation rate</div>
        <div className="value">{(state.stats.escalationRate * 100).toFixed(0)}%</div>
        <div className="sub">attempts that moved up the ladder</div>
      </div>
      <div className="tile">
        <div className="label">Cost / shipped task</div>
        <div className="value">{fmtUsd(state.stats.costPerDoneTask)}</div>
        <div className="sub">{state.stats.doneTasks} done · API-equivalent</div>
      </div>
      <div className="tile">
        <div className="label">Your last activity</div>
        <div className="value" style={{ fontSize: 18 }}>{fmtAgo(s.lastUserActivityAt)}</div>
        <div className="sub">backoff {set.activity_backoff_min} min</div>
      </div>
    </div>
  );
}

function LivePanel({ state, live }: { state: State; live: LiveTick | null }) {
  const t = state.daemon.currentTask!;
  return (
    <div className="card">
      <h2>
        Live session — task #{t.id} on {t.model}
      </h2>
      <p style={{ margin: '0 0 10px', color: 'var(--ink-2)' }}>{t.brief}</p>
      <div className="live">
        <Stat label="output" value={live ? fmtTokens(live.outputTokens) : '…'} />
        <Stat label="fresh input" value={live ? fmtTokens(live.inputTokens) : '…'} />
        <Stat label="cache write" value={live ? fmtTokens(live.cacheCreationTokens) : '…'} />
        <Stat label="cache read" value={live ? fmtTokens(live.cacheReadTokens) : '…'} />
        <Stat label="elapsed" value={live ? `${Math.floor((Date.now() - live.startedAt) / 1000)}s` : '…'} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function ReviewQueue({ tasks }: { tasks: TaskRow[] }) {
  const review = tasks.filter((t) => t.status === 'review');
  if (review.length === 0) return null;
  return (
    <div className="card" style={{ borderColor: 'var(--serious)' }}>
      <h2>⚠ Review queue — needs your call</h2>
      <table>
        <tbody>
          {review.map((t) => (
            <tr key={t.id}>
              <td>#{t.id}</td>
              <td>
                <div className="brief">{t.brief}</div>
                {t.error && <div className="err">{t.error}</div>}
              </td>
              <td className="num">{fmtUsd(t.cost_usd)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="small" onClick={() => void post(`/api/tasks/${t.id}/approve`)}>
                  Approve
                </button>{' '}
                <button className="small" onClick={() => void post(`/api/tasks/${t.id}/requeue`)}>
                  Retry
                </button>{' '}
                <button className="small" onClick={() => void post(`/api/tasks/${t.id}/cancel`)}>
                  Reject
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TaskTable({ tasks }: { tasks: TaskRow[] }) {
  return (
    <div className="card">
      <h2>Tasks</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Brief</th>
            <th>Project</th>
            <th>Status</th>
            <th>Model</th>
            <th className="num">Tokens</th>
            <th className="num">Cost</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td>{t.id}</td>
              <td>
                <div className="brief">{t.brief}</div>
                {t.status === 'failed' && t.error && <div className="err">{t.error.slice(0, 200)}</div>}
              </td>
              <td>{t.project}</td>
              <td>
                <span className={`chip ${t.status}`}>{t.status}</span>
                {t.attempts > 0 && <span style={{ color: 'var(--muted)', fontSize: 11 }}> ×{t.attempts + 1}</span>}
              </td>
              <td>{t.model}</td>
              <td className="num">{fmtTokens(t.tokens)}</td>
              <td className="num">{fmtUsd(t.cost_usd)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {t.status === 'queued' && (
                  <button className="small" onClick={() => void post(`/api/tasks/${t.id}/cancel`)}>
                    Cancel
                  </button>
                )}
                {(t.status === 'failed' || t.status === 'cancelled') && (
                  <button className="small" onClick={() => void post(`/api/tasks/${t.id}/requeue`)}>
                    Requeue
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EnqueueForm() {
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const projectRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLSelectElement>(null);
  const validateRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="card">
      <h2>Enqueue task</h2>
      <form
        className="enqueue"
        onSubmit={(e) => {
          e.preventDefault();
          const brief = briefRef.current?.value.trim();
          if (!brief) return;
          setBusy(true);
          void post('/api/tasks', {
            brief,
            project: projectRef.current?.value.trim() || 'sandbox',
            model: modelRef.current?.value,
            validate: validateRef.current?.value.trim() || undefined,
          })
            .then(() => {
              if (briefRef.current) briefRef.current.value = '';
              if (validateRef.current) validateRef.current.value = '';
            })
            .finally(() => setBusy(false));
        }}
      >
        <textarea ref={briefRef} placeholder="What should the worker session do? One task, clearly specified." />
        <div className="row">
          <input ref={projectRef} placeholder="project (default: sandbox)" style={{ flex: 1 }} />
          <select ref={modelRef} defaultValue="haiku">
            <option value="haiku">haiku (ladder start)</option>
            <option value="sonnet">sonnet</option>
          </select>
        </div>
        <input ref={validateRef} placeholder="validation command, e.g. node test.js (optional — exit 0 = pass)" />
        <div className="row">
          <button type="submit" disabled={busy}>
            {busy ? 'Queuing…' : 'Add to queue'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ControlsCard({ state }: { state: State }) {
  const s = state.settings;
  const [reserve, setReserve] = useState(s.reserve_pct);
  useEffect(() => setReserve(s.reserve_pct), [s.reserve_pct]);

  return (
    <div className="card">
      <h2>Token protection</h2>
      <div className="setting-row">
        <label>Reserve for your main work</label>
        <input
          type="range"
          min={0}
          max={90}
          step={5}
          value={reserve}
          onChange={(e) => setReserve(Number(e.target.value))}
          onMouseUp={() => void post('/api/settings', { key: 'reserve_pct', value: reserve })}
          onTouchEnd={() => void post('/api/settings', { key: 'reserve_pct', value: reserve })}
        />
        <span className="val">{reserve}%</span>
      </div>
      <NumberSetting label="Weekly cap (est USD)" k="weekly_cap_usd" value={s.weekly_cap_usd} />
      <NumberSetting label="5h window cap (est USD)" k="window_cap_usd" value={s.window_cap_usd} />
      <NumberSetting label="Activity backoff (min)" k="activity_backoff_min" value={s.activity_backoff_min} />
      <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 0 }}>
        Caps are API-equivalent estimates of your Pro plan limits — calibrate them when you observe where the real
        limits bite.
      </p>
    </div>
  );
}

function NumberSetting({ label, k, value }: { label: string; k: string; value: number }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <div className="setting-row">
      <label>{label}</label>
      <input
        type="number"
        value={v}
        min={0}
        style={{ width: 90 }}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          if (Number(v) !== value) void post('/api/settings', { key: k, value: Number(v) });
        }}
      />
    </div>
  );
}

function ProjectsCard({ projects }: { projects: ProjectRow[] }) {
  return (
    <div className="card">
      <h2>Projects · ROI</h2>
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>Stage</th>
            <th className="num">Cost</th>
            <th className="num">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.stage}</td>
              <td className="num">{fmtUsd(p.cost_usd)}</td>
              <td className="num">
                <RevenueCell project={p} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RevenueCell({ project }: { project: ProjectRow }) {
  const [v, setV] = useState((project.revenue_cents / 100).toFixed(2));
  useEffect(() => setV((project.revenue_cents / 100).toFixed(2)), [project.revenue_cents]);
  return (
    <input
      type="number"
      value={v}
      min={0}
      step="0.01"
      style={{ width: 84, textAlign: 'right' }}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const cents = Math.round(Number(v) * 100);
        if (Number.isFinite(cents) && cents !== project.revenue_cents) {
          void post(`/api/projects/${project.id}/revenue`, { cents });
        }
      }}
    />
  );
}

function EventLog({ events }: { events: EventRow[] }) {
  return (
    <div className="card">
      <h2>Audit log</h2>
      <div className="log">
        {events.map((e) => (
          <div className="row" key={e.id}>
            <span className="t">{e.created_at.slice(5, 16)}</span>
            <span className="k">{e.kind}</span>
            <span className="d">{e.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
