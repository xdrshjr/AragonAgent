/**
 * The selection model (tui-selection-and-scroll-follow §4.4.4). Pure strings in,
 * pure strings out — no terminal, no Ink, no mouse.
 */

import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import {
  columnsOf,
  isEmpty,
  normalize,
  rowSpan,
  selectedText,
  sliceColumns,
} from '../ui/selection/selection.js';
import { paintRow, selectionOpen } from '../ui/selection/highlight.js';
import { getTheme } from '../ui/theme.js';

const cell = (row: number, col: number) => ({ row, col });

describe('normalize', () => {
  it('T-3: puts start before end for all four drag directions', () => {
    const a = cell(2, 5);
    const b = cell(6, 1);
    // down-right, up-left
    expect(normalize({ anchor: a, focus: b })).toEqual({ start: a, end: b });
    expect(normalize({ anchor: b, focus: a })).toEqual({ start: a, end: b });
    // same row, both ways
    const c = cell(4, 2);
    const d = cell(4, 9);
    expect(normalize({ anchor: c, focus: d })).toEqual({ start: c, end: d });
    expect(normalize({ anchor: d, focus: c })).toEqual({ start: c, end: d });
  });

  it('reports a zero-extent selection as empty', () => {
    expect(isEmpty(normalize({ anchor: cell(1, 1), focus: cell(1, 1) }))).toBe(true);
    expect(isEmpty(normalize({ anchor: cell(1, 1), focus: cell(1, 2) }))).toBe(false);
  });
});

describe('rowSpan', () => {
  const sel = normalize({ anchor: cell(1, 4), focus: cell(3, 6) });

  it('is LINEAR, not rectangular — what every terminal does', () => {
    expect(rowSpan(sel, 0)).toBeNull();
    expect(rowSpan(sel, 1)).toEqual({ from: 4, to: Number.POSITIVE_INFINITY });
    expect(rowSpan(sel, 2)).toEqual({ from: 0, to: Number.POSITIVE_INFINITY });
    expect(rowSpan(sel, 3)).toEqual({ from: 0, to: 6 });
    expect(rowSpan(sel, 4)).toBeNull();
  });

  it('returns null rather than a zero-width span on the final row at column 0', () => {
    // A drag that stops exactly at the left edge of a row selects nothing THERE.
    // A `{from: 0, to: 0}` span would paint a zero-width highlight and copy an
    // empty trailing line.
    const stops = normalize({ anchor: cell(1, 2), focus: cell(2, 0) });
    expect(rowSpan(stops, 2)).toBeNull();
  });
});

describe('selectedText', () => {
  const rows = ['first line here', 'second line', 'third line', 'fourth'];

  it('T-4: single row, multi row, and whole middle rows', () => {
    expect(selectedText(rows, normalize({ anchor: cell(0, 6), focus: cell(0, 10) }))).toBe('line');
    expect(selectedText(rows, normalize({ anchor: cell(0, 6), focus: cell(2, 5) }))).toBe(
      'line here\nsecond line\nthird',
    );
  });

  it('T-4: trims each row, so a padded frame does not travel to the clipboard', () => {
    const padded = ['alpha        ', 'beta         '];
    expect(selectedText(padded, normalize({ anchor: cell(0, 0), focus: cell(1, 13) }))).toBe(
      'alpha\nbeta',
    );
  });

  it('reads through ANSI-stripped rows, never raw ones', () => {
    // The mirror hands `plain` here; a raw row would put escape codes on the
    // clipboard, which is manual matrix row 2.
    const plain = ['const x = 1;'];
    expect(selectedText(plain, normalize({ anchor: cell(0, 0), focus: cell(0, 5) }))).toBe('const');
  });
});

describe('sliceColumns — the ONE column→character mapping (I-12)', () => {
  it('T-5: charges a full-width CJK glyph two columns', () => {
    // `String.slice` would treat each of these as ONE unit, so a 4-column
    // selection would copy four glyphs instead of two.
    const line = '你好世界'; // 4 CJK glyphs, 8 columns
    expect(sliceColumns(line, 0, 4)).toBe('你好');
    expect(sliceColumns(line, 4)).toBe('世界');
    expect(columnsOf(line)).toBe(8);
  });

  it('substitutes spaces for a wide glyph cut in half by either boundary', () => {
    // EXACT COLUMN ARITHMETIC is the point: half a CJK glyph is not a character,
    // and inventing one would put the painter and the extractor back out of step.
    const line = 'a你b'; // a(1) 你(2) b(1)
    expect(sliceColumns(line, 1, 2)).toBe(' ');
    expect(sliceColumns(line, 2, 3)).toBe(' ');
    expect(sliceColumns(line, 1, 3)).toBe('你');
  });

  it('carries escape codes opened before the slice into the result', () => {
    // Without this the painter's TAIL — `sliceColumns(line, to)` — loses the
    // colour `Markdown` and `cli-highlight` gave it, on every row a selection
    // touches.
    const line = '\x1b[31mred text\x1b[0m';
    expect(sliceColumns(line, 4)).toBe('\x1b[31mtext\x1b[0m');
  });

  it('drops carried codes at an SGR reset rather than piling them up', () => {
    // The reset itself is kept — it is the state "attributes off", which is
    // exactly what the slice starts in — but the `\x1b[31m` it cancelled is not
    // carried forward. Concatenating every escape ever seen would work too, and
    // would grow without bound on a syntax-highlighted line.
    const line = '\x1b[31mred\x1b[0m plain';
    expect(sliceColumns(line, 4)).toBe('\x1b[0mplain');
    expect(sliceColumns(line, 4)).not.toContain('\x1b[31m');
  });

  it('returns empty for a degenerate range', () => {
    expect(sliceColumns('abc', 2, 2)).toBe('');
    expect(sliceColumns('abc', 3, 1)).toBe('');
  });
});

describe('T-30: the painter and the extractor agree, character for character', () => {
  /**
   * ═══ ASSERTING THEM APART IS WHAT LET THE UNIT MISMATCH THROUGH (P1-5) ═══
   *
   * `slice-ansi` advances its cursor by `isFullWidth ? 2 : character.length` —
   * display columns for CJK, but UTF-16 CODE UNITS for everything else — while
   * the obvious `String.slice` for the extractor is code units throughout. Two
   * mappings from one column range agree on ASCII and diverge on exactly the rows
   * a user is most likely to want to copy, SILENTLY, which is the one failure
   * mode I-4 exists to name.
   */
  const CAPS = { colorLevel: 3, unicode: true } as const;
  const THEME = getTheme('cool', CAPS);
  // ASCII, a CJK pair, an emoji, and an accent built from a combining mark.
  const ROW = 'ab你好\u{1F600}éfg';

  it('the highlighted columns hold exactly the copied text', () => {
    const open = selectionOpen(THEME, CAPS);
    const total = columnsOf(ROW);
    for (let from = 0; from <= total; from += 1) {
      for (let to = from + 1; to <= total; to += 1) {
        const copied = selectedText([ROW], normalize({ anchor: cell(0, from), focus: cell(0, to) }));
        const painted = paintRow(ROW, from, to, open);
        // Everything between the highlight's open sequence and the closing reset
        // is what the user SEES selected.
        const start = painted.indexOf(open) + open.length;
        const end = painted.indexOf('\x1b[0m', start);
        const highlighted = painted.slice(start, end);
        // The painter pads short rows for a straight right edge; the extractor
        // trims. Comparing the trimmed forms is comparing the same claim.
        expect(highlighted.trimEnd(), `columns [${from}, ${to})`).toBe(copied);
      }
    }
  });

  it('the highlight occupies exactly the requested number of columns', () => {
    const open = selectionOpen(THEME, CAPS);
    const painted = paintRow(ROW, 2, 6, open);
    const start = painted.indexOf(open) + open.length;
    const end = painted.indexOf('\x1b[0m', start);
    expect(columnsOf(painted.slice(start, end))).toBe(4);
  });

  it('keeps `stringWidth` as the single width oracle', () => {
    // `columnsOf` is a cluster-by-cluster sum; `stringWidth` measures the whole
    // string. They have to agree, or `pad` in the painter is measuring something
    // the slicer never charged for.
    for (const s of ['abc', '你好', '\u{1F600}', 'é', ROW]) {
      expect(columnsOf(s), s).toBe(stringWidth(s));
    }
  });
});
