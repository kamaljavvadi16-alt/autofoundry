import type { Project, Task } from '../ledger/queries.js';

/**
 * Wraps a task brief with the stateless-session protocol: read the handoff
 * files for context (cheaper than inlining them), do one task, write the
 * handoff back. Raw tasks bypass the wrapper entirely.
 */
export function composeBrief(task: Task, project: Project): string {
  if (task.task_type === 'raw') return task.brief;

  const parts = [
    `You are a stateless worker session for project "${project.name}". Complete exactly one task, then stop. Keep output minimal — no summaries beyond what the exit protocol requires.`,
    '',
    '## Context (read before starting, if the files exist)',
    '- spec.md — project specification. Never modify it.',
    '- progress.md — running log of completed work.',
    '- handoff.md — note left by the previous session.',
    '',
    '## Task',
    task.brief,
  ];

  if (task.error) {
    parts.push('', '## Previous attempt failed', task.error.slice(0, 1500), 'Fix the underlying problem; do not repeat the same approach.');
  }

  parts.push(
    '',
    '## Exit protocol (mandatory, do this last)',
    '- Append one short entry to progress.md: what you did, max 5 lines.',
    '- Overwrite handoff.md: current state, next step, open issues — max 20 lines.'
  );

  return parts.join('\n');
}
