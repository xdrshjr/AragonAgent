/**
 * Layout budget (spec §4.2a) — the ONE function that says how many rows the
 * viewport gets.
 *
 * Before v0.4.0 this number was computed nowhere and assumed in three places,
 * which is how the viewport ended up NON-MONOTONIC in `rows`: growing the
 * terminal from 27 to 28 rows promoted the header to the 8-row wordmark tier and
 * the visible content SHRANK from 18 rows to 13. Making the brand region a
 * constant 1 row (§4.2) is what fixes that, and this module is where the fix is
 * expressed as arithmetic so `budget.test.ts` can pin it.
 *
 * Deliberately NOT part of `frame.ts`: that file is the read-only foundation
 * (invariant I-1) and this is content-layer policy.
 *
 * Scope: the STATIC chrome only. One consumer is dynamic and is handled by the
 * degradation ladder in §5.2 instead of being averaged in here:
 *  - `AutocompletePopup` expands the bottom chrome by up to 9 rows.
 *
 * `ScrollViewport`'s "N new lines" hint used to be listed here as a second
 * dynamic consumer. It no longer exists: the number renders as a chip on the
 * composer's input row (tui-selection-and-scroll-follow §4.2), which costs
 * COLUMNS rather than rows. The arithmetic below is unchanged — the hint was
 * never in the budget in the first place — but leaving the bullet in place would
 * make this comment a true-sounding statement about a row that is gone (AC-12,
 * and the `wheel-scrolls-transcript-only` RV-3 lesson).
 */

import { draftMaxRows } from '../composer-limits.js';
import { frameHeight, MIN_FULLSCREEN_ROWS } from './frame.js';

/** Below this many rows the composer's hint line is dropped to buy back a row. */
export const HINT_MIN_ROWS = 20;

export interface ChromeBudget {
  /** Brand bar. Constant 1 in full-screen — this is what makes A-3 hold. */
  header: number;
  toast: number;
  /**
   * Round border (2) + the DRAFT's own rows, plus the hint row when it fits.
   *
   * The draft term used to be the constant 1 that the `3` / `4` below encode.
   * That constant is what made a pasted 200-line draft draw the transcript 197
   * rows shorter than every consumer of `viewportRows` believed -- the trap
   * `BottomStatusRow.tsx:5-27` already documents at 1/200th the magnitude.
   */
  composer: number;
  status: number;
}

/**
 * The composer's draft rows, clamped to what this terminal height allows.
 *
 * Exported so the reporter and the budget clamp with ONE function: I-8 requires
 * the rendered row count and the number handed to `viewportRows` to be the same
 * number, and two clamps are how they stop being.
 */
export function clampDraftRows(rows: number, draftRows: number): number {
  const wanted = Number.isFinite(draftRows) ? Math.floor(draftRows) : 1;
  return Math.max(1, Math.min(wanted, draftMaxRows(rows)));
}

export function chromeBudget(rows: number, draftRows = 1): ChromeBudget {
  return {
    header: 1,
    toast: 1,
    composer: 2 + clampDraftRows(rows, draftRows) + (rows >= HINT_MIN_ROWS ? 1 : 0),
    status: 1,
  };
}

/**
 * Rows available to the viewport at a given terminal height.
 *
 * Note what is NOT a parameter: whether the transcript is empty. The absence of
 * that argument is the guarantee that the first submitted message cannot make
 * the layout jump (A-4). Do not add it back.
 *
 * `draftRows` IS NOT THAT ARGUMENT, and the distinction is the whole of D-12.
 * A-4 forbids making the budget depend on TRANSCRIPT content, so that the first
 * submitted message cannot move the layout. `draftRows` depends only on what the
 * user is typing right now, and its whole purpose is that the jump is ALREADY
 * HAPPENING -- Yoga takes the rows out of the transcript whether or not this
 * function was told. `App` adds the hysteresis (grow now, shrink one tick later)
 * that keeps it from becoming per-keystroke jitter.
 *
 * It DEFAULTS TO 1, i.e. to the constant this function used to assume, so every
 * pre-existing caller and every pre-existing assertion is byte-identical -- and
 * `viewportRows.length` stays 1, because a parameter with a default does not
 * count toward it.
 *
 * Non-decreasing in `rows` at a fixed `draftRows = 1`: the one step where chrome
 * grows (the hint row at `HINT_MIN_ROWS`) coincides with `rows` growing by one,
 * so the net change is 0 rather than -1.
 */
export function viewportRows(rows: number, draftRows = 1): number {
  if (!Number.isFinite(rows) || rows < MIN_FULLSCREEN_ROWS) return 0;
  const c = chromeBudget(rows, draftRows);
  return Math.max(0, frameHeight(rows) - c.header - c.toast - c.composer - c.status);
}
