/** Fullscreen reserves three fixed rows; composer height is a footer layout input. */

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

/** Shared document height; the legacy draft argument remains source-compatible. */
export function viewportRows(rows: number, _draftRows = 1): number {
  if (!Number.isFinite(rows) || rows < MIN_FULLSCREEN_ROWS) return 0;
  return Math.max(0, frameHeight(rows) - 3);
}
