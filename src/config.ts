import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DB_PATH = path.join(ROOT, 'foundry.db');
export const WORKSPACES_ROOT = path.resolve(ROOT, '..', 'workspaces');
export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

export const MODEL_LADDER = ['haiku', 'sonnet'] as const;
export const DEFAULT_MODEL = MODEL_LADDER[0];
export const DEFAULT_MAX_TURNS = 30;
export const DEFAULT_TOKEN_CAP = 200_000;
export const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
export const VALIDATE_TIMEOUT_MS = 2 * 60 * 1000;

export function nextModel(current: string): string | null {
  const i = MODEL_LADDER.indexOf(current as (typeof MODEL_LADDER)[number]);
  if (i === -1 || i + 1 >= MODEL_LADDER.length) return null;
  return MODEL_LADDER[i + 1] ?? null;
}

export const DEFAULT_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
