/**
 * Context gauge builder (spec §3.4). Pure: turns a percentage into a block bar
 * plus a threshold-based fill colour, with an ASCII fallback when the terminal
 * has no Unicode. Kept out of the `.tsx` so it is unit-testable without Ink.
 */

import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';

export interface Gauge {
  /** The filled portion of the bar. */
  filled: string;
  /** The empty (track) portion of the bar. */
  empty: string;
  /** Fill colour chosen by threshold (`theme.gauge.*`). */
  fillColor: string | undefined;
  /** Track colour (`theme.gauge.track`). */
  trackColor: string | undefined;
  /** Clamped percentage 0–100. */
  pct: number;
}

/**
 * Where the bar changes colour, as percentages.
 *
 * The defaults are the values this function hardcoded before context compaction
 * existed, so every existing call site and test is byte-identical (§6.2).
 */
export interface GaugeMarks {
  /** Amber at or above this. */
  warn: number;
  /** Red strictly above this. */
  high: number;
}

const DEFAULT_MARKS: GaugeMarks = { warn: 60, high: 85 };

/**
 * Pick the fill colour by threshold: `< warn` low · `>= warn` mid · `> high` high.
 *
 * THE TWO OPERATORS ARE PRESERVED EXACTLY (`> high`, `>= warn`), and that is not
 * cosmetic: changing either would move the default 85 or 60 boundary and break
 * the byte-identity claim that makes the `marks` parameter a free change.
 *
 * WHAT RED MEANS, PRECISELY (P2-4). The compaction trigger is
 * `ratio >= threshold` (INCLUSIVE) while this fill is `pct > high` (EXCLUSIVE),
 * so with `high = threshold` any occupancy that would render red has ALREADY
 * triggered compaction, and the gauge repaints downward in the same frame. The
 * red band is therefore only ever OBSERVABLE when compaction did not or could
 * not run — the feature is off, it self-disabled, or the failure ladder ended at
 * its last rung. That is a genuinely more useful meaning than "imminent", and it
 * is the one the README and the settings screen state.
 */
function thresholdColor(pct: number, theme: Theme, marks: GaugeMarks): string | undefined {
  if (pct > marks.high) return theme.gauge.high;
  if (pct >= marks.warn) return theme.gauge.mid;
  return theme.gauge.low;
}

/**
 * Build a `width`-cell gauge for `pct` (0–100). Uses block glyphs on Unicode
 * terminals and `#`/`-` otherwise (e.g. `[######----]`).
 *
 * `marks` is OPTIONAL and defaults to today's values, so omitting it produces
 * byte-identical output to the pre-compaction build.
 */
export function buildGauge(
  pct: number,
  width: number,
  theme: Theme,
  caps: TermCapabilities,
  marks: GaugeMarks = DEFAULT_MARKS,
): Gauge {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const cells = Math.max(1, width);
  const filledCells = Math.max(0, Math.min(cells, Math.round((clamped / 100) * cells)));
  // Was `caps.unicode ? '█' : '#'` inline. The branch was correct but the
  // literals still had to move: leaving even a well-formed pair here would mean
  // the A-1 scan needs an exception, and exceptions get copied (§4.1).
  const glyphs = pickGlyphs(caps);
  const full = glyphs.gaugeFull;
  const empty = glyphs.gaugeEmpty;
  return {
    filled: full.repeat(filledCells),
    empty: empty.repeat(cells - filledCells),
    fillColor: thresholdColor(clamped, theme, marks),
    trackColor: theme.gauge.track,
    pct: clamped,
  };
}
