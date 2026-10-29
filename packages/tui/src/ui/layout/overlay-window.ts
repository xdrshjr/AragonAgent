/**
 * Overlay windowing (spec §4.4) — pure arithmetic for `OverlayFrame`.
 *
 * Overlays used to be dropped into `<Box overflow="hidden">` with no scrolling
 * and no indication that anything had been cut: `/help` needs 29 rows, a 30-row
 * terminal gave it 15, and everything from `/clear` downward was simply invisible.
 *
 * This does NOT reuse `ScrollViewport`. That component owns its offset in its own
 * state as a deliberate single-source-of-truth decision, so routing an overlay
 * through the same instance would leave the transcript parked at the overlay's
 * offset after closing. Overlay content is finite and already in memory, so
 * slicing an array is both cheaper and free of a second `measureElement` loop.
 */

export interface OverlayWindow {
  /** First visible index. */
  start: number;
  /** How many rows are visible. */
  visible: number;
  total: number;
  /** The requested offset after clamping — feed this back to keep state sane. */
  clamped: number;
}

/**
 * Slice `total` single-row items to a `height`-row window at `offset`.
 *
 * Guarantees for every input, including negative / absurd offsets and
 * non-finite heights: `0 <= start` and `start + visible <= total` (A-2).
 */
export function sliceWindow(total: number, offset: number, height: number): OverlayWindow {
  const t = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : t;
  const visible = Math.min(t, h);
  const maxOffset = Math.max(0, t - visible);
  const raw = Number.isFinite(offset) ? Math.floor(offset) : 0;
  const clamped = Math.min(maxOffset, Math.max(0, raw));
  return { start: clamped, visible, total: t, clamped };
}

/** Smallest list window worth showing before scrolling stops helping. */
const MIN_LIST_LIMIT = 3;
/** Beyond this a picker is a scroll problem, not a list problem. */
const MAX_LIST_LIMIT = 20;

/**
 * Visible-row budget for a self-managed (mode B) overlay list — i.e. the `limit`
 * handed to `ink-select-input` in the model picker.
 *
 * A pure function rather than an inline expression because the test stack only
 * returns rendered strings: there is no way to read a child's props back, so the
 * only way to pin this behaviour (A-11) is to test the arithmetic directly.
 *
 * The 5 rows subtracted are the frame's own chrome: title, footer, the top and
 * bottom border, and the frame's `marginTop` — which is spent out of the same
 * budget, so leaving it out pushes the bottom border past the viewport where
 * `overflow: hidden` silently eats it.
 */
export function overlayListLimit(maxRows: number): number {
  if (!Number.isFinite(maxRows)) return MAX_LIST_LIMIT;
  const usable = Math.floor(maxRows) - 5;
  return Math.min(MAX_LIST_LIMIT, Math.max(MIN_LIST_LIMIT, usable));
}
