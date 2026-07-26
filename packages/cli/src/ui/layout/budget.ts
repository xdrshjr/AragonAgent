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
 * Scope: the STATIC chrome only. Two consumers are dynamic and are handled by
 * the degradation ladder in §5.2 instead of being averaged in here:
 *  - `ScrollViewport`'s "N new lines" hint takes the viewport's own last row;
 *  - `AutocompletePopup` expands the bottom chrome by up to 9 rows.
 */

import { frameHeight, MIN_FULLSCREEN_ROWS } from './frame.js';

/** Below this many rows the composer's hint line is dropped to buy back a row. */
export const HINT_MIN_ROWS = 20;

export interface ChromeBudget {
  /** Brand bar. Constant 1 in full-screen — this is what makes A-3 hold. */
  header: number;
  toast: number;
  /** Round border (2) + input row (1), plus the hint row when it fits. */
  composer: number;
  status: number;
}

export function chromeBudget(rows: number): ChromeBudget {
  return {
    header: 1,
    toast: 1,
    composer: rows >= HINT_MIN_ROWS ? 4 : 3,
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
 * Non-decreasing in `rows`: the one step where chrome grows (the hint row at
 * `HINT_MIN_ROWS`) coincides with `rows` growing by one, so the net change is 0
 * rather than -1.
 */
export function viewportRows(rows: number): number {
  if (!Number.isFinite(rows) || rows < MIN_FULLSCREEN_ROWS) return 0;
  const c = chromeBudget(rows);
  return Math.max(0, frameHeight(rows) - c.header - c.toast - c.composer - c.status);
}
