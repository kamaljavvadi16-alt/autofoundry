# ⚒ AutoFoundry

**A token-efficient orchestrator that turns surplus Claude Pro capacity into shipped products.**

AutoFoundry runs headless Claude Code sessions to autonomously build small revenue projects
(browser extensions, micro-tools) on the subscription capacity you weren't going to use anyway —
while metering every token, guaranteeing a reserve for your real work, and gating every ship
decision behind human review.

## Why it exists

Claude Pro quota works in 5-hour windows plus a weekly cap. Capacity you don't use in a window is
simply lost. AutoFoundry spends that surplus deliberately: overnight and while you're away, it
drains a task queue of product-building work — and the moment you're active again, it backs off.

## Architecture: hub-and-spoke, not agent swarm

The **hub is deterministic TypeScript** — routing, budgets, escalation, scheduling, and gates cost
zero tokens. LLM sessions are **stateless single-task spokes** that communicate only through files.
No agent-to-agent conversations, no growing context, no quadratic token blowup.

```
┌─────────────────────── orchestrator (0 tokens) ───────────────────────┐
│  queue → policy engine → model ladder → free verification → ledger    │
│     ▲          │                                              │       │
│ dashboard   spawns                                       SQLite +     │
│ (React/SSE) headless sessions (claude -p, one task, dies)  JSONL audit│
└────────────────────────────────────────────────────────────────────────┘
         workspaces/<project>/  ← spec.md · progress.md · handoff.md
```

### Token-efficiency mechanisms

| Mechanism | What it does |
|---|---|
| **Stateless sessions** | One task per session, fresh context, dies after. History lives in files, not conversations. |
| **File handoffs** | `spec.md` (fixed) / `progress.md` (log) / `handoff.md` (≤20-line baton pass) — a new session reads ~500 tokens instead of inheriting a 50k transcript. |
| **Model ladder** | Every task starts on Haiku; escalates to Sonnet only when validation fails. The ledger tracks escalation rate so you learn what genuinely needs the bigger model. |
| **Free verification first** | Tests/linters/`node -e` checks run locally at zero token cost. A model is consulted only on failure — and only with the failing output. |
| **Hard caps** | Per-task token caps and `--max-turns`; breaches go to human review instead of escalating (a runaway task never earns a bigger budget). |
| **Reserve enforcement** | A slider guarantees N% of your weekly capacity for your own work. The orchestrator also backs off whenever *you've* used Claude recently (activity detected from local session logs). |

### Token accounting

Claude Code writes per-message usage (`input`, `output`, `cache write`, `cache read`) into local
JSONL session logs. AutoFoundry parses these for **all** projects on the machine, so the ledger
knows exactly what the orchestrator spent *and* what you spent — no instrumentation, no estimates
for its own sessions (the CLI reports exact API-equivalent cost), calibrated estimates for yours.

## The pipeline

Projects move through **validate → prototype → polish → ship**, each stage a set of templated
tasks with per-task validation commands, and a **human gate between stages**:

```powershell
npm run foundry -- stage myext validate --idea "..."   # 1 planning task → spec.md
# you review spec.md, then:
npm run foundry -- stage myext prototype               # skeleton + popup + content script
npm run foundry -- stage myext polish                  # options page, README, listing copy
npm run foundry -- stage myext ship                    # consistency pass + ship-readiness verdict
npm run foundry -- package myext                       # → packages/myext-<date>.zip
```

## Dashboard

`npm run foundry -- serve -p 4321` → http://localhost:4321

- **Controls:** pause/resume, **emergency stop** (kills the in-flight session), reserve slider, cap calibration
- **Live session panel:** tokens ticking in real time over SSE
- **Token economics:** 5h-window gauge, weekly burn-down with reserve marker, you-vs-foundry spend split, cache-hit ratio, escalation rate, cost per shipped task
- **Review queue:** approve / retry / reject anything the policy engine flagged
- **ROI table:** revenue per project vs tokens spent
- **Audit log:** every session, decision, and control action

Add `--daemon` to also start the worker loop (it still obeys every policy check).

## CLI

```powershell
npm run foundry -- doctor            # environment check
npm run foundry -- enqueue "<brief>" [--validate "<cmd>"] [-m haiku|sonnet] [-p project]
npm run foundry -- run [--force]     # drain queue (force skips backoff/caps, never pause/stop)
npm run foundry -- status            # usage snapshot + policy verdict
npm run foundry -- report            # per-task and per-model token/cost table
npm run foundry -- verify <taskId>   # cross-check ledger vs raw JSONL logs
npm run foundry -- schedule install  # arm the nightly Task Scheduler job (00:30)
```

## Safety model

1. **Pause and emergency stop are absolute** — nothing bypasses them, including `--force`.
2. Worker sessions get a minimal tool allowlist and write only inside their own `workspaces/<project>/`.
3. Every stage transition and every ship is a human decision.
4. All caps are calibration knobs — tune `weekly_cap_usd` / `window_cap_usd` to where your plan's
   real limits bite.

Built for personal use on the owner's own subscription. It ships *artifacts* — it never proxies or
resells model access.

## Stack

TypeScript · Node 20 · better-sqlite3 · Express + SSE · React 18 + Vite · Claude Code headless mode

## Setup

```powershell
npm install
cd web; npm install; npm run build; cd ..
npm run foundry -- doctor
npm run foundry -- serve -p 4321
```

Requires the [Claude Code CLI](https://claude.ai/install.ps1) logged in to your subscription.
