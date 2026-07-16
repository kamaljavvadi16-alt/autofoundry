import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACES_ROOT } from '../config.js';
import { logEvent, type Project } from '../ledger/queries.js';

/** Zip a project workspace for shipping (excludes handoff/progress files). */
export function packageProject(project: Project): string {
  const outDir = path.join(WORKSPACES_ROOT, '..', 'packages');
  fs.mkdirSync(outDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-pkg-'));
  fs.cpSync(project.workspace, staging, {
    recursive: true,
    filter: (src) => !/(^|[\\/])(progress\.md|handoff\.md|.*\.zip)$/i.test(src),
  });
  const zip = path.join(outDir, `${project.name}-${new Date().toISOString().slice(0, 10)}.zip`);
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zip}' -Force`,
  ]);
  fs.rmSync(staging, { recursive: true, force: true });
  logEvent('packaged', JSON.stringify({ project: project.name, zip }));
  return zip;
}
