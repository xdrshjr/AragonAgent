/**
 * Pure pieces of the wait card (extended-job-wait §3.8.2).
 *
 * ASCII ONLY: `src/ui/**` is inside the glyph scanner's scope, so every
 * non-ASCII cell arrives as an argument from `pickGlyphs`.
 */

import { shortDuration } from './status-layout.js';

/**
 * Rows the wait card occupies, header included, in every state (I-10).
 * Here rather than beside the component so `virtual-window.ts` can import it
 * without pulling React into a pure layout module.
 */
export const WAIT_CARD_ROWS = 5;

/** The two glyphs a bar is made of; a subset of the `pickGlyphs` result. */
export interface BarGlyphs {
  gaugeFull: string;
  gaugeEmpty: string;
}

/** Narrowest terminal that still gets a bar; below it the row is text only. */
export const WAIT_BAR_MIN_COLS = 40;

/** Bar width for a terminal `cols` wide: about a third of the row, 8..28 cells. */
export function barCellsFor(cols: number): number {
  if (!Number.isFinite(cols)) return 8;
  return Math.max(8, Math.min(28, Math.floor((cols - 4) * 0.35)));
}

/**
 * A `cells`-wide bar for `fraction` in 0..1.
 *
 * AN UNFINISHED BAR IS NEVER FULL (I-8): anything strictly between 0 and 1 shows
 * at least one filled and at least one empty cell, so a 99.9% job does not read
 * as done. `NaN`, negatives and non-finite values are an empty bar rather than a
 * throw - this runs inside a render.
 */
export function renderBar(fraction: number, cells: number, glyphs: BarGlyphs): string {
  const width = Math.max(1, Math.floor(cells));
  if (!Number.isFinite(fraction) || fraction <= 0) return glyphs.gaugeEmpty.repeat(width);
  if (fraction >= 1) return glyphs.gaugeFull.repeat(width);
  const filled = Math.min(width - 1, Math.max(1, Math.round(fraction * width)));
  return glyphs.gaugeFull.repeat(filled) + glyphs.gaugeEmpty.repeat(width - filled);
}

/** `4m12s`, `10m00s`, `45s` - the one clock format of the card and the status bar. */
export function formatWaitClock(ms: number): string {
  return shortDuration(ms);
}

/** Whole percent for a 0..1 fraction, clamped. */
export function percentOf(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(100, Math.floor(fraction * 100)));
}
