import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LimitInfo {
  percent: number;
  resetsAt: number | null;
}

export interface RealLimits {
  fetchedAt: number;
  session: LimitInfo | null;
  weekly: LimitInfo | null;
  extraUsageEnabled: boolean | null;
}

interface UsageResponse {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  extra_usage?: { is_enabled?: boolean };
}

let cache: RealLimits | null = null;
let lastAttempt = 0;
const MIN_FETCH_INTERVAL_MS = 60_000;
const CACHE_FRESH_MS = 10 * 60_000;

/**
 * The same OAuth endpoint Claude's own apps use for the /usage display —
 * ground truth for the plan's session/weekly utilization and reset times.
 * Estimates remain the fallback when this is unreachable.
 */
export async function refreshLimits(force = false): Promise<RealLimits | null> {
  const now = Date.now();
  if (!force && now - lastAttempt < MIN_FETCH_INTERVAL_MS) return getCachedLimits();
  lastAttempt = now;

  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string };
    };
    const token = cred.claudeAiOauth?.accessToken;
    if (!token) return getCachedLimits();

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return getCachedLimits();

    const data = (await res.json()) as UsageResponse;
    cache = {
      fetchedAt: now,
      session: parseLimit(data.five_hour),
      weekly: parseLimit(data.seven_day),
      extraUsageEnabled: data.extra_usage?.is_enabled ?? null,
    };
    return cache;
  } catch {
    return getCachedLimits();
  }
}

export function getCachedLimits(): RealLimits | null {
  if (cache && Date.now() - cache.fetchedAt < CACHE_FRESH_MS) return cache;
  return null;
}

function parseLimit(x: { utilization?: number; resets_at?: string } | undefined): LimitInfo | null {
  if (!x || typeof x.utilization !== 'number') return null;
  const resetsAt = x.resets_at ? Date.parse(x.resets_at) : NaN;
  return { percent: x.utilization, resetsAt: Number.isNaN(resetsAt) ? null : resetsAt };
}
