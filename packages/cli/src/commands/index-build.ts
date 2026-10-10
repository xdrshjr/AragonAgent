/**
 * Ctrl+I project-index trigger (bundled `project-indexer` skill).
 *
 * WHY A MODULE AND NOT INLINE IN `App.tsx`. `App.tsx` is a documented
 * historical oversize file (see `.claude-index/config.md`); the convention
 * those entries record is that a feature only wires into it and keeps its
 * logic in a small named module. Everything here is pure and unit-tested:
 * the key handler in `App.tsx` guards, confirms, and dispatches; this file
 * owns the words and the names.
 *
 * THE TRIGGER IS A SKILL COMMAND, NOT A REIMPLEMENTATION. Ctrl+I dispatches
 * `/skill:project-indexer <args>` through the ordinary command path, so the
 * load/activate/queue-frame/submit lifecycle is the SAME one a typed command
 * gets, and the whole indexing run streams into the transcript like any
 * agent turn. All strings here are ASCII-only: `commands/` is inside the
 * `glyphs.test.ts` scan scope and every byte reaches a terminal.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The bundled skill Ctrl+I runs. Bundled skills are read-only by scope. */
export const INDEX_SKILL_NAME = 'project-indexer';

/** True when a previous run left a main index file behind (rebuild, not first build). */
export function hasProjectIndex(cwd: string): boolean {
  try {
    return existsSync(join(cwd, '.claude-index', 'index.md'));
  } catch {
    // A cwd that cannot be probed simply has no index to reuse.
    return false;
  }
}

/**
 * Args handed to `/skill:project-indexer`. They land in the skill body's
 * `$ARGUMENTS` placeholder, so the model sees WHY the turn started - a
 * confirmed keypress, not a typed request - and skips asking "proceed?" a
 * second time (the skill's own edge-case list says exactly that).
 */
export function indexBuildInvocationArgs(hasExistingIndex: boolean): string {
  return hasExistingIndex
    ? 'The user pressed Ctrl+I and confirmed. Rebuild the project index for this workspace now, reusing the existing .claude-index/config.md preferences.'
    : 'The user pressed Ctrl+I and confirmed. Build the project index for this workspace now, asking the configuration questions first.';
}

export interface IndexConfirmInput {
  cwd: string;
  /** True when `.claude-index/index.md` already exists (rebuild, not first build). */
  hasExistingIndex: boolean;
}

/**
 * The Yes/No dialog body. It names WHAT WILL BE WRITTEN - an index run is a
 * batch of file writes the user never typed, and the one question a confirm
 * gate must answer is "what did I just agree to?".
 */
export function buildIndexConfirmSummary(input: IndexConfirmInput): string {
  const action = input.hasExistingIndex ? 'Rebuild' : 'Build';
  const existing = input.hasExistingIndex
    ? '\nThe existing .claude-index/config.md preferences are reused.'
    : '\nThe bundled skill asks a few configuration questions first.';
  return (
    `${action} the project index for this workspace?\n` +
    `\nRuns the bundled "${INDEX_SKILL_NAME}" skill as a normal agent turn:` +
    `\n- scans the workspace (exclusions apply), extracts exported symbols` +
    `\n- writes .claude-index/index.md and .claude-index/config.md` +
    `\n- updates CLAUDE.md (index section + Clean Code Guidelines)` +
    `${existing}` +
    `\nWorkspace: ${input.cwd}` +
    `\nEvery step is visible in the transcript; Esc interrupts.`
  );
}
