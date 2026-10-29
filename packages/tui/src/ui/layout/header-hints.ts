/**
 * The right-hand hint budget for the header row
 * (tui-shortcut-drawer-and-task-summary §4.2).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * THIS FILE USED TO BE A SIX-RUNG LADDER. `^L branch`, `^P prompts`, `^I Index`,
 * `^K switch kit`, `^G more` and the expanded variants competed for a width
 * budget, so what a user saw was not "my shortcuts" but "which clauses happen to
 * fit at this width" - and on an 80-column terminal that was three of six. The
 * requirement replaces the whole idea with ONE entry point (`ctrl+G more`) whose
 * panel lists every shortcut, so the ladder is gone and what remains is a
 * three-state single clause.
 *
 * WHY A PLANNER AND NOT A TERNARY IN THE JSX (R-0-4, unchanged): the header's
 * right side was once one hand-computed width constant, and every later addition
 * to it produced either a clipped hint or a pushed-out word mark with no test
 * able to see it - the only thing lost is trailing characters.
 */

/**
 * Bounds for the hint budget.
 *
 * WHY THEY LIVE IN THIS FILE (R-21, accepted): `CLAUDE.md`'s general rule is that
 * structural bounds live in the subsystem's `limits.ts`, and `ui/layout/` has none
 * - `budget.ts` keeps `HINT_MIN_ROWS` beside its own module for the same reason.
 */
export const HEADER_HINT_LIMITS = {
  /**
   * Cells the LEFT half of the header must keep.
   *
   * 24 = the 13-cell word mark plus at least 11 for `provider:model`, the
   * directory and the key symbol. Lower than `status-layout`'s 34 because the top
   * row has a brand to lose while the bottom row has a phase that must not
   * disappear.
   */
  minLeftCells: 24,
  /**
   * Blank cells between the header's left half and this hint column (defect 12).
   *
   * A SEPARATE CONCEPT FROM CLAUSE SPACING: this one separates the two HALVES of
   * the row, and it is spent out of the same `columns` budget so the row still
   * spans exactly the terminal width.
   */
  separatorCells: 2,
} as const;

/**
 * What the right-hand column says. THREE STATES, NO LADDER.
 *
 * `none`      - no overlay: `^G more`, the only shortcut hint the header teaches.
 * `shortcuts` - this panel is open: `^G close`, the key that closes it.
 * `other`     - some other overlay owns the keyboard: `Esc close`, which is true
 *               for every overlay and is the only key that works in all of them.
 */
export type HeaderPanelState = 'none' | 'shortcuts' | 'other';

export interface HeaderHintPlan {
  /** The whole right-hand string, scroll chip included with its trailing spacing. */
  text: string;
  /** Total cells of the right column; `Header` sizes the left one from it. */
  cells: number;
  /** Cells taken by the scroll chip (0 when there is none). */
  scrollCells: number;
}

/** The verbatim text of each state. Exported so a test can name it instead of guessing. */
export const HEADER_HINTS: Readonly<Record<HeaderPanelState, string>> = {
  none: '^G more',
  shortcuts: '^G close',
  other: 'Esc close',
} as const;

/** Above this, the chip stops counting and saturates (`^9999+`), as it always has. */
const SCROLL_CHIP_MAX = 9999;

/**
 * Plan the right-hand hint.
 *
 * NO WIDTH BRANCHING: the clause is always rendered. When the row cannot hold it
 * the LEFT half is what shrinks (to zero) and `overflow="hidden"` keeps that from
 * spilling - the pre-feature behaviour, which is what makes the header safe at 20
 * columns without a ladder. `headerHintFits` below exists only so the threshold
 * is documented and testable, not so the renderer can branch on it.
 */
export function planHeaderHints(input: {
  columns: number;
  panel: HeaderPanelState;
  scrolledLines: number;
}): HeaderHintPlan {
  const columns = normalizeDimension(input.columns, 80);
  const scrolledLines = Math.max(0, Math.floor(normalizeDimension(input.scrolledLines, 0)));
  const overlayOpen = input.panel !== 'none';
  const chip = scrollChip(scrolledLines, overlayOpen);
  const body = HEADER_HINTS[input.panel] ?? HEADER_HINTS.none;
  const text = chip.length > 0 ? `${chip}${body}` : body;
  return { text, cells: text.length, scrollCells: chip.length };
}

/**
 * Whether the row can hold the hint column without squeezing the left half below
 * `minLeftCells`.
 *
 * A FORMULA, NOT A TABLE OF MAGIC NUMBERS: `columns - minLeftCells -
 * separatorCells >= scrollCells + bodyCells`. Substituting the three states gives
 * 32 / 34 / 35 columns with no chip, plus up to 8 more for a saturated `^9999+ `.
 * v1 claimed "any width >= 35", which forgot the chip entirely.
 */
export function headerHintFits(columns: number, panel: HeaderPanelState): boolean {
  const cols = normalizeDimension(columns, 80);
  const plan = planHeaderHints({ columns: cols, panel, scrolledLines: 0 });
  return cols - HEADER_HINT_LIMITS.minLeftCells - HEADER_HINT_LIMITS.separatorCells
    >= plan.cells;
}

/** The narrowest width at which each state fits with no scroll chip. */
export function headerHintThreshold(panel: HeaderPanelState): number {
  return HEADER_HINTS[panel].length
    + HEADER_HINT_LIMITS.minLeftCells
    + HEADER_HINT_LIMITS.separatorCells;
}

/**
 * `^<n>` plus its trailing spacing, or `''`.
 *
 * THE SPACING IS PART OF THE CHIP, not something `Header` adds afterwards: with two
 * sources of spacing a reviewer has to read two files to answer "how wide is the
 * chip". One space while an overlay is open, two otherwise - copied byte for byte
 * from the expression the header already used.
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
