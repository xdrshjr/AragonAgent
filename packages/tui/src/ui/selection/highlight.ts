/**
 * The row painter (tui-selection-and-scroll-follow §4.4.4). PURE — strings in,
 * strings out.
 *
 * It runs inside the frame differ's `decorate` hook rather than in React (D-6):
 * a re-render per drag event goes through the render governor and the whole
 * component tree, while this repaints one to three rows with no commit at all.
 */

import stripAnsi from 'strip-ansi';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { columnsOf, sliceColumns } from './selection.js';

const CSI = '\x1b[';
const SGR_RESET = `${CSI}0m`;
/** Reverse video — the universal fallback, and what a monochrome terminal gets. */
const REVERSE = `${CSI}7m`;

const HEX = /^#[0-9a-f]{6}$/i;

function rgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}`;
}

/**
 * The SGR sequence that opens a highlighted run.
 *
 * TRUECOLOR OR REVERSE VIDEO, WITH NOTHING IN BETWEEN, and that is deliberate.
 * `getTheme` degrades every palette colour to the terminal's depth, so below
 * ansi-256 `theme.selectionBg` is a CHALK COLOUR NAME (`'blue'`) rather than a
 * hex triple — and a name cannot be turned into an escape sequence here without
 * duplicating chalk's own table. Reverse video is what a terminal that shallow
 * would render anyway, it needs no colour support at all, and it is exactly what
 * the emulator's own selection looks like. The `HEX` test is therefore both the
 * colour-depth check and the type check.
 */
export function selectionOpen(theme: Theme, caps: TermCapabilities): string {
  if (caps.colorLevel < 2) return REVERSE;
  const bg = theme.selectionBg;
  const fg = theme.selectionFg;
  if (!bg || !fg || !HEX.test(bg) || !HEX.test(fg)) return REVERSE;
  return `${CSI}48;2;${rgb(bg)}m${CSI}38;2;${rgb(fg)}m`;
}

/**
 * Paint `[from, to)` of one frame line.
 *
 * `to` is already clamped to the terminal width by the caller, so `Infinity`
 * never reaches here.
 *
 * STRIPPING SGR INSIDE THE SELECTION IS NOT LAZINESS. An inner `\x1b[0m` — which
 * `Markdown` and `cli-highlight` emit constantly — would cancel the highlight
 * attribute mid-run and leave holes in it. Terminals repaint selected text in
 * the selection's own colours for exactly this reason.
 *
 * `pad` is what gives a multi-row selection a straight right edge over short
 * lines, and it measures with `columnsOf` — the same oracle `sliceColumns`
 * charges with — rather than reaching for a third width function (I-12).
 */
export function paintRow(line: string, from: number, to: number, open: string): string {
  if (!(to > from)) return line;
  const head = sliceColumns(line, 0, from);
  const mid = stripAnsi(sliceColumns(line, from, to));
  const pad = ' '.repeat(Math.max(0, to - from - columnsOf(mid)));
  const tail = sliceColumns(line, to);
  return `${head}${open}${mid}${pad}${SGR_RESET}${tail}`;
}
