/**
 * The row painter (tui-selection-and-scroll-follow §4.4.4).
 */

import { describe, expect, it } from 'vitest';
import stripAnsi from 'strip-ansi';
import { paintRow, selectionOpen } from '../ui/selection/highlight.js';
import { columnsOf } from '../ui/selection/selection.js';
import { getTheme } from '../ui/theme.js';

const TRUECOLOR = { colorLevel: 3, unicode: true } as const;
const ANSI16 = { colorLevel: 1, unicode: true } as const;
const MONO = { colorLevel: 0, unicode: false } as const;
const REVERSE = '\x1b[7m';

describe('selectionOpen', () => {
  it('emits a truecolor pair from the theme when the terminal can take it', () => {
    const open = selectionOpen(getTheme('cool', TRUECOLOR), TRUECOLOR);
    expect(open).toMatch(/^\x1b\[48;2;\d+;\d+;\d+m\x1b\[38;2;\d+;\d+;\d+m$/);
  });

  it('falls back to reverse video below ansi-256, and on a monochrome terminal', () => {
    // `getTheme` has already degraded the palette to chalk colour NAMES by then,
    // and a name is not an escape sequence. Reverse video is what a terminal that
    // shallow would render anyway, and it is what the emulator's own selection
    // looks like.
    expect(selectionOpen(getTheme('cool', ANSI16), ANSI16)).toBe(REVERSE);
    expect(selectionOpen(getTheme('cool', MONO), MONO)).toBe(REVERSE);
  });
});

describe('paintRow', () => {
  it('T-6: an inner SGR reset does not punch a hole in the highlight', () => {
    // ═══ STRIPPING SGR INSIDE THE SELECTION IS NOT LAZINESS ═══
    //
    // `Markdown` and `cli-highlight` emit `\x1b[0m` constantly. Left in place it
    // would CANCEL the highlight attribute mid-run, and the user would see the
    // selection break apart across a syntax-highlighted line. Terminals repaint
    // selected text in the selection's own colours for exactly this reason.
    const line = 'aa\x1b[31mbb\x1b[0mcc';
    const painted = paintRow(line, 0, 6, REVERSE);
    const start = painted.indexOf(REVERSE) + REVERSE.length;
    const end = painted.indexOf('\x1b[0m', start);
    const inside = painted.slice(start, end);
    expect(inside).toBe('aabbcc');
    expect(inside).not.toContain('\x1b');
  });

  it('keeps the original SGR on the text OUTSIDE the range', () => {
    const line = '\x1b[31mred\x1b[0m plain \x1b[32mgreen\x1b[0m';
    const painted = paintRow(line, 4, 9, REVERSE);
    expect(painted.startsWith('\x1b[31mred\x1b[0m')).toBe(true);
    expect(painted).toContain('\x1b[32mgreen');
    // The visible text is untouched, whatever the escapes did.
    expect(stripAnsi(painted)).toBe(stripAnsi(line));
  });

  it('T-7: pads a short line to the right edge of the range', () => {
    // What gives a MULTI-ROW selection a straight right edge instead of a ragged
    // one that follows the text.
    const painted = paintRow('hi', 0, 10, REVERSE);
    const start = painted.indexOf(REVERSE) + REVERSE.length;
    const end = painted.indexOf('\x1b[0m', start);
    expect(painted.slice(start, end)).toBe('hi        ');
    expect(columnsOf(painted.slice(start, end))).toBe(10);
  });

  it('returns the line untouched for a degenerate range', () => {
    expect(paintRow('hello', 3, 3, REVERSE)).toBe('hello');
    expect(paintRow('hello', 4, 1, REVERSE)).toBe('hello');
  });

  it('measures the pad in COLUMNS, so a CJK row is not over-padded', () => {
    // A third width oracle here is how the right edge ends up ragged on exactly
    // the rows the column arithmetic was written for (I-12).
    const painted = paintRow('你好', 0, 6, REVERSE);
    const start = painted.indexOf(REVERSE) + REVERSE.length;
    const end = painted.indexOf('\x1b[0m', start);
    expect(columnsOf(painted.slice(start, end))).toBe(6);
  });
});
