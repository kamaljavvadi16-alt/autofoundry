import { getSetting, isPaused, isStopped } from '../ledger/queries.js';
import { scanUsage, type UsageSnapshot } from './usage.js';

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
    return {
      ok: false,
      reason: `plan limit hit — cooling down until ${new Date(cooldown).toLocaleTimeString()}`,
      snapshot: snap,
    };
  }

  const backoffMin = num('activity_backoff_min', 30);
  if (snap.lastUserActivityAt !== null) {
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
  // never block the foundry. Overall plan exhaustion is handled by ground
  // truth: a real limit error triggers the cooldown above and calibrates the
  // observed window capacity.
  const weeklyCap = num('weekly_cap_usd', 200);
  const reservePct = num('reserve_pct', 30);
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
