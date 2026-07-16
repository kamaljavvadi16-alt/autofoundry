import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_PROJECTS_DIR } from '../config.js';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  assistantMessages: number;
}

interface LogLine {
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

/**
 * Sums token usage across a session's JSONL log. Streamed responses log the
 * same message id multiple times with cumulative usage, so we keep only the
 * last occurrence per message id.
 */
export function sumSessionUsage(jsonlPath: string): UsageTotals {
  const byMessageId = new Map<string, NonNullable<NonNullable<LogLine['message']>['usage']>>();
  const content = fs.readFileSync(jsonlPath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj: LogLine;
    try {
      obj = JSON.parse(line) as LogLine;
    } catch {
      continue;
    }
    const msg = obj.message;
    if (msg?.usage && msg.id) byMessageId.set(msg.id, msg.usage);
  }

  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    assistantMessages: byMessageId.size,
  };
  for (const u of byMessageId.values()) {
    totals.inputTokens += u.input_tokens ?? 0;
    totals.outputTokens += u.output_tokens ?? 0;
    totals.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
    totals.cacheReadTokens += u.cache_read_input_tokens ?? 0;
  }
  return totals;
}

export function findSessionFile(sessionId: string): string | null {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
  for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
    const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
