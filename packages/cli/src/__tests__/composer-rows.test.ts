/**
 * Composer layout (tui-paste-handling section 5.5, T-11..T-13).
 *
 * PURE-FUNCTION ASSERTIONS, for the reason `budget.test.ts` gives one file over:
 * `ink-testing-library`'s stdout stub exposes `columns` and no `rows`, so a
 * mounted loop over terminal heights would silently assert the same case every
 * time.
 */

import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { displayWidth, layoutComposer, splitRowAtColumn } from '../ui/composer-rows.js';

const rowText = (row: { segments: { text: string }[] }): string =>
  row.segments.map((s) => s.text).join('');

const layout = (buffer: string, patch: Partial<Parameters<typeof layoutComposer>[0]> = {}) =>
  layoutComposer({ buffer, cursor: buffer.length, cols: 40, maxRows: 6, active: true, ...patch });

describe('layoutComposer — hard wrap by display column (D-15)', () => {
  it('T-11: wraps 40 CJK characters at cols:40 into 2 rows, not 1', () => {
    // The whole reason this is `string-width` and not `.length`: a CJK character
    // is one JS character and TWO terminal cells.
    const cjk = '中'.repeat(40);
    expect(stringWidth(cjk)).toBe(80);
    // `cursor: 0` because this case is about the WRAP. With the caret at the end
    // the buffer legitimately occupies a third row: the second one is exactly
    // full, so the caret cell lands at the start of the next, which is what a
    // terminal does and what the composer must budget for.
    const out = layout(cjk, { cursor: 0, maxRows: 10 });
    expect(out.totalRows).toBe(2);
    expect(out.rows.map(rowText).join('')).toBe(cjk);
  });

  it('wraps ASCII exactly at the column boundary', () => {
    const out = layout('x'.repeat(85), { cols: 40, maxRows: 10 });
    expect(out.totalRows).toBe(3);
    expect(displayWidth(rowText(out.rows[0]!))).toBe(40);
    expect(displayWidth(rowText(out.rows[1]!))).toBe(40);
    expect(displayWidth(rowText(out.rows[2]!))).toBe(5);
  });

  it('T-13: preserves leading whitespace verbatim (the regression wrapToRows causes)', () => {
    // `wrapToRows` splits on /\s+/ and rejoins with single spaces, which destroys
    // indentation — and with it the index-to-cell mapping the caret depends on.
    const out = layout('    indented\n\t\ttabbed', { maxRows: 10 });
    expect(rowText(out.rows[0]!)).toBe('    indented');
    // Tabs are expanded to spaces FOR DISPLAY ONLY; the buffer keeps the tab.
    expect(rowText(out.rows[1]!)).toBe('        tabbed');
  });

  it('gives an empty buffer exactly one row', () => {
    const out = layout('');
    expect(out.totalRows).toBe(1);
    expect(out.rows).toHaveLength(1);
    expect(rowText(out.rows[0]!)).toBe('');
  });

  it('gives a trailing newline its own empty row', () => {
    const out = layout('a\n');
    expect(out.totalRows).toBe(2);
    expect(rowText(out.rows[1]!)).toBe('');
  });
});

describe('layoutComposer — the window (T-12 / G6)', () => {
  const many = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');

  it('never returns more than maxRows, and the three counts always sum to totalRows', () => {
    for (const maxRows of [1, 3, 6, 10, 40]) {
      for (const cursor of [0, 30, many.length]) {
        const out = layoutComposer({ buffer: many, cursor, cols: 40, maxRows, active: true });
        expect(out.rows.length, `maxRows=${maxRows}`).toBeLessThanOrEqual(maxRows);
        expect(out.hiddenAbove + out.rows.length + out.hiddenBelow).toBe(out.totalRows);
      }
    }
  });

  it('always includes the caret row while active', () => {
    for (let cursor = 0; cursor <= many.length; cursor += 7) {
      const out = layoutComposer({ buffer: many, cursor, cols: 40, maxRows: 3, active: true });
      expect(out.cursorRow, `cursor=${cursor}`).toBeGreaterThanOrEqual(0);
      expect(out.cursorRow).toBeLessThan(out.rows.length);
    }
  });

  it('pins to the bottom, which is where the user is typing', () => {
    const out = layoutComposer({
      buffer: many,
      cursor: many.length,
      cols: 40,
      maxRows: 3,
      active: true,
    });
    expect(out.hiddenBelow).toBe(0);
    expect(out.hiddenAbove).toBe(out.totalRows - 3);
    expect(rowText(out.rows[2]!)).toBe('line19');
  });

  it('scrolls up far enough to keep a caret above the window visible', () => {
    const out = layoutComposer({ buffer: many, cursor: 0, cols: 40, maxRows: 3, active: true });
    expect(out.cursorRow).toBe(0);
    expect(out.hiddenAbove).toBe(0);
    expect(out.hiddenBelow).toBe(out.totalRows - 3);
  });

  it('reports cursorRow -1 when the composer is not focused', () => {
    const out = layoutComposer({ buffer: many, cursor: 4, cols: 40, maxRows: 3, active: false });
    expect(out.cursorRow).toBe(-1);
  });

  it('an Infinity ceiling reduces the window to "show everything" (S4 revert)', () => {
    const out = layoutComposer({
      buffer: many,
      cursor: 0,
      cols: 40,
      maxRows: Number.POSITIVE_INFINITY,
      active: true,
    });
    expect(out.rows.length).toBe(out.totalRows);
    expect(out.hiddenAbove).toBe(0);
    expect(out.hiddenBelow).toBe(0);
  });
});

describe('layoutComposer — the caret (I-9)', () => {
  it('maps the caret to the cell holding the character it is on', () => {
    const out = layout('hello world', { cursor: 6, maxRows: 10 });
    expect(out.cursorRow).toBe(0);
    expect(out.cursorCol).toBe(6);
    const split = splitRowAtColumn(out.rows[0]!, out.cursorCol);
    expect(split.at?.text).toBe('w');
    expect(split.before.map((s) => s.text).join('')).toBe('hello ');
    expect(split.after.map((s) => s.text).join('')).toBe('orld');
  });

  it('counts CJK cells rather than characters', () => {
    const out = layout('中文ab', { cursor: 2, maxRows: 10 });
    expect(out.cursorCol).toBe(4);
    expect(splitRowAtColumn(out.rows[0]!, out.cursorCol).at?.text).toBe('a');
  });

  it('reports no cell when the caret sits past the last character', () => {
    const out = layout('ab', { cursor: 2, maxRows: 10 });
    expect(out.cursorCol).toBe(2);
    expect(splitRowAtColumn(out.rows[0]!, out.cursorCol).at).toBeNull();
  });

  it('puts the caret at the start of the wrapped row when it lands on a boundary', () => {
    const out = layoutComposer({
      buffer: 'x'.repeat(10),
      cursor: 5,
      cols: 5,
      maxRows: 10,
      active: true,
    });
    expect(out.totalRows).toBe(2);
    expect(out.cursorRow).toBe(1);
    expect(out.cursorCol).toBe(0);
  });
});

describe('layoutComposer — token segmentation', () => {
  const buffer = 'see [Pasted text #1 +12 lines] ok';

  it('marks the token run so the renderer can dim it', () => {
    const out = layout(buffer, { cols: 80, maxRows: 10 });
    expect(out.rows[0]!.segments.map((s) => [s.kind, s.text])).toEqual([
      ['text', 'see '],
      ['token', '[Pasted text #1 +12 lines]'],
      ['text', ' ok'],
    ]);
  });

  it('keeps the rendered text byte-identical to the buffer', () => {
    const out = layout(buffer, { cols: 12, maxRows: 20 });
    expect(out.rows.map(rowText).join('')).toBe(buffer);
  });
});

describe('caret visual boundaries (C-06/C-10)', () => {
  it('keeps all visual cursors in the clipped window across tabs, emoji and tokens', () => {
    const buffer = '\u4e2d\u{1f600}\t[Pasted text #1 +12 lines]\nend';
    for (let cursor = 0; cursor <= buffer.length; cursor += 1) {
      const out = layout(buffer, { cursor, cols: 8, maxRows: 2 });
      expect(out.cursorRow).toBeGreaterThanOrEqual(0);
      expect(out.cursorRow).toBeLessThan(out.rows.length);
      const row = out.rows[out.cursorRow]!;
      const split = splitRowAtColumn(row, out.cursorCol);
      const joined = [...split.before, ...(split.at ? [split.at] : []), ...split.after].map(s => s.text).join('');
      expect(joined).toBe(rowText(row));
      expect(out.cursorCol).toBeLessThan(8);
    }
  });

  it.each([-10, 1, 99])('normalizes an out-of-range or surrogate cursor %s', (cursor) => {
    const out = layout('\u{1f600}', { cursor });
    expect(out.cursorRow).toBe(0);
    expect(out.cursorCol).toBe(cursor > 2 ? 2 : 0);
  });

  it('budgets the caret at a full row followed by a newline', () => {
    const out = layout('abcd\nx', { cursor: 4, cols: 4 });
    expect(out.totalRows).toBe(3);
    expect(out.cursorRow).toBe(1);
    expect(out.cursorCol).toBe(0);
  });

  it.each([
    ['e\u0301x', 1, 'e\u0301', 0],
    ['\u0301ex', 0, '\u0301e', 0],
    ['xe\u0301', 2, 'e\u0301', 1],
    ['\u0301', 0, null, 0],
    ['\u0301\nq', 0, null, 0],
  ] as const)('groups zero-width text for %j', (buffer, cursor, expected, column) => {
    const out = layout(buffer, { cursor });
    const row = out.rows[out.cursorRow]!;
    const split = splitRowAtColumn(row, out.cursorCol);
    expect(out.cursorCol).toBe(column);
    expect(split.at?.text ?? null).toBe(expected);
    expect([...split.before, ...(split.at ? [split.at] : []), ...split.after].map(s => s.text).join('')).toBe(rowText(row));
  });
});
