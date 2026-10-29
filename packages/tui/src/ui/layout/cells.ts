/**
 * Display-width cell arithmetic (tui-subagent-panel §5 #1).
 *
 * EVERY FUNCTION HERE IS PURE AND TOTAL: no Ink, no clock, no terminal, and no
 * input that throws. The panel row and the Agents board both need to place text
 * in a FIXED number of terminal columns, and `padEnd` cannot do that: it counts
 * code units while a terminal counts cells, so a CJK description padded with
 * `padEnd` overflows its box by one column per wide character and pushes the
 * next cell off the row. That is exactly the defect this round removes from the
 * roster, one layer down.
 *
 * ASCII ONLY: `src/ui/**` is inside `glyphs.test.ts`'s static scan, so the
 * ellipsis and any other symbol a caller wants must be passed IN (the board
 * hands over `glyphs.ellipsis`), never spelled here.
 */

import stringWidth from 'string-width';

/** Invalid geometry becomes zero, exactly like the layout modules' `nonNegativeInt`. */
function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Display columns a string occupies, or 0 for a non-string (defensive at the edge only). */
export function cellWidth(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return stringWidth(text);
}

/**
 * Cut `text` to at most `cells` display columns, marking the cut with `ellipsis`.
 *
 * THE ELLIPSIS IS PART OF THE BUDGET, not an extra column: a caller that asks for
 * 8 cells gets a string that MEASURES 8, which is what makes a fixed-width cell
 * a cell rather than a hope. When the budget cannot hold the ellipsis plus one
 * character, the string is hard-cut instead - a marker wider than the cell it
 * marks is the one outcome worse than no marker.
 *
 * Wide characters are never split: a surrogate pair or a double-width glyph that
 * does not fit is dropped whole, so the result can measure one column less than
 * asked but never one more.
 */
export function fitCells(text: string, cells: number, ellipsis = '...'): string {
  const budget = nonNegativeInt(cells);
  if (budget === 0) return '';
  if (cellWidth(text) <= budget) return text;
  const mark = cellWidth(ellipsis) < budget ? ellipsis : '';
  const room = budget - cellWidth(mark);
  let out = '';
  let used = 0;
  // `Array.from` iterates by CODE POINT, so a surrogate pair is one step and can
  // never be cut in half by this loop.
  for (const char of Array.from(text)) {
    const width = cellWidth(char);
    if (used + width > room) break;
    out += char;
    used += width;
  }
  return `${out}${mark}`;
}

/**
 * Pad `text` to exactly `cells` columns (or leave it alone when it already
 * measures at least that).
 *
 * NOT `padEnd`: see this file's header. A padded cell is what keeps the next
 * column at a stable offset, which is the whole point of the panel's table.
 */
export function padCells(text: string, cells: number): string {
  const budget = nonNegativeInt(cells);
  const width = cellWidth(text);
  if (width >= budget) return text;
  return `${text}${' '.repeat(budget - width)}`;
}

/** `fitCells` then `padCells`: the result ALWAYS measures exactly `cells`. */
export function alignRightCells(text: string, cells: number, ellipsis = '...'): string {
  const budget = nonNegativeInt(cells);
  return padCells(fitCells(text, budget, ellipsis), budget);
}

/** What one wrapped line is worth: the text, and whether lines were dropped. */
export interface WrappedCells {
  lines: string[];
  /** Lines that did not fit under `maxRows`; 0 when everything fitted. */
  dropped: number;
}

/**
 * Fold `text` into at most `maxRows` lines of at most `cells` columns each.
 *
 * BREAKS AT SPACES, HARD-CUTS ONLY WHEN A SINGLE TOKEN CANNOT FIT: a word that is
 * wider than the column is the one case where an honest over-long token beats a
 * line of nothing, so it is cut rather than pushed to a line that still cannot
 * hold it. The last allowed line, when text remains, carries the `(+N lines)`
 * tail so the reader learns that the section was truncated instead of believing
 * the prose ended mid-sentence.
 *
 * Pure and total: `cells <= 0` or `maxRows <= 0` yields no lines, and the caller
 * decides what an empty section means (the board omits it).
 */
export function wrapCells(
  text: string,
  cells: number,
  maxRows: number,
  ellipsis = '...',
): WrappedCells {
  const width = nonNegativeInt(cells);
  const limit = nonNegativeInt(maxRows);
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (width === 0 || limit === 0 || flat.length === 0) {
    return { lines: [], dropped: flat.length === 0 ? 0 : limit === 0 ? 1 : 0 };
  }
  const lines: string[] = [];
  let rest = flat;
  while (rest.length > 0) {
    if (cellWidth(rest) <= width) {
      lines.push(rest);
      rest = '';
      break;
    }
    const cut = breakCells(rest, width);
    lines.push(cut.line);
    rest = cut.rest;
  }
  if (lines.length <= limit) return { lines, dropped: 0 };
  const kept = lines.slice(0, limit);
  const dropped = lines.length - limit;
  const tail = `(+${dropped} lines)`;
  // THE ANNOUNCEMENT IS RESERVED, not appended and then truncated away: a reader who
  // sees prose stop mid-sentence with no marker reads it as the end of the fact, which
  // is exactly the wrong conclusion. When the column is too narrow to hold the marker
  // at all, the line is simply cut - the caller's section is unusable at that width.
  const tailCells = cellWidth(tail) + 1;
  const last = kept[limit - 1] ?? '';
  kept[limit - 1] = tailCells < width
    ? `${fitCells(last, width - tailCells, ellipsis)} ${tail}`
    : fitCells(last, width, ellipsis);
  return { lines: kept, dropped };
}

/**
 * The longest prefix of `text` that fits `width` columns, preferring a space.
 *
 * Returns the consumed line and what is left, so the caller's loop is one
 * assignment per iteration and the "one function does one thing" rule holds.
 */
function breakCells(text: string, width: number): { line: string; rest: string } {
  let used = 0;
  let taken = 0;
  let lastSpace = -1;
  for (const char of Array.from(text)) {
    const charWidth = cellWidth(char);
    if (used + charWidth > width) break;
    used += charWidth;
    taken += char.length;
    if (char === ' ') lastSpace = taken;
  }
  // A single token wider than the column: hard-cut it rather than emit nothing.
  if (taken === 0) {
    const first = Array.from(text)[0] ?? '';
    return { line: fitCells(first, width), rest: text.slice(first.length) };
  }
  if (lastSpace > 0) {
    return { line: text.slice(0, lastSpace).trimEnd(), rest: text.slice(lastSpace).trimStart() };
  }
  return { line: text.slice(0, taken), rest: text.slice(taken).trimStart() };
}
