export const STAGE_ORDER = ['validate', 'prototype', 'polish', 'ship'] as const;
export type Stage = (typeof STAGE_ORDER)[number];

export interface StageTask {
  brief: string;
  taskType: 'dev' | 'raw';
  model: string;
  maxTurns: number;
  validateCmd?: string;
}

const FILE_EXISTS = (files: string[]) =>
  `node -e "['${files.join("','")}'].forEach(f=>require('fs').accessSync(f))"`;

const MANIFEST_PARSES = 'node -e "JSON.parse(require(\'fs\').readFileSync(\'manifest.json\',\'utf8\'))"';

/**
 * Task templates for the browser-extension lane. Turn budgets are generous:
 * a session that runs out of turns is retried automatically with more, but
 * every retry costs tokens, so err high here.
 */
export function browserExtensionStage(stage: Stage, idea: string): StageTask[] {
  switch (stage) {
    case 'validate':
      return [
        {
          taskType: 'raw',
          model: 'sonnet',
          maxTurns: 12,
          brief: [
            'You are planning a Chrome browser extension. Write a file named spec.md in the current directory - nothing else.',
            '',
            '## The idea',
            idea,
            '',
            '## spec.md must contain (max 120 lines total)',
            '- Problem: who has it, how painful, how they solve it today',
            '- Target user',
            '- MVP features: 5 max, each one sentence',
            '- Non-goals for v1',
            '- Monetization: concrete plan (free tier limits, paid unlock, price point)',
            '- Store listing draft: name, 132-char short description, long description',
            '- Success criteria: measurable, for the first 30 days',
            '- Risks: top 3, one line each',
          ].join('\n'),
          validateCmd: FILE_EXISTS(['spec.md']),
        },
      ];

    case 'prototype':
      return [
        {
          taskType: 'dev',
          model: 'haiku',
          maxTurns: 28,
          brief:
            'Per spec.md: create the Chrome extension skeleton - manifest.json (Manifest V3, minimal permissions), directory layout, and empty-but-valid entry files it references. Vanilla JS only, no build step.',
          validateCmd: MANIFEST_PARSES,
        },
        {
          taskType: 'dev',
          model: 'haiku',
          maxTurns: 30,
          brief:
            'Per spec.md: implement the popup UI (popup.html/popup.css/popup.js) covering the MVP features that live in the popup. Use chrome.storage.sync for persistence. Vanilla JS, clean minimal styling.',
          validateCmd: FILE_EXISTS(['popup.html', 'popup.js']),
        },
        {
          taskType: 'dev',
          model: 'haiku',
          maxTurns: 30,
          brief:
            'Per spec.md: implement the content-script functionality for the MVP and register it in manifest.json. Handle the target sites listed in spec.md. Fail gracefully on unknown pages.',
          validateCmd: MANIFEST_PARSES,
        },
      ];

    case 'polish':
      return [
        {
          taskType: 'dev',
          model: 'haiku',
          maxTurns: 40,
          brief:
            'Polish pass per spec.md: add an options page (register in manifest), input validation and error handling throughout, and empty-state UX in the popup. Keep bundle dependency-free.',
          validateCmd: MANIFEST_PARSES,
        },
        {
          taskType: 'dev',
          model: 'haiku',
          maxTurns: 28,
          brief:
            'Write README.md (install-unpacked instructions, feature list, screenshots placeholder) and listing.md (final store listing copy per spec.md, plus a checklist of assets still needed e.g. PNG icons 16/48/128 and screenshots). Create simple SVG icon drafts icon16.svg/icon48.svg/icon128.svg.',
          validateCmd: FILE_EXISTS(['README.md', 'listing.md']),
        },
      ];

    case 'ship':
      return [
        {
          taskType: 'dev',
          model: 'sonnet',
          maxTurns: 30,
          brief:
            'Final review pass: read spec.md and every file in the workspace. Fix anything broken or inconsistent (manifest references, dead code, spec mismatches). Then update progress.md with a ship-readiness verdict: what works, what still needs a human (icons, screenshots, store account, payment setup).',
          validateCmd: MANIFEST_PARSES,
        },
      ];
  }
}

export function nextStage(current: string): Stage | null {
  const i = STAGE_ORDER.indexOf(current as Stage);
  if (i === -1 || i + 1 >= STAGE_ORDER.length) return null;
  return STAGE_ORDER[i + 1] ?? null;
}
