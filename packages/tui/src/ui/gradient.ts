/**
 * Gradient wordmark helper (spec §3.2). Pure: interpolates an RGB gradient
 * across a short string using chalk. Below ansi-256 (or with no stops) it
 * returns the text unchanged so the header falls back to a bold single-color
 * wordmark. No new runtime dependency — `chalk` is already present.
 */

import { Chalk } from 'chalk';

/** Parse a `#rrggbb` (or `#rgb`) string into an `[r, g, b]` triple. */
function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = Number.parseInt(h, 16);
  if (!Number.isFinite(n)) return [255, 255, 255];
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** Interpolate a colour at position `t` ∈ [0,1] across the RGB `stops`. */
function colorAt(stops: [number, number, number][], t: number): [number, number, number] {
  if (stops.length === 1) return stops[0]!;
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (stops.length - 1);
  const idx = Math.min(stops.length - 2, Math.floor(scaled));
  const local = scaled - idx;
  const from = stops[idx]!;
  const to = stops[idx + 1]!;
  return [lerp(from[0], to[0], local), lerp(from[1], to[1], local), lerp(from[2], to[2], local)];
}

/**
 * Render `text` with a per-character gradient across `stops` (hex colors).
 * Returns the text unchanged when `colorLevel < 2` or `stops` is empty.
 */
export function gradientLine(text: string, stops: string[], colorLevel: 0 | 1 | 2 | 3): string {
  if (colorLevel < 2 || stops.length === 0 || text.length === 0) return text;
  const rgbStops = stops.map(parseHex);
  const c = new Chalk({ level: colorLevel === 3 ? 3 : 2 });
  const chars = [...text];
  const denom = chars.length > 1 ? chars.length - 1 : 1;
  return chars
    .map((ch, i) => {
      const [r, g, b] = colorAt(rgbStops, i / denom);
      return c.rgb(r, g, b)(ch);
    })
    .join('');
}
