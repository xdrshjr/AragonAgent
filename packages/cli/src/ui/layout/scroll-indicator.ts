/**
 * Scroll-thumb geometry (mouse-wheel-region-routing §4.8) — pure, React-free.
 *
 * Wheel scrolling without a position indicator is a half-finished affordance:
 * the user learns THAT they moved but not HOW FAR or how much is left. The
 * status bar's `↑N` answers neither.
 *
 * OFFSET COUNTS FROM THE BOTTOM, exactly as `scroll.ts` documents — `0` is
 * pinned to the newest output and `overflow` is parked at the very top. The
 * rows hidden ABOVE are therefore `overflow - offset`, and that inversion is
 * precisely what gets done by accident, so it is computed here once and named.
 */

export interface ThumbRange {
  /** 0-based row of the thumb's first row, within the viewport. */
  start: number;
  /** Thumb height in rows; always >= 1 when a range is returned. */
  size: number;
}

/**
 * Where the thumb sits, or `null` when the content fits and there is nothing to
 * indicate.
 *
 * `size` never rounds to zero: a 10-row window over a 5000-row transcript still
 * gets a one-row thumb, because an indicator that vanishes at exactly the
 * moment the transcript is longest is worse than no indicator at all.
 */
export function thumbRange(
  viewportRows: number,
  contentRows: number,
  offsetFromBottom: number,
): ThumbRange | null {
  const viewport = Math.floor(viewportRows);
  const content = Math.floor(contentRows);
  if (!Number.isFinite(viewport) || !Number.isFinite(content)) return null;
  if (viewport <= 0 || content <= viewport) return null;

  const overflow = content - viewport;
  const offset = Math.min(Math.max(Math.floor(offsetFromBottom) || 0, 0), overflow);

  const size = Math.min(viewport, Math.max(1, Math.round((viewport * viewport) / content)));
  const travel = viewport - size;
  const hiddenAbove = overflow - offset;
  const start = travel <= 0 ? 0 : Math.round((hiddenAbove / overflow) * travel);

  return { start: Math.min(Math.max(start, 0), travel), size };
}
