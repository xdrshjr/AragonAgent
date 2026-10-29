/**
 * The header's LEFT half budget (tui-shortcut-drawer-and-task-summary §4.3).
 *
 * ASCII ONLY: `src/ui/**` is inside the glyph scanner's scope.
 *
 * WHY A PLANNER (the same argument `header-hints.ts` makes one file over): the
 * left half used to be a `<Text wrap="truncate">` over four clauses with no
 * clause-level arithmetic anywhere, so the only thing that ever decided what got
 * cut was the terminal. Adding a fifth clause - the task summary - to that shape
 * produces a header where the summary silently eats the directory name on an
 * 80-column terminal and NO ASSERTION WOULD SEE IT, because losing trailing
 * characters is invisible to a snapshot test.
 *
 * THE PRIORITY ORDER IS THE DESIGN: brand, then `provider:model`, then cwd, then
 * the summary, with the key symbol reserved up front. The summary is the only
 * clause that is allowed to disappear entirely - it is the newest and the least
 * load-bearing (D-2) - and it is dropped rather than rendered as `...`, because a
 * cell holding three dots spends eight columns to say nothing.
 */

import { cellWidth, fitCells } from './cells.js';
import { TASK_SUMMARY_LIMITS } from '../../model/fast/limits.js';

export const HEADER_LEFT_LIMITS = {
  /** The `AragonAgent` word mark, the same 13 `header-hints.ts` documents. */
  brandCells: 13,
  /** Blank cells between two left clauses. */
  gapCells: 2,
  /** The has-key symbol (1 cell) plus its gap, always reserved. */
  keyCells: 3,
  /** Below this the model clause is dropped rather than rendered as `a...`. */
  modelMinCells: 8,
  /** Below this the cwd clause is dropped. */
  cwdMinCells: 8,
  /** Below this the summary is dropped instead of rendered as `...`. */
  summaryMinCells: 8,
  /**
   * The separator that belongs to the SUMMARY rather than to the general gap:
   * two spaces, the mid dot and one space. It is reserved together with the label
   * so a summary can never be drawn without its dot, or the dot without it.
   */
  summaryGapCells: 4,
} as const;

export interface HeaderLeftPlan {
  text: { model: string; cwd: string; summary: string };
  cells: { model: number; cwd: number; summary: number };
  /**
   * Why the summary cell is empty. `pending` is not a reason: a pending summary
   * draws nothing at all, so the plan is indistinguishable from `empty` - which
   * is exactly what removed the v1 layout jitter on the first submit.
   */
  summaryReason: 'ok' | 'empty' | 'narrow' | 'disabled';
}

export interface HeaderLeftInput {
  /** Cells the header gives the left half (`columns - hintCells - separatorCells`). */
  leftCells: number;
  provider: string;
  model: string;
  cwd: string;
  hasKey: boolean;
  /** `null` while pending, empty or disabled - the planner never sees a placeholder. */
  summary: { text: string; tone: 'model' | 'fallback' } | null;
  summaryEnabled: boolean;
  ellipsis: string;
}

/** `provider:model`, the clause `Header` prints after the word mark. */
export function modelClause(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** The directory name, falling back to the whole path for a bare root. */
export function cwdClause(cwd: string, basename: (path: string) => string): string {
  return basename(cwd) || cwd;
}

/**
 * Allocate the left half.
 *
 * THE ORDER OF THE FOUR STEPS IS THE PRIORITY (D-2):
 *  1. reserve the word mark, its gap and the key symbol - they are never cut;
 *  2. `provider:model`, down to `modelMinCells`, then dropped;
 *  3. cwd, down to `cwdMinCells`, then dropped;
 *  4. the summary, capped at `TASK_SUMMARY_LIMITS.maxCells`, dropped below
 *     `summaryMinCells` and reported as `narrow`.
 *
 * THE LADDER IS EXPLICIT RATHER THAN GREEDY, and that is a correction to v2's
 * algorithm, which funded the summary out of the reserved budget and could therefore
 * show a label on a row where the model name had already been dropped. Four
 * presence sets are tried from most to least complete; within a set the LAST clause
 * gives way first, each only down to its own minimum. The first set that fits wins.
 *
 * Every returned text already MEASURES its reported width, so `Header` renders
 * cells rather than hoping for them.
 */
export function planHeaderLeft(input: HeaderLeftInput): HeaderLeftPlan {
  const leftCells = Number.isFinite(input.leftCells) ? Math.max(0, Math.floor(input.leftCells)) : 0;
  const empty: HeaderLeftPlan = {
    text: { model: '', cwd: '', summary: '' },
    cells: { model: 0, cwd: 0, summary: 0 },
    summaryReason: input.summaryEnabled ? 'empty' : 'disabled',
  };
  const gap = HEADER_LEFT_LIMITS.gapCells;
  // Everything the planner never touches, taken off the top so no later step can
  // borrow from it.
  // `keyCells` already contains the gap before the symbol, so this is the whole fixed
  // cost and every clause below pays its own gap.
  const budget = leftCells - HEADER_LEFT_LIMITS.brandCells - HEADER_LEFT_LIMITS.keyCells;
  if (budget <= 0) {
    return {
      ...empty,
      summaryReason: input.summaryEnabled
        ? (input.summary === null ? 'empty' : 'narrow')
        : 'disabled',
    };
  }

  const model = modelClause(input.provider, input.model);
  const summaryText = input.summary?.text ?? '';
  const wantsSummary = input.summaryEnabled && input.summary !== null;
  /** Desired width and the floor this clause may be cut to. */
  const clause = (text: string, floor: number): { want: number; floor: number } => ({
    want: cellWidth(text),
    floor: Math.min(cellWidth(text), floor),
  });
  const modelWanted = clause(model, HEADER_LEFT_LIMITS.modelMinCells);
  const cwdWanted = clause(input.cwd, HEADER_LEFT_LIMITS.cwdMinCells);
  const summaryWanted = {
    want: Math.min(cellWidth(summaryText), TASK_SUMMARY_LIMITS.maxCells),
    // A label is never shown below its minimum: a three-cell label is a fragment,
    // not a label, and the cell is dropped instead.
    floor: HEADER_LEFT_LIMITS.summaryMinCells,
  };

  const sets: Array<Array<'model' | 'cwd' | 'summary'>> = [
    ['model', 'cwd', ...(wantsSummary ? (['summary'] as const) : [])],
    ['model', 'cwd'],
    ['model'],
    [],
  ];
  const wanted = { model: modelWanted, cwd: cwdWanted, summary: summaryWanted };
  for (const set of sets) {
    const assigned = fitClauses(set, wanted, budget, gap);
    if (assigned === null) continue;
    const modelCells = assigned.model ?? 0;
    const cwdCells = assigned.cwd ?? 0;
    const summaryCells = assigned.summary ?? 0;
    let summaryReason: HeaderLeftPlan['summaryReason'] = 'empty';
    if (!input.summaryEnabled) summaryReason = 'disabled';
    else if (input.summary === null) summaryReason = 'empty';
    else if (summaryCells === 0) summaryReason = 'narrow';
    else summaryReason = 'ok';
    return {
      text: {
        model: modelCells > 0 ? fitCells(model, modelCells, input.ellipsis) : '',
        cwd: cwdCells > 0 ? fitCells(input.cwd, cwdCells, input.ellipsis) : '',
        summary: summaryCells > 0 ? fitCells(summaryText, summaryCells, input.ellipsis) : '',
      },
      cells: { model: modelCells, cwd: cwdCells, summary: summaryCells },
      summaryReason,
    };
  }
  return empty;
}

/**
 * Fit one presence set into `budget`, cutting from the LAST clause inward.
 *
 * Returns `null` when the set cannot fit even at every clause's floor, which is the
 * signal to try the next (smaller) set. `null` rather than a partial result because
 * "the summary was dropped" and "the summary does not fit" must be the same fact to
 * the caller, and only the set composition may express it.
 */
function fitClauses(
  set: ReadonlyArray<'model' | 'cwd' | 'summary'>,
  wanted: Record<'model' | 'cwd' | 'summary', { want: number; floor: number }>,
  budget: number,
  gap: number,
): Record<'model' | 'cwd' | 'summary', number> | null {
  const widths: Record<'model' | 'cwd' | 'summary', number> = { model: 0, cwd: 0, summary: 0 };
  let cost = 0;
  for (const key of set) {
    widths[key] = wanted[key].want;
    // EVERY CLAUSE PAYS ITS OWN SEPARATOR, including the first: the row renders
    // `word mark, gap, clause, gap, clause, gap, key`, so a one-clause plan still
    // spends a gap on each side of that clause.
    cost += (key === 'summary' ? HEADER_LEFT_LIMITS.summaryGapCells : gap)
      + wanted[key].want;
  }
  let excess = cost - budget;
  for (let index = set.length - 1; index >= 0 && excess > 0; index -= 1) {
    const key = set[index] as 'model' | 'cwd' | 'summary';
    const room = widths[key] - wanted[key].floor;
    if (room <= 0) continue;
    const cut = Math.min(room, excess);
    widths[key] -= cut;
    excess -= cut;
  }
  return excess > 0 ? null : widths;
}

/**
 * Cells the plan actually spends, for the row invariant:
 * `brand + gap + model + gap + cwd + gap + summary + key <= leftCells`.
 *
 * Exported so `header-left.test.ts` can assert the inequality against the SAME
 * arithmetic the renderer uses instead of re-deriving it in the test (which is how
 * the two drift apart).
 */
export function planHeaderLeftCells(plan: HeaderLeftPlan): number {
  const { gapCells, brandCells, keyCells, summaryGapCells } = HEADER_LEFT_LIMITS;
  // The word mark and the key symbol are always drawn; every clause pays its own gap.
  // The gap before the key is INSIDE `keyCells`, so it is counted once here and never
  // again after a clause - the double count that made a one-clause plan read two cells
  // wider than it renders.
  let cells = brandCells + keyCells;
  if (plan.cells.model > 0) cells += gapCells + plan.cells.model;
  if (plan.cells.cwd > 0) cells += gapCells + plan.cells.cwd;
  // The summary's separator carries the dot, so it is wider than the general gap.
  if (plan.cells.summary > 0) cells += summaryGapCells + plan.cells.summary;
  return cells;
}

/**
 * The fixed cells a plan needs before any clause can appear: the word mark plus the
 * key symbol and its gap.
 *
 * Below this the row does not "spend too much", it simply cannot show a clause - the
 * renderer truncates the overflow and `Header`'s own `wrap="truncate"` keeps that from
 * spilling. Stating it as a constant keeps the invariant in the tests honest:
 * `planHeaderLeftCells(plan) <= max(leftCells, HEADER_LEFT_BASELINE)`.
 */
export const HEADER_LEFT_BASELINE: number = HEADER_LEFT_LIMITS.brandCells
  + HEADER_LEFT_LIMITS.keyCells;
