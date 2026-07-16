import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let cached: string | null = null;

export function locateClaude(): string {
  if (cached) return cached;

  try {
    const out = execFileSync('where.exe', ['claude'], { encoding: 'utf8' });
    const exe = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.toLowerCase().endsWith('.exe'));
    if (exe) return (cached = exe);
  } catch {
    // not on PATH
  }

  const nativeInstall = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(nativeInstall)) return (cached = nativeInstall);

  const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
  if (fs.existsSync(extRoot)) {
    const bundled = fs
      .readdirSync(extRoot)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort()
      .reverse()
      .map((d) => path.join(extRoot, d, 'resources', 'native-binary', 'claude.exe'))
      .find((p) => fs.existsSync(p));
    if (bundled) return (cached = bundled);
  }

  throw new Error(
    'claude binary not found. Install it with: irm https://claude.ai/install.ps1 | iex'
  );
}
