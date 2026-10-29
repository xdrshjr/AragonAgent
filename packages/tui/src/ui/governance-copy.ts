/**
 * Governance TUI copy: every user-visible English phrase of the legion panel, the chip,
 * the settlement card and the `/gov board` overlay (governance-mode section 10.6).
 *
 * ASCII ONLY (`src/ui/**` is glyph-scanned). Phrases that need a symbol take it as a
 * template parameter from `pickGlyphs(caps)` instead of spelling it.
 *
 * WHY THIS LIVES IN `ui/` AND NOT IN `governance/copy.ts`: the engine author owns that
 * file and it carries the model-facing and notice wording. This module holds the strings
 * only the TUI draws, so the two cannot collide while both are being written. When
 * `governance/copy.ts` lands, a phrase that appears in both belongs THERE and this file
 * re-exports it - the unit tests pin these strings, so the move is a compile error and
 * not a silent fork.
 */

import type { GovAgentState, GovRole, PipelineStepKey } from '../model/governance/types.js';

export const GOV_TITLE = 'GOVERN';

/** One word for each pipeline step, as printed in the step strip. */
export const PIPELINE_LABEL: Readonly<Record<PipelineStepKey, string>> = {
  intake: 'INTAKE',
  dev: 'DEV',
  review: 'REVIEW',
  test: 'TEST',
  settle: 'SETTLE',
  integrate: 'INTEGRATE',
  fix: 'FIX',
};

/** The role word in the roster's role column. */
export const ROLE_LABEL: Readonly<Record<GovRole, string>> = {
  DEV: 'DEV',
  REV: 'REV',
  TEST: 'TEST',
  INSP: 'INSP',
};

/** What a `working` agent is doing, by role: the row says WHAT, the marker says THAT. */
export const WORKING_VERB: Readonly<Record<GovRole, string>> = {
  DEV: 'coding',
  REV: 'reviewing',
  TEST: 'testing',
  INSP: 'checking',
};

/** The state column's word for every non-working state. */
export const STATE_WORD: Readonly<Record<Exclude<GovAgentState, 'working'>, string>> = {
  queued: 'queued',
  submitted: 'submitted',
  idle: 'idle',
  failed: 'failed',
  eliminated: 'replaced',
};

export const NOT_SCORED = 'not scored';
export const MORE_HINT = '(/gov board)';
export const PANEL_LEDGER_LABEL = 'ledger';
export const PANEL_HEALTH_LABEL = 'health';
export const PANEL_TOKEN_UNIT = 'tok';
export const PANEL_BOARD_HINT = '/gov board';
export const STATUS_WORD = {
  pausing: 'pausing',
  paused: 'paused',
  escalated: 'escalated',
  abandoned: 'abandoned',
  closed: 'closed',
} as const;

/** `pausing after REVIEW`: a `/gov pause` is waiting for the running stage to finish. */
export function pausingText(stage: string): string {
  return stage === '' ? STATUS_WORD.pausing : `${STATUS_WORD.pausing} after ${stage}`;
}

/** `replaced by dev2-r1` (the glyph in front comes from the roster marker). */
export function replacedByText(
  successor: string | null,
  nameOf?: (label: string) => string,
): string {
  if (successor === null) return 'replaced';
  // A persona name reads better than an engine id; an unnamed id stays as it is.
  const display = nameOf?.(successor) ?? '';
  return `replaced by ${display.length > 0 ? display : successor}`;
}

export function moreText(hidden: number): string {
  return `+${hidden} more ${MORE_HINT}`;
}

export function workingCountText(count: number): string {
  return `${count} working`;
}

export function phaseText(phase: number, phaseCount: number): string {
  return `p${phase}/${phaseCount}`;
}

export function phaseLongText(phase: number, phaseCount: number): string {
  return `phase ${phase}/${phaseCount}`;
}

/** Board tab names, in tab order. */
export const BOARD_TAB_LABEL = {
  roster: 'Roster',
  work: 'Work packages',
  ledger: 'Ledger',
  claims: 'Claims',
} as const;

export const BOARD_TITLE = 'Governance board';
export const BOARD_EMPTY = {
  noRun: 'No governed run yet. Use /gov or Shift+Tab to enter GOVERN.',
  roster: 'No agents yet.',
  work: 'No work packages recorded for this view.',
  ledger: 'No ledger entries yet.',
  claims: 'No claims or escalations.',
} as const;
export const BOARD_COPIED = 'Copied the board file path';
export const BOARD_NO_PATH = 'No board file path is available yet';

export const CARD_TITLE = 'Governance';
export const CARD_COLUMNS = {
  name: 'name',
  id: 'id',
  role: 'role',
  confirmed: 'confirmed',
  delta: 'delta',
} as const;
