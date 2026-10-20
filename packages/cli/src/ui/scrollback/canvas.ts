/**
 * Canvas arithmetic for native-scroll mode (tui-canvas-bottom-anchor §5.3).
 *
 * The defect this exists for: the bottom anchor of
 * `tui-bottom-anchored-live-region` pinned the live region to the last two rows by
 * prepending `pad` blank rows to the region's own block, so the blank space of a
 * conversation that does not fill the screen sat BETWEEN the newest printed row and
 * the composer. The user sees a reply that is not attached to the input box.
 *
 * The fix is a position change, not a value change: every row above the parked row
 * becomes a CANVAS the writer owns, laid out top-down as `[gap][content][region]`.
 * The blank space therefore lives ABOVE every visible content row, and the newest
 * content row always touches the top row of the live region. The steady state is
 * unchanged: `gap` equals the old `pad` row for row (the screen holds the same
 * number of content rows either way).
 *
 * EVERYTHING HERE IS PURE: no I/O, no terminal, no clock, no `node:*` import. The
 * writer's state machine decides which measurement is authoritative; this module
 * only does the arithmetic, so the arithmetic can be property-tested over every
 * combination instead of being sampled through a screen.
 */

/**
 * How far the canvas may reach and how tall it may be, as far as anything measured.
 *
 * `pinned` carries BOTH numbers because they are not independent: the writer parks
 * the cursor on the last row, so `top + capacity === rows - 1` at all times
 * (invariant LB-3). Storing one and deriving the other is what makes an off-by-one
 * invisible until a blank row lands in the scrollback.
 */
export type CanvasAnchor =
  | { kind: 'unknown' }
  | { kind: 'pinned'; top: number; capacity: number };

/** Nothing measured yet: the pre-canvas append path, byte for byte (I-A3 / I-A8). */
export const UNKNOWN_CANVAS: CanvasAnchor = { kind: 'unknown' };

/** Where a `pinned` anchor came from; `/perf` reports it so a fallback is visible. */
export type AnchorSource = 'probe' | 'fill' | 'none';

export interface CanvasLayoutInput {
  /** Rows the canvas may occupy, as measured (`rows - top`). */
  capacity: number;
  /** Canvas top row (0-based). */
  top: number;
  /** Content rows already on screen. */
  heldRows: number;
  /** Content rows arriving in this batch. */
  statRows: number;
  /** Height of the live region in this batch. */
  frameRows: number;
  /** 1 when the batch is a re-seed and starts with its own CRLF, else 0. */
  lead: number;
}

/** The whole geometry of one batch, as pure numbers (never strings). */
export interface CanvasLayout {
  /** Content rows the canvas holds after this batch, i.e. after the trim. */
  heldRows: number;
  /** Blank rows above the content. Skipped with CUD, never written (I-B3). */
  gap: number;
  /** Rows this batch writes past the screen bottom; the terminal scrolls them away. */
  scroll: number;
  /** Content rows dropped from the head because they left the screen for good. */
  dropped: number;
  /** The canvas top after this batch. */
  top: number;
  /** The canvas height after this batch, which is the next erase distance. */
  canvasRows: number;
}

/**
 * `Math.floor` with the two answers a measurement must never produce collapsed onto
 * `fallback`: `NaN` and `Infinity`. A `NaN` row count would make `Array(n)` throw and
 * would turn `rows - 1 - n` into a lie, so a broken number degrades to "nothing".
 */
function whole(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

/** The capacity above the parked row: `rows - 1`. Degrades to 0, never negative. */
export function screenCapacity(rows: number | undefined): number {
  if (rows === undefined || !Number.isFinite(rows)) return 0;
  return Math.max(0, Math.floor(rows) - 1);
}

/**
 * Clamp a measured "rows below the cursor" figure into `[0, rows - 1]`.
 *
 * `rows` unknown is treated as `0`: the caller is then exactly at the bottom, which
 * is the conservative branch (no canvas to open up).
 */
export function clampSpaceBelow(spaceBelow: number, rows: number | undefined): number {
  const upper = screenCapacity(rows);
  const value = Number.isFinite(spaceBelow) ? Math.floor(spaceBelow) : 0;
  return Math.min(upper, Math.max(0, value));
}

/**
 * A terminal that grew adds rows BELOW the cursor, so the capacity grows by the
 * exact difference (D6). Shrinking is NOT handled here: it re-measures instead of
 * guessing (D5), so a smaller value would only hide a lost measurement.
 */
export function applyResizeGrowth(capacity: number, rowsPrev: number, rowsNow: number): number {
  // No capacity to grow: a broken number must not become a canvas by arithmetic.
  if (!Number.isFinite(capacity)) return 0;
  const base = Math.max(0, Math.floor(capacity));
  const delta = Number.isFinite(rowsNow) && Number.isFinite(rowsPrev) ? rowsNow - rowsPrev : 0;
  return base + Math.max(0, Math.floor(delta));
}

/**
 * The layout of one batch.
 *
 * `heldRows` / `statRows` / `frameRows` are COUNTS, never strings, so this function
 * can be property-tested over every combination without building a screen.
 *
 * TWO BRANCHES, and the difference is physical rather than cosmetic:
 *  - FIT: the content plus the region fits the capacity, so the leftover becomes the
 *    `gap` at the TOP of the canvas and nothing scrolls.
 *  - SCROLL: the canvas cannot hold everything. The batch writes every content row
 *    (the caller passes them untrimmed for exactly this reason), the terminal scrolls
 *    `scroll` rows away, and the rows that leave are the oldest content rows plus the
 *    host output above the canvas. `dropped` is how many content rows left.
 */
export function resolveCanvasLayout(input: CanvasLayoutInput): CanvasLayout {
  // A re-seed writes its own leading CRLF, which eats one row of the space below the
  // cursor and starts the canvas one row lower (P1-1 in the canvas model).
  const lead = Math.max(0, whole(input.lead, 0));
  const capacity = Math.max(0, whole(input.capacity, 0) - lead);
  const held = Math.max(0, whole(input.heldRows, 0));
  const stat = Math.max(0, whole(input.statRows, 0));
  const frame = Math.max(0, whole(input.frameRows, 0));
  const top = Math.max(0, whole(input.top, 0)) + lead;
  const content = held + stat;
  const need = content + frame;

  if (need <= capacity) {
    return {
      heldRows: content,
      gap: capacity - need,
      scroll: 0,
      dropped: 0,
      top,
      canvasRows: capacity,
    };
  }

  const scroll = need - capacity;
  // Rows above the canvas are the host's old output: they leave the screen first.
  const hostUsed = Math.min(scroll, top);
  const grown = capacity + hostUsed;
  const dropped = Math.min(scroll - hostUsed, content);
  const keptContent = content - dropped;
  return {
    heldRows: keptContent,
    // Zero whenever anything scrolled, and that is what keeps blank rows out of the
    // scrollback: a skipped gap is un-written cells, a scrolled one is a written row.
    gap: Math.max(0, grown - keptContent - frame),
    scroll,
    dropped,
    top: top - hostUsed,
    canvasRows: grown,
  };
}
