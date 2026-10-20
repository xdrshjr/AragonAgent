/**
 * Byte shapes of the native-scroll writer (tui-native-terminal-scroll §4.3 /
 * Appendix A). Stateless string assembly only — the state machine that decides
 * WHICH shape to emit lives in `scrollback-writer.ts`.
 *
 * THE WHITELIST (I-S5 / I-S6). Every byte produced here is drawn from: SGR, CUU,
 * CUD, CR, CRLF, ED0, EL0, DEC 2026 and DECTCEM. There is no absolute CUP, no
 * scroll region, no `CSI S/T`, no `ED2/ED3`. Relative addressing is what makes the
 * geometry independent of the terminal scrolling underneath it (spec appendix B).
 *
 * Each row is `SGR0 · text · SGR0`: the leading reset stops one row's style leaking
 * into the next, and the trailing one stops a background-colour-erase terminal from
 * painting the following ED0/EL0 in the row's last colour.
 */

import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';

const CSI = '\x1b[';
export const SGR0 = `${CSI}0m`;
const ED0 = `${CSI}J`;
const EL0 = `${CSI}K`;
const SYNC_BEGIN = `${CSI}?2026h`;
const SYNC_END = `${CSI}?2026l`;
const SHOW_CURSOR = `${CSI}?25h`;
const OSC8_CLOSE = '\x1b]8;;\x07';

const up = (n: number): string => (n > 0 ? `${CSI}${n}A` : '');
const down = (n: number): string => (n > 0 ? `${CSI}${n}B` : '');
const row = (text: string): string => SGR0 + text + SGR0 + '\r\n';
const rows = (list: readonly string[]): string => list.map(row).join('');
const wrapSync = (payload: string, sync: boolean): string =>
  sync ? SYNC_BEGIN + payload + SYNC_END : payload;

/** First write of a session: the cursor is already on a fresh line at column 0. */
export function seedBytes(input: {
  lines: readonly string[];
  statics: readonly string[];
  sync: boolean;
  /** After a foreign write the cursor may sit mid-line; start on a new one (RV-11). */
  reseed: boolean;
}): string {
  const lead = input.reseed ? '\r\n' : '';
  return wrapSync(lead + '\r' + SGR0 + rows(input.statics) + rows(input.lines), input.sync);
}

/**
 * CUD(n): move down n rows WITHOUT writing a single cell.
 *
 * This is how the canvas spends its `gap` (D3). A blank row that is never written
 * cannot be pushed into the scrollback by a later overflow, which is the whole
 * reason the gap is not a run of `\r\n` (I-B3). The sequence is already whitelisted
 * (`diffBytes` uses it to step between changed rows); this is the same CUD used to
 * skip empty space instead.
 */
export function skipRows(rows: number): string {
  return down(Math.max(0, Math.floor(Number.isFinite(rows) ? rows : 0)));
}

/**
 * First canvas batch (or the first one after a reset): the screen below the cursor
 * is assumed empty, so there is nothing to erase — only `[gap][content][region]` to
 * write, ending with the cursor parked on the last row.
 */
export function canvasSeedBytes(input: {
  /**
   * Rows to descend from the cursor to the canvas top, when the canvas is shorter
   * than the space measured below the cursor.
   *
   * Non-zero only on a terminal taller than the start-of-canvas cap: the canvas then
   * begins BELOW the cursor, and a seed that started writing at the cursor would park
   * the region low and leave the top of the canvas empty for the whole session.
   */
  downToTop: number;
  /** Blank rows to skip before the first content row. */
  gap: number;
  /** Content rows, already clipped, oldest first. */
  held: readonly string[];
  /** The live region. */
  lines: readonly string[];
  sync: boolean;
  /** After a foreign write the cursor may sit mid-line; start on a new one. */
  reseed: boolean;
}): string {
  const lead = input.reseed ? '\r\n' : '';
  const skip = skipRows(input.downToTop) + skipRows(input.gap);
  return wrapSync(lead + '\r' + SGR0 + skip + rows(input.held) + rows(input.lines), input.sync);
}

/**
 * Redraw the whole canvas: erase the previous one, then write `[gap][content][region]`.
 *
 * ORDER IS SEMANTICS: `ED0`, then the gap, then the content, then the region. Moving
 * the gap after the content puts the blank space back between the reply and the
 * composer, which is the exact defect this feature fixes (M1 in the spec).
 *
 * `held` is the FULL content sequence, not the part that will still be on screen: the
 * rows that do not fit are supposed to leave through the bottom, and the terminal can
 * only scroll away what it was given.
 */
export function canvasBytes(input: {
  /** Previous canvas height: the erase distance. */
  eraseUp: number;
  gap: number;
  held: readonly string[];
  lines: readonly string[];
  sync: boolean;
}): string {
  return wrapSync(
    up(input.eraseUp) + '\r' + SGR0 + ED0 + skipRows(input.gap) +
      rows(input.held) + rows(input.lines),
    input.sync,
  );
}

/** Erase exactly the previous live region, print static rows, redraw the region. */
export function fullBytes(input: {
  lines: readonly string[];
  statics: readonly string[];
  /** Rows between the region top and the parked cursor. */
  eraseUp: number;
  sync: boolean;
}): string {
  return wrapSync(
    up(input.eraseUp) + '\r' + SGR0 + ED0 + rows(input.statics) + rows(input.lines),
    input.sync,
  );
}

/**
 * Fill the screen down to the LAST row before the first batch (D4 rung 2 / §4.3).
 *
 * This is the fallback for a terminal that never answers `ESC[6n`: from any row, a
 * run of `rows - 1` line feeds is guaranteed to leave the cursor on the bottom row
 * (extra feeds only scroll, which is why the count is the caller's business). It is
 * written ONCE, before anything else, so the rows it scrolls away are the host's old
 * output — which is still in the scrollback — and never this session's content.
 *
 * The argument is the NUMBER OF LINE FEEDS, not the terminal height: `cli.tsx` passes
 * `rows - 1`. Naming it after the height instead made the caller subtract twice and
 * left the cursor one row short of the bottom.
 */
export function fillBytes(count: number): string {
  return '\r\n'.repeat(Math.max(0, Math.floor(count)));
}

/** Same height, no static rows: rewrite only the rows that changed. `''` if none did. */
export function diffBytes(input: {
  lines: readonly string[];
  prev: readonly string[];
  sync: boolean;
}): string {
  const { lines, prev } = input;
  const height = lines.length;
  let out = '';
  let cursor = -1;
  for (let i = 0; i < height; i += 1) {
    if (lines[i] === prev[i]) continue;
    // Paint, THEN clear the tail: never ESC[2K first, which would blank the row
    // the user is looking at for the instant between the two writes.
    out += (cursor < 0 ? up(height - i) : down(i - cursor)) + '\r' + SGR0 + lines[i] + SGR0 + EL0;
    cursor = i;
  }
  if (cursor < 0) return '';
  // Park on the row below the region, column 0 (I-S4).
  return wrapSync(out + down(height - cursor) + '\r', input.sync);
}

/**
 * Exit: erase the live region, flush leftover static rows, print the summary.
 * `eraseUp < 0` means the geometry is unknown (a foreign write intervened), in
 * which case the only safe move is to start on a fresh line and erase nothing.
 */
export function finalizeBytes(input: {
  eraseUp: number;
  statics: readonly string[];
  summary: readonly string[];
}): string {
  const head = input.eraseUp < 0 ? '\r\n' : up(input.eraseUp) + '\r' + SGR0 + ED0;
  return head + rows(input.statics) + rows(input.summary) + SHOW_CURSOR;
}

const ESCAPE = /(\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/;
const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text);
}

/**
 * Cut a row to `maxCols` DISPLAY columns (I-S13), keeping SGR / OSC 8 intact.
 *
 * Returns the input unchanged (same reference) when it already fits, which is the
 * overwhelmingly common case. Width is measured the way Ink measures it
 * (`string-width` over the ANSI-stripped text): that is the number Ink used to
 * wrap, so a disagreement with the terminal is the only way a row can exceed it.
 */
export function clipLine(line: string, maxCols: number): { text: string; clipped: boolean } {
  if (maxCols < 1) return { text: '', clipped: line.length > 0 };
  if (stringWidth(stripAnsi(line)) <= maxCols) return { text: line, clipped: false };
  let out = '';
  let width = 0;
  let linkOpen = false;
  for (const part of line.split(ESCAPE)) {
    if (part.startsWith('\x1b')) {
      out += part;
      if (part.startsWith('\x1b]8;')) linkOpen = !/^\x1b\]8;[^;]*;(?:\x07|\x1b\\)$/.test(part);
      continue;
    }
    for (const glyph of graphemes(part)) {
      const glyphWidth = stringWidth(glyph);
      if (width + glyphWidth > maxCols) return { text: out + SGR0 + (linkOpen ? OSC8_CLOSE : ''), clipped: true };
      out += glyph;
      width += glyphWidth;
    }
  }
  return { text: out, clipped: false };
}
