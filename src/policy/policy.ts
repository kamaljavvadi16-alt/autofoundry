import { getSetting, isPaused, isStopped, setSetting } from '../ledger/queries.js';
import { getCachedLimits } from './limits.js';
import { scanUsage, type UsageSnapshot } from './usage.js';

function fmtReset(resetsAt: number | null): string {
  return resetsAt ? new Date(resetsAt).toLocaleString() : 'unknown';
}

export interface PolicyVerdict {
  ok: boolean;
  reason?: string;
  snapshot: UsageSnapshot;
}

function num(key: string, fallback: number): number {
  const v = Number(getSetting(key));
  return Number.isFinite(v) ? v : fallback;
}

/**
 * All caps are estimated API-equivalent USD values of the Pro plan's limits.
 * They are calibration knobs (settings: weekly_cap_usd, window_cap_usd) —
 * tune them when you observe where the real limits actually bite.
 */
export function canRunNow(snapshot?: UsageSnapshot): PolicyVerdict {
  const snap = snapshot ?? scanUsage();

  if (isStopped()) return { ok: false, reason: 'emergency stop is engaged', snapshot: snap };
  if (isPaused()) return { ok: false, reason: 'queue is paused', snapshot: snap };

  const cooldown = Number(getSetting('cooldown_until') ?? 0);
  if (cooldown > snap.generatedAt) {
    // Self-heal: if the account says the session window is actually fine, the
    // cooldown is stale — clear it instead of waiting out a wrong timer.
    const rl = getCachedLimits();
    if (rl?.session && rl.session.percent < 90) {
      setSetting('cooldown_until', '0');
    } else {
      return {
        ok: false,
        reason: `plan limit hit — cooling down until ${new Date(cooldown).toLocaleTimeString()}`,
        snapshot: snap,
      };
    }
  }

  // Real plan limits (read from the Claude account) take precedence over any
  // estimate. A limit whose reset time has passed no longer blocks, even if
  // the cached percent is stale.
  const reservePct = num('reserve_pct', 30);
  const limits = getCachedLimits();
  const notYetReset = (l: { resetsAt: number | null }) => l.resetsAt === null || l.resetsAt > snap.generatedAt;
  if (limits?.session && limits.session.percent >= 95 && notYetReset(limits.session)) {
    return {
      ok: false,
      reason: `plan session limit at ${limits.session.percent}% — resets ${fmtReset(limits.session.resetsAt)}`,
      snapshot: snap,
    };
  }
  const weeklyStopPct = 100 - reservePct;
  if (limits?.weekly && limits.weekly.percent >= weeklyStopPct && notYetReset(limits.weekly)) {
    return {
      ok: false,
      reason: `weekly plan at ${limits.weekly.percent}% — foundry stops at ${weeklyStopPct}% to keep your ${reservePct}% reserve (resets ${fmtReset(limits.weekly.resetsAt)})`,
      snapshot: snap,
    };
  }

  // "Start now" boost: the user explicitly told us to work despite their own
  // activity. Budgets, pause, stop, and cooldown all still apply.
  const boosted = num('boost_until', 0) > snap.generatedAt;
  const backoffMin = num('activity_backoff_min', 30);
  if (!boosted && snap.lastUserActivityAt !== null) {
    const idleMin = (snap.generatedAt - snap.lastUserActivityAt) / 60_000;
    if (idleMin < backoffMin) {
      return {
        ok: false,
        reason: `user active ${idleMin.toFixed(1)} min ago (backoff ${backoffMin} min)`,
        snapshot: snap,
      };
    }
  }

  // Budgets meter ONLY the orchestrator's own spend — the user's activity can
  // never block the foundry via these.
  const weeklyCap = num('weekly_cap_usd', 200);
  const weeklyBudget = weeklyCap * (1 - reservePct / 100);
  if (snap.weekOwn.costUsd >= weeklyBudget) {
    return {
      ok: false,
      reason: `foundry weekly budget spent ($${snap.weekOwn.costUsd.toFixed(2)} of $${weeklyBudget.toFixed(2)}; ${reservePct}% of the plan stays yours)`,
      snapshot: snap,
    };
  }

  const windowCap = num('window_cap_usd', 10);
  if (snap.window5hOwn.costUsd >= windowCap) {
    return {
      ok: false,
      reason: `foundry 5h budget spent ($${snap.window5hOwn.costUsd.toFixed(2)} of $${windowCap.toFixed(2)}) — resets as the window rolls`,
      snapshot: snap,
    };
  }

  return { ok: true, snapshot: snap };
}
