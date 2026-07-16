import {
  enqueueTask,
  listActiveAutopilotProjects,
  logEvent,
  projectTaskCounts,
  setProjectStage,
  setProjectStatus,
} from '../ledger/queries.js';
import { browserExtensionStage, nextStage } from './stages.js';
import { packageProject } from './package.js';

/**
 * Fire-and-forget mode: when every task of an autopilot project's current
 * stage is done, enqueue the next stage automatically. Failed or in-review
 * tasks freeze the project until a human clears them — problems always wait,
 * progress never does. Costs zero tokens.
 */
export function advanceAutopilotProjects(): void {
  for (const project of listActiveAutopilotProjects()) {
    const counts = projectTaskCounts(project.id);
    const blocked = (counts.failed ?? 0) + (counts.review ?? 0);
    const inFlight = (counts.queued ?? 0) + (counts.running ?? 0);
    const done = counts.done ?? 0;
    if (blocked > 0 || inFlight > 0 || done === 0) continue;

    const next = nextStage(project.stage);
    if (next === null) {
      const zip = packageProject(project);
      setProjectStatus(project.id, 'shipped');
      logEvent('ready_to_ship', JSON.stringify({ project: project.name, zip }));
      continue;
    }

    for (const t of browserExtensionStage(next, '')) {
      enqueueTask({
        projectId: project.id,
        brief: t.brief,
        taskType: t.taskType,
        model: t.model,
        maxTurns: t.maxTurns,
        validateCmd: t.validateCmd,
      });
    }
    setProjectStage(project.id, next);
    logEvent('stage_started', JSON.stringify({ project: project.name, stage: next, autopilot: true }));
  }
}
