/**
 * Rail geometry (todo-plan-execution §3.9) — the ONE place that says how wide
 * and how tall the todo rail is allowed to be.
 *
 * Pure and React-free, mirroring `budget.ts`, so `todo-rail.test.ts` can pin the
 * arithmetic without mounting anything. Deliberately NOT part of `budget.ts`:
 * that module answers "how many ROWS does the viewport get" and stays a function
 * of `rows` alone; the rail spends COLUMNS.
 *
 * NAMED FOR ITS POSITION, NOT ITS CONTENT, like `AppShellProps.rail` (D-18):
 * this is a layout primitive and `viewportRows` is its neighbour, not
 * `TodoPanel`.
 */

import { TODO_LIMITS } from '../../todo/limits.js';

/** R-e, literally: the rail asks for a fifth of the terminal. */
const RAIL_FRACTION = 0.2;

/** Below this the marker + a two-word title do not fit and the column is noise. */
export const TODO_RAIL_MIN_COLS = 18;

/**
 * Above this, 20% is being spent on whitespace: at 36 columns a step title
 * already fits on one line, and the transcript is the surface that benefits from
 * a 200-column terminal. A deliberate, revertible deviation from a literal
 * reading of R-e; it only binds above 180 columns.
 */
export const TODO_RAIL_MAX_COLS = 36;

/** Under 80 columns the transcript needs every column; no rail at all. */
export const TODO_RAIL_MIN_TOTAL_COLS = 80;

/** Below this rail width the 2-column index prefix is dropped for content. */
export const TODO_RAIL_INDEX_MIN_COLS = 22;

/**
 * Two properties are pinned by tests, for the reason `budget.ts` records about
 * the viewport being non-monotonic before anyone measured it:
 *
 *  - NON-DECREASING in `cols` across [40, 300]. A user dragging a window wider
 *    must never see the rail get narrower.
 *  - `cols - todoRailWidth(cols) >= 62` for every `cols >= 80`. Every existing
 *    width heuristic inside the viewport (`TERSE_HINT_COLS` 42,
 *    `MIN_INDICATOR_COLS` 50, the status bar's 60/72 steps) sits below that
 *    floor, so no existing behaviour changes because a rail appeared (R-3).
 */
export function todoRailWidth(cols: number): number {
  if (!Number.isFinite(cols) || cols < TODO_RAIL_MIN_TOTAL_COLS) return 0;
  return Math.min(
    TODO_RAIL_MAX_COLS,
    Math.max(TODO_RAIL_MIN_COLS, Math.round(cols * RAIL_FRACTION)),
  );
}

/**
 * How many rows the rail may actually draw.
 *
 * IT IS NOT `viewportBudget`, AND THE DIFFERENCE IS NOT COSMETIC (P1-3 / D-23).
 * `viewportRows()` subtracts the STATIC chrome only, and says so; the live team
 * roster is mounted inside `AppShell`'s measured bottom box, where it costs a
 * header row, up to `TEAM_LIMITS.panelMaxRows` child rows, a `+N more` row and a
 * mail row that `viewportBudget` knows nothing about. `ScrollViewport` is immune
 * because it MEASURES itself; the rail does not measure - a second
 * measure -> setState -> measure loop is exactly what §1.2 refuses - so it has
 * to subtract.
 *
 * Ink clips overflow from the BOTTOM, so an over-request does not error: it
 * silently eats the last row, which is the `+N below` marker - the one row whose
 * absence is indistinguishable from "the list is short". That is why this is
 * arithmetic rather than a shrug at `overflow: hidden`.
 */
export function todoRailRows(viewportBudget: number, teamActive: boolean): number {
  if (!Number.isFinite(viewportBudget)) return 0;
  const reserved = teamActive ? TODO_LIMITS.railReservedRows : 0;
  return Math.max(0, viewportBudget - reserved);
}
