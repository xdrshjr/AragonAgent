/**
 * Where the live tail sits inside the band's preview box
 * (tui-first-reply-bottom-aligned, plan A-prime).
 *
 * THE DEFECT THIS ANSWERS. The box is always the whole pool (`band.previewRows`, 24 rows
 * on a 30-row terminal) while a first turn is four rows tall. A constant
 * `justifyContent="flex-end"` therefore pushed those four rows against the composer and
 * left every unused row ABOVE the conversation - the "the first reply starts at the
 * bottom of the screen" report. The answer is conditional anchoring: top while the
 * content fits, so the conversation is written downwards from under the header.
 *
 * WHY THE FALLBACK IS `bottom` AND NOT THE OTHER WAY ROUND. `flex-start` inside an
 * `overflow="hidden"` box clips the NEWEST rows (Ink's clip rectangle is the box's
 * `[top, top + height]`), and a streaming entry is never printable
 * (`settled-boundary.ts` holds it unstable, and "printed is forever"). Overflowing to
 * `flex-start` would hide the text the user is waiting for; overflowing to `flex-end`
 * hides the oldest rows, which the tail window prints on its way out.
 *
 * THE THRESHOLD CARRIES A MARGIN. `rowOf` is an ESTIMATE, and the one available
 * (`layout/virtual-window.ts::estimateEntryRows`) under-counts a `#` heading and a code
 * block. The margin in `SCROLLBACK_LIMITS.tailAnchorSlackRows` absorbs that error on the
 * `bottom` side, the only direction that cannot clip something new.
 *
 * PURE: no Ink, no I/O, no clock, and deliberately no import of `virtual-window.ts` (its
 * import graph reaches a `.tsx` gutter). The row height is injected, so this stays three
 * parameters and a unit test can drive it with any table it likes.
 */

import type { Entry } from '../../agent/reducer.js';
import { SCROLLBACK_LIMITS } from './limits.js';

/** `top` = content grows down from the header; `bottom` = newest row hugs the composer. */
export type TailAnchor = 'top' | 'bottom';

/**
 * Which alignment the live tail should use for the entries it is about to render.
 *
 * @param entries The entries THIS FRAME renders (already windowed by `selectTailEntries`;
 * summing the whole conversation would make every session past the entry cap overflow and
 * anchor to the bottom forever).
 * @param budgetRows Height of the box that will clip them, in rows.
 * @param rowOf Estimated height of one entry, including its separation row.
 * @returns `top` when the estimates plus `tailAnchorSlackRows` fit in `budgetRows`,
 * `bottom` otherwise (and for the first entry that does not fit, so the loop stops early).
 */
export function tailAnchor(
  entries: readonly Entry[],
  budgetRows: number,
  rowOf: (entry: Entry) => number,
): TailAnchor {
  const budget = Number.isFinite(budgetRows) ? Math.max(0, Math.floor(budgetRows)) : 0;
  let rows = 0;
  for (const entry of entries) {
    rows += Math.max(0, rowOf(entry));
    if (rows + SCROLLBACK_LIMITS.tailAnchorSlackRows > budget) return 'bottom';
  }
  return 'top';
}

/**
 * The anchor this frame really uses: MEASURED when the measurement exists, estimated
 * otherwise.
 *
 * WHY A MEASURED ANSWER WINS (tui-final-reply-truncated-unscrollable). The estimate is an
 * upper bound that charges a separation row this renderer may not draw, so it can claim the
 * content overflows while it actually fits (the block sits at the bottom of a half-empty
 * box - the very complaint `tui-first-reply-bottom-aligned` answered) and it under-counts a
 * heading or a wrapped code block, so it can claim the content fits while the box is really
 * clipping. The second error is the expensive one now: "top give-way" only prints while the
 * box is bottom-anchored (that is the branch that clips the TOP), so a wrongly top-anchored
 * box would clip the newest rows and print the oldest ones - the wrong half, twice.
 *
 * A measured total is available only when every window entry is stable AND already measured
 * at the current geometry (`use-scrollback-view.ts` keeps that cache), which is exactly the
 * frame on which a print decision is being made. Every other frame - streaming, resize,
 * first sight of a new entry - falls back to the estimate, unchanged.
 *
 * @param measuredRows Measured height of the same entries, or `undefined` when unknown.
 */
export function resolveTailAnchor(input: {
  entries: readonly Entry[];
  budgetRows: number;
  rowOf: (entry: Entry) => number;
  measuredRows: number | undefined;
}): TailAnchor {
  const { entries, budgetRows, rowOf, measuredRows } = input;
  if (measuredRows === undefined || !Number.isFinite(measuredRows)) {
    return tailAnchor(entries, budgetRows, rowOf);
  }
  const budget = Number.isFinite(budgetRows) ? Math.max(0, Math.floor(budgetRows)) : 0;
  return measuredRows > budget ? 'bottom' : 'top';
}
