/**
 * The right-hand hint budget for the header row (tui-branch-terminal-shortcut 3.8).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * WHY THIS IS A PLANNER AND NOT ANOTHER TERNARY IN THE JSX (R-0-4): the header's
 * right side used to be one hand-computed width constant (`detailCells = indexHint
 * ? 32 : 18`). Adding a third affordance to that arithmetic produces either a
 * clipped hint or a pushed-out word mark on a 72-column terminal, and NO TEST
 * WOULD SEE IT - the only thing lost is trailing characters. `ui/layout/session-chip.ts`
 * already set the precedent for the same problem: the chip has to participate in
 * one width budget rather than be appended and hoped for.
 *
 * THE RULE IS ONE COMPARISON. `budget = columns - minLeftCells`, then take the
 * first ladder rung whose `cells` fits. There is no second magic constant, and the
 * threshold table in the spec is what that comparison WORKS OUT TO, not an extra
 * branch.
 *
 * WHY `minLeftCells` IS 24: the word mark is 13 cells and `provider:model` + cwd +
 * the key symbol need at least 11 more to stay readable. It is lower than
 * `status-layout`'s 34 because the top-left half has a brand to lose while the
 * bottom-left half has a phase that must not disappear.
 */

/**
 * Bounds for the hint budget.
 *
 * WHY THEY LIVE IN THIS FILE (R-21, accepted): `CLAUDE.md`'s general rule is that
 * structural bounds live in the subsystem's `limits.ts`, and `ui/layout/` has none
 * - `budget.ts` keeps `HINT_MIN_ROWS` beside its own module for the same reason.
 * This module has exactly one consumer. If `ui/layout/` ever grows a real
 * `limits.ts`, these three constants should move there together; this comment is
 * that future migration's note.
 */
export const HEADER_HINT_LIMITS = {
  /** Cells the LEFT half of the header must keep (`AragonAgent` is 13 of them). */
  minLeftCells: 24,
  /** Fixed spacing between two hint clauses. */
  gapCells: 2,
  /**
   * Blank cells between the header's left half and this hint column (defect 12).
   *
   * A SEPARATE CONSTANT FROM `gapCells`. That one spaces two hint clauses INSIDE
   * the right column (`buildPlan` below); this one separates the session
   * description from that column. One constant carrying two meanings is how a
   * later change to clause spacing silently re-lays-out the whole row.
   */
  separatorCells: 2,
} as const;

export type HeaderHintId = 'branch' | 'index' | 'kit' | 'detail';

export interface HeaderHintClause {
  id: HeaderHintId;
  text: string;
}

export interface HeaderHintPlan {
  /** Clauses left to right (including the overlay's `Details on/off` replacement). */
  clauses: HeaderHintClause[];
  /** The whole right-hand string, scroll chip included with its trailing spacing. */
  text: string;
  /** Total cells of the right column; `Header` uses it to size the left one. */
  cells: number;
  /** Cells taken by the scroll chip (0 when there is none). */
  scrollCells: number;
  /** True while an overlay owns the keyboard: only the detail word remains. */
  detailsOnly: boolean;
}

/** The verbatim clause text (spec 3.8, appendix A). */
const BRANCH_CLAUSE = { collapsed: '^L branch', expanded: '^L new branch' } as const;
const INDEX_CLAUSE = { collapsed: '^I Index', expanded: '^I build index' } as const;
/**
 * THE KIT CLAUSE HAS NO COLLAPSED FORM (agent-model-kits D-11).
 *
 * The requirement says the `ctrl+k` hint appears AFTER `ctrl+G`; the collapsed
 * row is the narrowest budget in the header, and `^K` is a low-frequency action.
 * Spending 13 columns of the everyday row on it would push `provider:model`
 * leftward on every launch for a key pressed twice a session.
 */
const KIT_CLAUSE = { expanded: '^K switch kit' } as const;
const DETAIL_CLAUSE = { collapsed: '^G more', expanded: '^G less' } as const;
/** L3 gives the key name and nothing else: discoverability at the last width. */
const BRANCH_KEY_ONLY = '^L';
/** Overlay wording, kept exactly as `Header.tsx` had it. */
const DETAILS_ON = 'Details on';
const DETAILS_OFF = 'Details off';

/** Above this, the chip stops counting and saturates (`^9999+`), as it always has. */
const SCROLL_CHIP_MAX = 9999;

/**
 * Plan the right-hand hints.
 *
 * The four inputs are exactly the props `Header` already receives - the call site
 * does not change, only the arithmetic behind it (spec 3.11 step 5).
 */
export function planHeaderHints(input: {
  columns: number;
  statusExpanded: boolean;
  overlayOpen: boolean;
  scrolledLines: number;
  /**
   * Whether the `^K switch kit` clause exists at all (default `true`).
   *
   * `App` ALWAYS PASSES TRUE, including for a user with no kits: the whole point
   * of the requirement is discoverability of `ctrl+K`, and an empty library is
   * exactly the state that needs it (the picker's own `No kits yet` row tells
   * them where to create one). `false` exists for tests and for the future
   * switch, and it degrades the six expanded rungs back into today's four.
   */
  kitHint?: boolean;
}): HeaderHintPlan {
  // NORMALISED HERE, NOT TRUSTED (R-14). `Header` defaults to 80, but a test or a
  // future caller may pass anything; `budget.ts::dimension()` already set the rule
  // (non-finite or < 1 falls back, everything else floors) and this follows it.
  const columns = normalizeDimension(input.columns, 80);
  const scrolledLines = Math.max(0, Math.floor(normalizeDimension(input.scrolledLines, 0)));
  const scrollCells = scrollChip(scrolledLines, input.overlayOpen);
  if (input.overlayOpen) {
    // THE OVERLAY OWNS THE KEYBOARD, so every key hint disappears (D-14's sibling
    // rule, unchanged from the old JSX). The scroll chip stays: it is a position
    // indicator, not an affordance.
    const detail = input.statusExpanded ? DETAILS_ON : DETAILS_OFF;
    return buildPlan([{ id: 'detail', text: detail }], scrollCells, true);
  }
  const ladder = ladderFor(input.statusExpanded, input.kitHint !== false);
  // THE SEPARATOR IS SPENT OUT OF THE SAME ROW (defect 12): left half + gap + this
  // column have to add up to `columns`, so the gap comes off the budget instead of
  // being assumed free.
  const budget = columns - HEADER_HINT_LIMITS.minLeftCells
    - HEADER_HINT_LIMITS.separatorCells;
  for (const rung of ladder) {
    const plan = buildPlan(rung, scrollCells, false);
    if (plan.cells <= budget) return plan;
  }
  // L4 IS UNCONDITIONAL: `^G` is the only entry in this table that may never be
  // dropped - it is how a user who hid the status detail fields gets them back.
  // A header narrower than the last rung still renders; the LEFT column is what
  // shrinks (to zero), and `overflow="hidden"` keeps that from overflowing.
  return buildPlan(ladder[ladder.length - 1] ?? [], scrollCells, false);
}

/**
 * The rungs, widest first. Built per call because the widths are text-derived.
 *
 * THE EXPANDED ORDER `branch -> index -> kit -> detail` IS A REGRESSION
 * CONSTRAINT, NOT A PREFERENCE (RV-P1-2). With `kit` AFTER `index`, rungs E2,
 * E4, E5 and E6 are exactly today's four expanded rungs, so every existing
 * width assertion for 48-78 columns keeps its old answer and `^I` never
 * disappears from a row where it used to fit. Putting `^K` first would have cost
 * `^I` everything from 64 to 78 columns - a permanent loss, paid for a
 * low-frequency key.
 */
function ladderFor(statusExpanded: boolean, kitHint: boolean): HeaderHintClause[][] {
  const branch = {
    id: 'branch' as const,
    text: statusExpanded ? BRANCH_CLAUSE.expanded : BRANCH_CLAUSE.collapsed,
  };
  const index = {
    id: 'index' as const,
    text: statusExpanded ? INDEX_CLAUSE.expanded : INDEX_CLAUSE.collapsed,
  };
  const detail = {
    id: 'detail' as const,
    text: statusExpanded ? DETAIL_CLAUSE.expanded : DETAIL_CLAUSE.collapsed,
  };
  const base: HeaderHintClause[][] = [
    [branch, index, detail],
    [branch, detail],
    [{ id: 'branch' as const, text: BRANCH_KEY_ONLY }, detail],
    [detail],
  ];
  // THE COLLAPSED LADDER IS UNTOUCHED (D-11): `^K` has no collapsed form, so a
  // user who never presses `ctrl+G` sees the row they always saw (I-9).
  if (!statusExpanded || !kitHint) return base;
  const kit = { id: 'kit' as const, text: KIT_CLAUSE.expanded };
  return [
    [branch, index, kit, detail],
    [branch, index, detail],
    [branch, kit, detail],
    [branch, detail],
    [{ id: 'branch' as const, text: BRANCH_KEY_ONLY }, detail],
    [detail],
  ];
}

/**
 * Compose the final string. The chip carries its OWN trailing spacing and is the
 * only source of it (R-8): one space while an overlay is open, two otherwise -
 * copied byte for byte from the expression the header already used.
 */
function buildPlan(
  clauses: HeaderHintClause[],
  scrollChipText: string,
  detailsOnly: boolean,
): HeaderHintPlan {
  const body = clauses.map((clause) => clause.text).join(' '.repeat(HEADER_HINT_LIMITS.gapCells));
  const text = scrollChipText.length > 0 ? `${scrollChipText}${body}` : body;
  return {
    clauses,
    text,
    cells: text.length,
    scrollCells: scrollChipText.length,
    detailsOnly,
  };
}

/**
 * `^<n>` plus its trailing spacing, or `''`.
 *
 * THE SPACING IS PART OF THE CHIP, not something `Header` adds afterwards: with two
 * sources of spacing a reviewer has to read two files to answer "how wide is the
 * chip", and the overlay's single-space case lived in the JSX as a ternary nobody
 * would think to check.
 */
function scrollChip(scrolledLines: number, overlayOpen: boolean): string {
  if (scrolledLines <= 0) return '';
  const label = scrolledLines > SCROLL_CHIP_MAX ? `^${SCROLL_CHIP_MAX}+` : `^${scrolledLines}`;
  return label + (overlayOpen ? ' ' : '  ');
}

/** The `budget.ts::dimension()` rule, local because that helper is not exported. */
function normalizeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}
