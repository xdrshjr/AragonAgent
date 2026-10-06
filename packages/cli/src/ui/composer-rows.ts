/**
 * Composer layout (tui-paste-handling section 5.5) -- pure. No Ink, no React.
 *
 * THE ONE PLACE THAT MAPS A BUFFER INDEX TO A SCREEN CELL (I-9). The composer
 * used to hand its buffer to Ink one `<Text>` per logical line and let Yoga wrap
 * it, which is fine until the draft is taller than the frame: `AppShell` gives
 * the bottom chrome `flexShrink={0}`, so a tall composer does not grow the frame
 * -- Yoga takes the rows out of the transcript and `overflow: hidden` clips them
 * away, while `layout/budget.ts` keeps telling five consumers the composer is
 * three rows tall. Four hundred presses of `Shift+Enter` do it without pasting
 * anything.
 *
 * So the wrap happens HERE, the row count is a number this module returns, and
 * `budget.ts` is told that number (I-8).
 *
 * HARD WRAP BY DISPLAY COLUMN, NEVER `layout/wrap-rows.ts::wrapToRows` (D-15).
 * That function is a PROSE wrapper: it splits on `/\s+/` and rejoins with single
 * spaces, so it destroys indentation and makes the character-index-to-screen-cell
 * mapping the caret depends on impossible to state, let alone compute.
 */

import stringWidth from 'string-width';
import { tokenSpans } from './paste-tokens.js';

export interface ComposerSegment {
  readonly text: string;
  readonly kind: 'text' | 'token';
}

export interface ComposerRow {
  readonly segments: ComposerSegment[];
}

export interface ComposerLayout {
  /** At most `maxRows`, and always containing the caret when `active`. */
  readonly rows: ComposerRow[];
  /** Index into `rows`, or -1 when the composer is not focused. */
  readonly cursorRow: number;
  /** Display column within that row. */
  readonly cursorCol: number;
  /** Rows the buffer occupies BEFORE the window was applied. */
  readonly totalRows: number;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

export interface ComposerLayoutInput {
  readonly buffer: string;
  readonly cursor: number;
  readonly cols: number;
  readonly maxRows: number;
  readonly active: boolean;
}

/**
 * Columns a TAB advances to.
 *
 * TABS ARE EXPANDED TO SPACES FOR DISPLAY ONLY -- the buffer keeps the tab, so
 * the model receives exactly what was pasted. The alternative is to emit the raw
 * tab and let the terminal expand it, which puts the terminal's tab stop (8) and
 * this module's column arithmetic in disagreement: the row would overflow its box
 * and the terminal would wrap it a second time, which is the corruption the whole
 * feature exists to remove.
 */
const TAB_WIDTH = 4;

/**
 * Display width of one code point.
 *
 * The ASCII fast path matters: `layoutComposer` runs on every keystroke and a
 * recalled prompt-history entry can be thousands of characters, so one
 * `string-width` call per character would be the cost this package spent
 * `tui-render-performance` removing.
 */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x20 && code < 0x7f) return 1;
  return stringWidth(ch);
}

/** Total display width of a run, using the same table the layout used. */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

/** Normalize only the visual projection; the editor keeps its UTF-16 index. */
function visualCursor(buffer: string, cursor: number): number {
  let index = Math.max(0, Math.min(buffer.length, cursor));
  const code = buffer.charCodeAt(index);
  const previous = buffer.charCodeAt(index - 1);
  if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) index -= 1;
  if (index === buffer.length || buffer[index] === '\n') return index;
  const ch = String.fromCodePoint(buffer.codePointAt(index)!);
  if (ch === '\t' || charWidth(ch) > 0) return index;

  const start = buffer.lastIndexOf('\n', index - 1) + 1;
  let nearest = -1;
  let i = start;
  while (i < buffer.length && buffer[i] !== '\n') {
    const point = String.fromCodePoint(buffer.codePointAt(i)!);
    if (point === '\t' || charWidth(point) > 0) {
      if (i > index) return nearest >= 0 ? nearest : i;
      nearest = i;
    }
    i += point.length;
  }
  return nearest >= 0 ? nearest : i;
}

/**
 * Wrap `buffer` into rows, locate the caret, and select a window of at most
 * `maxRows` rows that contains it.
 *
 * The window is pinned to the BOTTOM -- where the user is typing -- and pulled up
 * only far enough to keep the caret visible. That is deterministic, which matters
 * because this function holds no state between calls: a scroll offset would have
 * to live in the reducer and would then need its own invalidation rules.
 */
export function layoutComposer(input: ComposerLayoutInput): ComposerLayout {
  const { buffer, active } = input;
  const cursor = visualCursor(buffer, input.cursor);
  const cols = Math.max(1, Math.floor(input.cols));
  const maxRows = input.maxRows >= 1 ? Math.floor(input.maxRows) : 1;

  const spans = tokenSpans(buffer);
  let spanIndex = 0;
  /** Monotonic in `index`, which is why the pointer is safe. */
  const kindAt = (index: number): 'text' | 'token' => {
    while (spanIndex < spans.length && spans[spanIndex]!.end <= index) spanIndex += 1;
    const span = spans[spanIndex];
    return span && index >= span.start && index < span.end ? 'token' : 'text';
  };

  const rows: ComposerRow[] = [];
  let segments: ComposerSegment[] = [];
  let col = 0;
  let cursorRowAbs = -1;
  let cursorCol = 0;

  const breakRow = (): void => {
    rows.push({ segments });
    segments = [];
    col = 0;
  };
  const append = (text: string, width: number, kind: 'text' | 'token'): void => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) segments[segments.length - 1] = { text: last.text + text, kind };
    else segments.push({ text, kind });
    col += width;
  };
  const ensureRoom = (width: number): void => {
    if (col > 0 && col + width > cols) breakRow();
  };

  const length = buffer.length;
  let i = 0;
  while (i <= length) {
    const atCursor = active && i === cursor && cursorRowAbs === -1;
    if (i === length) {
      if (atCursor) {
        ensureRoom(1);
        cursorRowAbs = rows.length;
        cursorCol = col;
      }
      break;
    }
    const ch = String.fromCodePoint(buffer.codePointAt(i)!);
    if (ch === '\n') {
      if (atCursor) {
        ensureRoom(1);
        cursorRowAbs = rows.length;
        cursorCol = col;
      }
      breakRow();
      i += 1;
      continue;
    }
    const kind = kindAt(i);
    if (ch === '\t') {
      let advance = TAB_WIDTH - (col % TAB_WIDTH);
      if (col > 0 && col + advance > cols) {
        breakRow();
        advance = TAB_WIDTH;
      }
      if (atCursor) {
        cursorRowAbs = rows.length;
        cursorCol = col;
      }
      append(' '.repeat(advance), advance, kind);
      i += 1;
      continue;
    }
    const width = charWidth(ch);
    ensureRoom(width);
    if (atCursor) {
      cursorRowAbs = rows.length;
      cursorCol = col;
    }
    append(ch, width, kind);
    i += ch.length;
  }
  rows.push({ segments });

  const totalRows = rows.length;
  const cap = Math.max(1, Math.min(maxRows, totalRows));
  let start = Math.max(0, totalRows - cap);
  if (cursorRowAbs >= 0) {
    if (cursorRowAbs < start) start = cursorRowAbs;
    else if (cursorRowAbs >= start + cap) start = Math.min(totalRows - cap, cursorRowAbs - cap + 1);
  }
  const windowed = rows.slice(start, start + cap);

  return {
    rows: windowed,
    cursorRow: cursorRowAbs >= 0 ? cursorRowAbs - start : -1,
    cursorCol,
    totalRows,
    hiddenAbove: start,
    hiddenBelow: totalRows - start - windowed.length,
  };
}

export interface RowSplit {
  readonly before: ComposerSegment[];
  /** The one cell the caret sits on, or `null` when it sits past the last one. */
  readonly at: ComposerSegment | null;
  readonly after: ComposerSegment[];
}

/**
 * Split one row at a display column so the renderer can draw an inverse caret on
 * exactly one cell.
 *
 * Lives here rather than in the component because it walks the SAME width table
 * `layoutComposer` walked (I-9): a second, subtly different measurement is how
 * the caret ends up drawn on a cell that does not hold the character it is on.
 */
export function splitRowAtColumn(row: ComposerRow, column: number): RowSplit {
  const before: ComposerSegment[] = [];
  const after: ComposerSegment[] = [];
  let at: ComposerSegment | null = null;
  let x = 0;

  const push = (list: ComposerSegment[], text: string, kind: 'text' | 'token'): void => {
    const last = list[list.length - 1];
    if (last && last.kind === kind) list[list.length - 1] = { text: last.text + text, kind };
    else list.push({ text, kind });
  };

  const cells: ComposerSegment[] = [];
  let leading = '';
  for (const segment of row.segments) {
    for (const ch of segment.text) {
      if (charWidth(ch) === 0) {
        const last = cells[cells.length - 1];
        if (last) cells[cells.length - 1] = { ...last, text: last.text + ch };
        else leading += ch;
      } else {
        cells.push({ text: leading + ch, kind: segment.kind });
        leading = '';
      }
    }
  }
  // A zero-width-only row keeps its text before the explicitly budgeted space.
  if (leading) push(before, leading, row.segments[0]?.kind ?? 'text');
  for (const cell of cells) {
    const width = displayWidth(cell.text);
    if (at === null && column >= x && column < x + width) at = cell;
    else push(at === null ? before : after, cell.text, cell.kind);
    x += width;
  }
  return { before, at, after };
}
