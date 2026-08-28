/**
 * Composer and transcript row ceilings (tui-paste-handling section 5.5 / 5.6).
 *
 * Structural, not policy (D-10): the only user-facing key this feature adds is
 * the boolean `paste`. Everything here is a bound that keeps the frame's row
 * arithmetic true, and every one of them is switchable by returning a larger
 * number rather than by a config flag.
 */

/** At or below BOTH of these a paste is inserted verbatim rather than collapsed. */
export const PASTE_INLINE_MAX_LINES = 6;
export const PASTE_INLINE_MAX_CHARS = 400;

/**
 * Rows one submitted user message may RENDER in the transcript, before the
 * `... +N more lines` tail (G7).
 *
 * `ui/layout/virtual-window.ts` imports this rather than duplicating the number,
 * unlike `DIFF_COLLAPSED_LINES` / `TOOL_LIVE_TAIL_ROWS` beside it: I-13 makes the
 * render cap and the height estimate THE SAME NUMBER, and there is no
 * import-cycle reason here for them to be two.
 */
export const USER_ENTRY_MAX_ROWS = 40;

/**
 * The terminal height at which the composer's hint row starts to fit.
 *
 * DELIBERATELY A SECOND COPY of `ui/layout/budget.ts::HINT_MIN_ROWS` rather than
 * an import: `budget.ts` calls `draftMaxRows` to clamp its composer term, so an
 * import in this direction would close an ESM cycle whose only protection is
 * that neither side reads the other at module scope -- true today, and a
 * confusing TDZ crash the first time someone hoists a use. `budget.test.ts`
 * asserts the two numbers are equal, so they cannot drift in silence.
 */
const DRAFT_TIER_MIN_ROWS = 20;

/**
 * Ceiling on the composer's DRAFT rows at a given terminal height.
 *
 * Non-decreasing in `terminalRows`. Returning `Infinity` reduces the whole
 * height-bound layer to the rung below it (section 12, S4), which is what makes
 * that stage revertible on its own.
 */
export function draftMaxRows(terminalRows: number): number {
  if (!Number.isFinite(terminalRows)) return 3;
  if (terminalRows >= 30) return 10;
  if (terminalRows >= DRAFT_TIER_MIN_ROWS) return 6;
  return 3;
}

/** The terminal height at which `draftMaxRows` steps from 3 to 6. Pinned by test. */
export const DRAFT_MAX_ROWS_HINT_TIER = DRAFT_TIER_MIN_ROWS;
