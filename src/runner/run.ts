import { spawn, type ChildProcess } from 'node:child_process';
import { SESSION_TIMEOUT_MS } from '../config.js';
import { locateClaude } from './locate.js';

export interface HeadlessUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface HeadlessResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  sessionId?: string;
  resultText?: string;
  subtype?: string;
  isError: boolean;
  numTurns?: number;
  durationMs?: number;
  totalCostUsd?: number;
  usage?: HeadlessUsage;
  stderr: string;
  rawStdout: string;
}

export interface RunOptions {
  brief: string;
  cwd: string;
  model: string;
  maxTurns: number;
  allowedTools?: string[];
  timeoutMs?: number;
  onSpawn?: (child: ChildProcess) => void;
}

export function runHeadless(opts: RunOptions): Promise<HeadlessResult> {
  const bin = locateClaude();
  const args = ['-p', '--output-format', 'json', '--model', opts.model, '--max-turns', String(opts.maxTurns)];
  if (opts.allowedTools?.length) {
    args.push('--allowedTools', opts.allowedTools.join(','));
  }

  // Hard guarantee: sessions run on the subscription login only. Even if an
  // API key ever appears in the environment, it must never be billed.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    opts.onSpawn?.(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? SESSION_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));

    // The brief goes via stdin — avoids Windows argument-quoting issues for
    // long multi-line prompts.
    child.stdin.write(opts.brief, 'utf8');
    child.stdin.end();

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        timedOut,
        isError: true,
        stderr: `spawn error: ${err.message}\n${stderr}`,
        rawStdout: stdout,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        // non-JSON output (crash, rate-limit banner, etc.)
      }

      if (!parsed) {
        resolve({
          ok: false,
          exitCode: code,
          timedOut,
          isError: true,
          stderr: stderr || stdout.slice(0, 2000),
          rawStdout: stdout,
        });
        return;
      }

      const usage = parsed.usage as HeadlessUsage | undefined;
      resolve({
        ok: code === 0 && parsed.is_error !== true && !timedOut,
        exitCode: code,
        timedOut,
        sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined,
        resultText: typeof parsed.result === 'string' ? parsed.result : undefined,
        subtype: typeof parsed.subtype === 'string' ? parsed.subtype : undefined,
        isError: parsed.is_error === true,
        numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : undefined,
        durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : undefined,
        totalCostUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined,
        usage,
        stderr,
        rawStdout: stdout,
      });
    });
  });
}
