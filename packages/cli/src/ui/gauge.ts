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

/** Pick the fill colour by threshold: <60 low · 60–85 mid · >85 high. */
function thresholdColor(pct: number, theme: Theme): string | undefined {
  if (pct > 85) return theme.gauge.high;
  if (pct >= 60) return theme.gauge.mid;
  return theme.gauge.low;
}

/**
 * Build a `width`-cell gauge for `pct` (0–100). Uses block glyphs on Unicode
 * terminals and `#`/`-` otherwise (e.g. `[######----]`).
 */
export function buildGauge(
  pct: number,
  width: number,
  theme: Theme,
  caps: TermCapabilities,
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
    fillColor: thresholdColor(clamped, theme),
    trackColor: theme.gauge.track,
    pct: clamped,
  };
}
