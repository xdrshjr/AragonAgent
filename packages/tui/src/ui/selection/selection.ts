/**
 * The selection model (tui-selection-and-scroll-follow §4.4.4). PURE — no React,
 * no I/O, no terminal.
 *
 * Coordinates are SCREEN CELLS, 0-based: frame line `i` is terminal row `i + 1`
 * and column `x - 1`, so an SGR report at `(x, y)` becomes `{ row: y - 1, col: x
 * - 1 }`. Screen coordinates are only sound while the rows hold still, and
 * holding them still is Stage 2's job — `press` sets `hold`, which anchors the
 * content and suspends the resume timer, so the transcript is frozen for the
 * duration of a drag (D-7).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * I-12 — `sliceColumns` IS THE ONE COLUMN→CHARACTER MAPPING IN THIS FEATURE,
 * and `stringWidth` is its only width oracle.
 *
 * The painter and the extractor are handed the SAME half-open column range by
 * `rowSpan`. If they turn that range into characters by different rules, the
 * copied text is not the highlighted text — silently, which is the one failure
 * mode I-4 exists to name. That is not hypothetical: `slice-ansi` advances its
 * cursor by `isFullWidth ? 2 : character.length`, i.e. display columns for CJK
 * but UTF-16 CODE UNITS for everything else, so a combining mark costs it a
 * column that occupies none and an astral code point costs two; and the obvious
 * `String.slice` for the extractor is code units throughout. Two mappings from
 * one range agree on ASCII and diverge on exactly the rows a user is most likely
 * to want to copy.
 *
 * So both call the function below, which walks GRAPHEME CLUSTERS and charges
 * each one `stringWidth(cluster)` columns. What is hand-rolled here is only the
 * column arithmetic — the width table is still `string-width`'s, and the escape
 * bookkeeping is `slice-ansi`'s idea re-indexed (R-13).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import stringWidth from 'string-width';

export interface Cell {
  /** 0-based frame line. */
  row: number;
  /** 0-based screen column. */
  col: number;
}

export interface Selection {
  anchor: Cell;
  focus: Cell;
}

/** `start <= end` in reading order. */
export interface NormalSelection {
  start: Cell;
  end: Cell;
}

/** A half-open column range on one row; `to` may be `Infinity` (to end of line). */
export interface RowSpan {
  from: number;
  to: number;
}

export function normalize(sel: Selection): NormalSelection {
  const { anchor, focus } = sel;
  const anchorFirst =
    anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col);
  return anchorFirst ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

export function isEmpty(sel: NormalSelection): boolean {
  return sel.start.row === sel.end.row && sel.start.col === sel.end.col;
}

/**
 * The half-open column range to highlight on `row`, or `null` when the row is
 * outside the selection.
 *
 * LINEAR, NOT RECTANGULAR — what every terminal does: the first row runs from
 * `start.col` to end of line, whole middle rows are taken entirely, and the last
 * row stops at `end.col`. `Infinity` means "to the end of the line"; the painter
 * clamps it to the terminal width so a multi-row selection gets a straight right
 * edge, and the extractor treats it as "no upper bound".
 */
export function rowSpan(sel: NormalSelection, row: number): RowSpan | null {
  const { start, end } = sel;
  if (row < start.row || row > end.row) return null;
  if (start.row === end.row) {
    return end.col > start.col ? { from: start.col, to: end.col } : null;
  }
  if (row === start.row) return { from: start.col, to: Number.POSITIVE_INFINITY };
  if (row === end.row) return end.col > 0 ? { from: 0, to: end.col } : null;
  return { from: 0, to: Number.POSITIVE_INFINITY };
}

/**
 * The text a release would put on the clipboard.
 *
 * `plainRows` are the mirror's ANSI-STRIPPED rows — the same rows the highlight
 * was painted over, which is what makes I-4 hold by construction rather than by
 * a staleness check that can be wrong.
 */
export function selectedText(plainRows: readonly string[], sel: NormalSelection): string {
  const out: string[] = [];
  for (let row = sel.start.row; row <= sel.end.row; row += 1) {
    const span = rowSpan(sel, row);
    if (!span) continue;
    const line = plainRows[row] ?? '';
    const to = Number.isFinite(span.to) ? span.to : undefined;
    out.push(sliceColumns(line, span.from, to).trimEnd());
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// sliceColumns — the one mapping (I-12)
// ---------------------------------------------------------------------------

/**
 * CSI / OSC sequences. They occupy ZERO columns and are copied through so a
 * slice keeps the styling of the text around it.
 */
const ANSI_RE = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
/** SGR "all attributes off" — everything carried before it is cancelled. */
const SGR_RESET_RE = /^\x1b\[0?m$/;

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/**
 * Width cache. `stringWidth` re-segments and re-classifies on every call, and a
 * repaint slices every row of the selection; the key space is the set of
 * grapheme clusters on screen, which is tiny and bounded by the frame.
 */
const widthCache = new Map<string, number>();
const WIDTH_CACHE_MAX = 4096;

function clusterWidth(cluster: string): number {
  const hit = widthCache.get(cluster);
  if (hit !== undefined) return hit;
  const w = stringWidth(cluster);
  // A plain ceiling with a wholesale drop, like `virtual-window.ts`'s height
  // cache: an LRU here would cost more bookkeeping than the values are worth.
  if (widthCache.size >= WIDTH_CACHE_MAX) widthCache.clear();
  widthCache.set(cluster, w);
  return w;
}

interface Token {
  text: string;
  ansi: boolean;
}

/** Split into ANSI sequences and grapheme clusters, in order. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  ANSI_RE.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushPlain = (chunk: string): void => {
    if (chunk.length === 0) return;
    if (segmenter) {
      for (const { segment } of segmenter.segment(chunk)) tokens.push({ text: segment, ansi: false });
      return;
    }
    // No `Intl.Segmenter`: code points are a strictly worse but never wrong
    // approximation — a combining mark becomes its own zero-width token, which
    // the walk below already handles.
    for (const cp of chunk) tokens.push({ text: cp, ansi: false });
  };
  while ((m = ANSI_RE.exec(text)) !== null) {
    pushPlain(text.slice(last, m.index));
    tokens.push({ text: m[0], ansi: true });
    last = m.index + m[0].length;
  }
  pushPlain(text.slice(last));
  return tokens;
}

/**
 * Slice `text` by SCREEN COLUMNS, half-open `[from, to)`.
 *
 * Three properties are load-bearing:
 *
 *  - **Escape codes opened before `from` are carried into the result.** Without
 *    it the painter's tail — `sliceColumns(line, to)` — would lose the colour
 *    `Markdown` and `cli-highlight` gave it, on every row a selection touches.
 *  - **A wide cluster straddling either boundary becomes spaces for the part
 *    that is inside.** That keeps the arithmetic EXACT in columns, which is the
 *    whole point of I-12: half a CJK glyph is not a character, and inventing one
 *    would put the painter and the extractor back out of step.
 *  - **`to` is optional and means "to the end of the line".**
 */
export function sliceColumns(text: string, from: number, to?: number): string {
  const start = Math.max(0, Math.floor(from));
  const end = to === undefined || !Number.isFinite(to) ? Number.POSITIVE_INFINITY : Math.floor(to);
  if (end <= start) return '';

  let carried = '';
  let out = '';
  let col = 0;
  let started = false;

  const open = (): void => {
    if (started) return;
    started = true;
    out += carried;
  };

  for (const token of tokenize(text)) {
    if (token.ansi) {
      if (started) out += token.text;
      else {
        if (SGR_RESET_RE.test(token.text)) carried = '';
        carried += token.text;
      }
      continue;
    }
    if (col >= end) break;
    const w = clusterWidth(token.text);
    if (w === 0) {
      // A zero-width cluster attaches to the cell before it, so it belongs to the
      // slice only when that cell is already inside.
      if (started) out += token.text;
      continue;
    }
    const cellEnd = col + w;
    if (cellEnd <= start) {
      col = cellEnd;
      continue;
    }
    open();
    if (col < start) {
      // Straddles the LEFT boundary: only `cellEnd - start` columns are ours.
      out += ' '.repeat(Math.min(cellEnd, end) - start);
    } else if (cellEnd > end) {
      // Straddles the RIGHT boundary.
      out += ' '.repeat(end - col);
    } else {
      out += token.text;
    }
    col = cellEnd;
  }

  return out;
}

/** Display width in columns, using the same oracle `sliceColumns` charges with. */
export function columnsOf(text: string): number {
  let total = 0;
  for (const token of tokenize(text)) {
    if (!token.ansi) total += clusterWidth(token.text);
  }
  return total;
}
