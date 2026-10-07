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

import { buildEditorVisualMap, graphemes, graphemeWidth } from './editor-navigation.js';
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

/** Width of a displayed run, measured by complete graphemes. */
export function displayWidth(text: string): number {
  return graphemes(text).reduce((width, part) => width + graphemeWidth(part.text), 0);
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
  const maxRows = input.maxRows >= 1 ? Math.floor(input.maxRows) : 1;
  const map = buildEditorVisualMap(input);
  const cursorRowAbs = active ? map.cursor.row : -1;
  const cursorCol = map.cursor.column;
  const spans = tokenSpans(buffer);
  let spanIndex = 0;
  const rows: ComposerRow[] = map.rows.map((cells) => {
    const segments: ComposerSegment[] = [];
    for (const cell of cells) {
      while (spanIndex < spans.length && spans[spanIndex]!.end <= cell.index) spanIndex += 1;
      const span = spans[spanIndex];
      const kind = span && cell.index >= span.start && cell.index < span.end ? 'token' : 'text';
      const last = segments[segments.length - 1];
      if (last && last.kind === kind) segments[segments.length - 1] = {
        text: last.text + cell.text, kind,
      };
      else segments.push({ text: cell.text, kind });
    }
    return { segments };
  });

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
    for (const { text: ch } of graphemes(segment.text)) {
      if (graphemeWidth(ch) === 0) {
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
