import { spawn } from 'node:child_process';
import { VALIDATE_TIMEOUT_MS } from '../config.js';

export interface LocalCheckResult {
  pass: boolean;
  output: string;
}

/**
 * Free verification: run a shell command in the workspace at zero token cost.
 * Only when this fails does a model get consulted again.
 */
export function runLocalCheck(command: string, cwd: string): Promise<LocalCheckResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let output = '';
    const timer = setTimeout(() => child.kill(), VALIDATE_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ pass: false, output: `spawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ pass: code === 0, output: output.slice(0, 4000) });
    });
  });
}
