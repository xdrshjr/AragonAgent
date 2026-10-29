/**
 * The status bar's governance chip: pure width planning, no JSX
 * (governance-mode section 10.2).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * SAME SHAPE AS `kit-chip.ts` / `session-chip.ts`, for the same reason: the status row is
 * measured cell by cell, and a chip appended "just to the right" eats `phase`, the one
 * field a user needs mid-run. The chip therefore competes for the SAME budget as every
 * other field: it takes the longest rung that still leaves the left half its floor.
 *
 * THE LADDER (spec 10.2): `GOV p2/3 REVIEW` -> `GOV p2/3` -> `GOV`. A paused run reads
 * `GOV paused`, one with a `/gov pause` still pending `GOV pausing` (warn tone: the stop is
 * coming), an escalated one `GOV ! escalated` (warn tone - it is the run asking for
 * the user), and a budget at or past 80% appends ` $` at every rung where there is room,
 * because the hint is worth more than the stage name when space is short.
 */

import type { GovernanceSnapshot } from '../../model/governance/types.js';
import {
  budgetState, isFinishedRun, isPausePending, activeStepKey, type Tone,
} from '../governance-status.js';
import { PIPELINE_LABEL, STATUS_WORD, phaseText } from '../governance-copy.js';

export const GOVERNANCE_CHIP_LIMITS = {
  /** Blank cells between the chip and the field run. */
  gapCells: 2,
  /** The floor the left half must keep; the same 34 the session and kit chips use. */
  minStatusCells: 34,
} as const;

export interface GovernanceChipPlan {
  visible: boolean;
  text: string;
  cells: number;
  gap: number;
  tone: Tone;
}

export interface GovernanceChipInput {
  columns: number;
  snapshot?: GovernanceSnapshot | null | undefined;
}

const HIDDEN: GovernanceChipPlan = { visible: false, text: '', cells: 0, gap: 0, tone: 'muted' };

/** Candidate texts, longest first. ASCII `!` is the escalation mark in both glyph tiers. */
function rungs(snapshot: GovernanceSnapshot): string[] {
  const budget = budgetState(snapshot);
  const hint = budget === 'warn' || budget === 'over' ? ' $' : '';
  if (isPausePending(snapshot)) {
    return [`GOV ${STATUS_WORD.pausing}${hint}`, `GOV${hint}`];
  }
  if (snapshot.status === 'paused') return [`GOV paused${hint}`, `GOV${hint}`];
  if (snapshot.status === 'escalated') {
    return [`GOV ! escalated${hint}`, `GOV !${hint}`, 'GOV !'];
  }
  const phase = phaseText(snapshot.phase, snapshot.phaseCount);
  const stage = activeStepKey(snapshot);
  const named = stage === null ? phase : `${phase} ${PIPELINE_LABEL[stage]}`;
  return [`GOV ${named}${hint}`, `GOV ${phase}${hint}`, `GOV${hint}`, 'GOV'];
}

function chipTone(snapshot: GovernanceSnapshot): Tone {
  if (snapshot.status === 'escalated' || budgetState(snapshot) === 'over') return 'warn';
  if (isPausePending(snapshot)) return 'warn';
  return snapshot.status === 'paused' ? 'muted' : 'govern';
}

/** Plan the chip for `columns` and this session's live run snapshot. */
export function planGovernanceChip(input: GovernanceChipInput): GovernanceChipPlan {
  const snapshot = input.snapshot;
  if (!snapshot || isFinishedRun(snapshot.status)) return HIDDEN;
  const columns = Number.isFinite(input.columns) ? Math.floor(input.columns) : 0;
  const gap = GOVERNANCE_CHIP_LIMITS.gapCells;
  for (const text of rungs(snapshot)) {
    if (columns - (text.length + gap) >= GOVERNANCE_CHIP_LIMITS.minStatusCells) {
      return { visible: true, text, cells: text.length, gap, tone: chipTone(snapshot) };
    }
  }
  return HIDDEN;
}
