import {
  enqueueTask,
  getOrCreateProject,
  getProjectByName,
  logEvent,
  setProjectAutopilot,
  setProjectStage,
  type Project,
} from '../ledger/queries.js';
import { browserExtensionStage } from './stages.js';

/** Fire-and-forget entry point shared by the CLI and the dashboard. */
export function launchIdea(idea: string, name?: string): Project {
  const projectName = uniqueName(name ?? slugFromIdea(idea));
  const project = getOrCreateProject(projectName, 'browser-extension');
  setProjectAutopilot(project.id, true);
  for (const t of browserExtensionStage('validate', idea)) {
    enqueueTask({
      projectId: project.id,
      brief: t.brief,
      taskType: t.taskType,
      model: t.model,
      maxTurns: t.maxTurns,
      validateCmd: t.validateCmd,
    });
  }
  setProjectStage(project.id, 'validate');
  logEvent('go', JSON.stringify({ project: projectName, idea: idea.slice(0, 120) }));
  return project;
}

const STOPWORDS = new Set([
  'i', 'a', 'an', 'the', 'want', 'need', 'to', 'for', 'that', 'this', 'which', 'with',
  'make', 'build', 'create', 'chrome', 'browser', 'extension', 'app', 'my', 'me', 'my',
  'please', 'of', 'and', 'in', 'on', 'it', 'is', 'be', 'can', 'will', 'would', 'like',
]);

function slugFromIdea(idea: string): string {
  const words = idea
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .slice(0, 3);
  return words.join('-') || 'idea';
}

function uniqueName(base: string): string {
  if (!getProjectByName(base)) return base;
  for (let i = 2; ; i++) {
    if (!getProjectByName(`${base}-${i}`)) return `${base}-${i}`;
  }
}
