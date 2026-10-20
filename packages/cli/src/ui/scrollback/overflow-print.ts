/**
 * TOP GIVE-WAY - the row-level print plan of the native-scroll live region
 * (tui-final-reply-truncated-unscrollable, plan A-prime / B3).
 *
 * THE DEFECT THIS ANSWERS. The region is the whole screen (`H = rows - 1`), so the box
 * that holds the conversation is only `previewRows` tall (24 rows on a 30-row terminal),
 * while the boundary that decides what may print into the terminal's scrollback is
 * counted in ENTRIES (`liveTailMaxEntries`). A settled answer taller than the box is
 * therefore inside the window, never printed, and clipped from the top by
 * `justifyContent="flex-end"`. Native mode has no in-frame viewport - the wheel scrolls
 * the terminal's scrollback - so the clipped rows exist nowhere the user can reach.
 *
 * The region cannot simply grow: a frame as tall as the terminal makes Ink write
 * `clearTerminal` (which contains `ESC[3J`) and that erases the user's scrollback. So the
 * only direction that keeps both promises is this one: the box keeps showing what it can,
 * and the rows it hides are PRINTED into the scrollback, where the terminal's own scroll
 * already reaches. Nothing on screen changes; the head of a long answer simply becomes
 * readable one wheel turn up.
 *
 * WHAT THE PLAN GUARANTEES (the invariants the implementation batches are verified by):
 *  I-B1 `printed(e) + visible(e) = rows(e)` and the two ranges are adjacent and disjoint,
 *       so `scrollback + screen` covers every row exactly once (no gap, no duplicate).
 *  I-B2 Only STABLE entries may print, and the FIRST unstable entry is a wall: nothing at
 *       or after it is ever planned, even when a stable entry follows it (a `notice` after
 *       a streaming answer is stable, and printing it here would put rows into the
 *       scrollback out of conversation order, which is unrecoverable).
 *  I-B3 The plan is ordered oldest-first and carries no gaps: the caller prints the
 *       segments in the order given, so the scrollback keeps conversation order.
 *  I-B4 It never plans a row that is still on screen: `hiddenRows` is measured against the
 *       box height, and the box clips from the TOP only while it is bottom-anchored
 *       (`tail-anchor.ts`), which the caller checks before printing anything.
 *
 * PURE: no Ink, no I/O, no clock, no `node:*`. That is why the caller injects the measured
 * heights and the printed counts instead of this module measuring anything itself: the same
 * arithmetic then drives a unit test with an arbitrary table instead of a screen.
 */

import type { Entry } from '../../agent/reducer.js';
import { SCROLLBACK_LIMITS } from './limits.js';

/** One entry of the tail window, as the planner needs it. */
export interface OverflowWindowEntry {
  entry: Entry;
  /**
   * Rows this entry occupies in the live region, measured at the SAME width the region
   * draws it at (`previewCols`). An estimate is not good enough here: the plan decides how
   * many rows are hidden, and a wrong count either duplicates a visible row or leaves one
   * unreachable.
   */
  rows: number;
  /** Leading rows of this entry already in the scrollback, `0` when none. */
  printed: number;
  /**
   * `isEntryStable(entry, runActive, isTail)` for this entry - the caller's answer, because
   * "is this the tail" is a property of the FULL list and the window is a filtered slice.
   */
  stable: boolean;
}

/** One run of rows to print: `[fromRow, toRow)` of `entry`'s own rows. */
export interface OverflowSegment {
  /** Index into the window the planner was given. */
  index: number;
  id: string;
  /** First row to print, 0-based from the top of the entry. */
  fromRow: number;
  /** One past the last row to print. */
  toRow: number;
}

export interface OverflowPlan {
  /** Rows to hand to the writer, oldest entry first (I-B3). */
  segments: readonly OverflowSegment[];
  /** Rows the box hides above its top edge; `0` when the window fits. */
  hiddenRows: number;
  /** Measured height of the whole window, including entries past the wall. */
  totalRows: number;
}

function wholeRows(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Which rows of the window the box is hiding, and how many of them are not printed yet.
 *
 * @param window The tail window, OLDEST FIRST, excluded entries already dropped.
 * @param budgetRows Height of the box that shows the window (`band.previewRows`).
 * @returns The print plan; `segments` is empty when nothing is hidden or when the first
 * unstable entry sits at the top of the window (see I-B2).
 */
export function planOverflowPrint(
  window: readonly OverflowWindowEntry[],
  budgetRows: number,
): OverflowPlan {
  const totalRows = window.reduce((sum, item) => sum + wholeRows(item.rows), 0);
  // Rows past the wall are on screen too (the box is one box), so they count towards the
  // height - they are simply never printable themselves.
  const hiddenRows = Math.max(0, totalRows - wholeRows(budgetRows));
  if (hiddenRows === 0) return { segments: [], hiddenRows, totalRows };

  const segments: OverflowSegment[] = [];
  let offset = 0;
  for (const [index, item] of window.entries()) {
    // I-B2 - the wall. Nothing at or after the first unstable entry may print, and because
    // the loop walks in order, "at or after" needs nothing more than a `break`.
    if (!item.stable) break;
    // Every row from here down is visible: the box clips exactly `hiddenRows` rows off the
    // top, so once the accumulated offset reaches it the plan is complete.
    if (offset >= hiddenRows) break;
    const hiddenOfEntry = Math.min(wholeRows(item.rows), hiddenRows - offset);
    const printed = wholeRows(item.printed);
    if (hiddenOfEntry > printed) {
      segments.push({ index, id: item.entry.id, fromRow: printed, toRow: hiddenOfEntry });
    }
    offset += wholeRows(item.rows);
  }
  return { segments, hiddenRows, totalRows };
}

/**
 * The row that marks a WIDTH CHANGE inside one entry's printed history.
 *
 * "Rows already printed" is a width-relative quantity: a line that took two rows at 80
 * columns takes one at 120. Continuing to slice at the old index would skip content
 * (`W1` breaks) or repeat it silently. So a width change prints this seam and restarts the
 * entry at the new width: every row stays reachable, and the only cost is one bounded
 * repetition of the rows above the seam (documented in the README).
 */
export function reflowSeamRow(printedRows: number, printedCols: number, cols: number): string {
  return `[-- reflowed to ${cols} columns; ${printedRows} row(s) above were printed at ` +
    `${printedCols} columns --]`;
}

/** The single wording of the per-entry row cap, shared by the renderer and the pipeline. */
export function elisionRow(hidden: number): string {
  return `[+${hidden} rows not printed - scrollback entry cap]`;
}

/**
 * Apply `maxRowsPerEntry` to the REMAINDER of one entry.
 *
 * The cap used to be a single "keep the first 399 rows, then say how many were dropped".
 * That is still what a never-printed entry gets (`headRows === 0`), because it keeps the
 * part of the answer the user has already scrolled past. An entry whose HEAD is already in
 * the scrollback gets the opposite treatment on purpose: the notice goes FIRST and the LAST
 * rows follow, because the tail is the part the reader is looking at on screen, and eliding
 * it would delete the answer they just finished reading from their history.
 *
 * @param tail Rows still to print (`body.slice(fromRow)`).
 * @param headRows Rows of this entry already printed.
 */
export function capPrintedRows(tail: readonly string[], headRows: number): readonly string[] {
  const cap = SCROLLBACK_LIMITS.maxRowsPerEntry;
  const printed = wholeRows(headRows);
  if (printed + tail.length <= cap) return tail;
  if (printed === 0) {
    const keep = Math.max(0, cap - 1);
    return [...tail.slice(0, keep), elisionRow(tail.length - keep)];
  }
  // One row is spent on the notice itself.
  const keep = Math.max(0, cap - printed - 1);
  if (keep === 0) return [elisionRow(tail.length)];
  return [elisionRow(tail.length - keep), ...tail.slice(tail.length - keep)];
}
