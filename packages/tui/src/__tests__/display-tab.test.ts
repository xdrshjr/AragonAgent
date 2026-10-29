/**
 * TAB expansion by DISPLAY COLUMN (fix A'-2 of paste-control-sequence-residue).
 *
 * The defect this guards is not "TAB looks odd": it is that three owners read
 * one byte three ways, so a pasted table was laid out differently in the draft,
 * in the transcript and in the exit replay. The last case here is the DoD
 * itself -- "the row before send and the row after send are character-identical"
 * -- written against the REAL composer layout function rather than a copy of it.
 */

import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { TAB_WIDTH, expandTabs } from '../ui/display-tab.js';
import { TAB_WIDTH as TOOLS_TAB_WIDTH } from '../model/tools/terminal-output.js';
import { layoutComposer } from '../ui/composer-rows.js';
import { renderTranscriptText } from '../ui/transcript-text.js';
import { pickGlyphs } from '../ui/glyphs.js';
import { EMPTY_USAGE_TOTAL } from '../model/agent/reducer.js';

const rowText = (row: { segments: { text: string }[] }): string =>
  row.segments.map((segment) => segment.text).join('');

describe('expandTabs', () => {
  it('advances to the next tab stop, measured from the given column', () => {
    expect(expandTabs('a\tb')).toBe(`a${' '.repeat(7)}b`);
    expect(expandTabs('\tX')).toBe(`${' '.repeat(8)}X`);
    expect(expandTabs('ab\tcd', 2)).toBe(`ab${' '.repeat(4)}cd`);
    expect(expandTabs('ab\tcd', 5)).toBe(`ab${' '.repeat(1)}cd`);
    // A tab exactly ON a stop still advances a whole stop, like a terminal.
    expect(expandTabs('12345678\tX')).toBe(`12345678${' '.repeat(8)}X`);
  });

  it('counts a CJK glyph as TWO columns, which is what left tables misaligned', () => {
    // Measured failure of the code-unit version: it produced 5 spaces (11
    // columns of painted text) where the terminal paints the `X` at column 9.
    expect(expandTabs('中文\tX')).toBe(`中文${' '.repeat(4)}X`);
    expect(stringWidth(expandTabs('中文\tX'))).toBe(9);
  });

  it('resets the column at every line break', () => {
    expect(expandTabs('a\tb\n\tc')).toBe(`a${' '.repeat(7)}b\n${' '.repeat(8)}c`);
  });

  it('is a no-op when there is no TAB, and keeps everything else byte-identical', () => {
    expect(expandTabs('plain text')).toBe('plain text');
    expect(expandTabs('CJK 中文 emoji \u{1F600}')).toBe('CJK 中文 emoji \u{1F600}');
    expect(expandTabs('')).toBe('');
  });

  it('advances an emoji ZWJ cluster ONCE, not once per code point', () => {
    expect(expandTabs('\u{1F469}\u200D\u{1F4BB}\tX'))
      .toBe(`\u{1F469}\u200D\u{1F4BB}${' '.repeat(6)}X`);
  });
});

describe('one tab stop, two modules (the composer-limits precedent)', () => {
  it('agrees with `tools/terminal-output.ts`', () => {
    // The number is duplicated rather than imported so `ui/` keeps no dependency
    // on `tools/`, exactly as `composer-limits.ts` copies `budget.ts`'s row
    // ceiling. This assertion is what stops the copies drifting.
    expect(TAB_WIDTH).toBe(TOOLS_TAB_WIDTH);
    expect(TAB_WIDTH).toBe(8);
  });
});

describe('DoD: the draft row and the stored row are character-identical', () => {
  it.each([
    ['ASCII indent', 'a\tb\n12\tX'],
    ['a CJK header row', '中文\tX\n中文中文\tY'],
    ['a TSV table', 'name\tqty\tprice\nbolt\t2\t0.40'],
  ])('composer rows equal the transcript rows (%s)', (_name, buffer) => {
    // What the user sees BEFORE sending: the real composer layout.
    const layout = layoutComposer({ buffer, cursor: 0, cols: 60, maxRows: 8, active: false });
    const draft = layout.rows.map(rowText);

    // What the user sees AFTER sending: `UserEntry`'s per-line expansion, and
    // the exit replay's `block()`, which both go through `expandTabs`.
    const sent = buffer.split('\n').map((line) => expandTabs(line));
    expect(draft.join('\n')).toBe(sent.join('\n'));

    const replay = renderTranscriptText([{ id: 'e1', kind: 'user', text: buffer }], {
      glyphs: pickGlyphs({ colorLevel: 0, unicode: true } as never),
      usageTotal: EMPTY_USAGE_TOTAL,
      model: 'm',
      provider: 'p',
      elapsedMs: 0,
    });
    for (const line of sent) expect(replay).toContain(line);
  });
});
