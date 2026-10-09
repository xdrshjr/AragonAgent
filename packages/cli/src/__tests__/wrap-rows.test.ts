import { describe, expect, it } from 'vitest';
import { wrapToRows } from '../ui/layout/wrap-rows.js';
import stringWidth from 'string-width';

describe('wrapToRows (plan-mode §6.6 / P1-3)', () => {
  it.each(['甲'.repeat(20) + '重要删除目标', 'e\u0301👨‍👩‍👧‍👦🇨🇳👍🏽'.repeat(8)])(
    'wraps Unicode by display columns without splitting graphemes: %s', text => {
      const rows = wrapToRows(text, 9);
      expect(rows.join('')).toBe(text);
      for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(9);
      const segment = (value: string) => [...new Intl.Segmenter(undefined,
        { granularity: 'grapheme' }).segment(value)].map(part => part.segment);
      expect(rows.flatMap(segment)).toEqual(segment(text));
    });

  it('counts the display width when joining separate words', () => {
    expect(wrapToRows('你好 世界 abc', 7)).toEqual(['你好', '世界', 'abc']);
  });

  it('returns [] for empty input so callers need no emptiness branch', () => {
    expect(wrapToRows('', 20)).toEqual([]);
    expect(wrapToRows(undefined as unknown as string, 20)).toEqual([]);
  });

  it('breaks on spaces and never exceeds the width', () => {
    const rows = wrapToRows('the quick brown fox jumps over the lazy dog', 12);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(12);
    expect(rows.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('leaves an exact-width line alone', () => {
    expect(wrapToRows('abcde fghij', 11)).toEqual(['abcde fghij']);
  });

  it('hard-breaks a single token longer than the width', () => {
    // A path or a URL must not be dropped and cannot be wrapped politely.
    const rows = wrapToRows('src/a/very/long/path/that/never/breaks.ts', 10);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(10);
    expect(rows.join('')).toBe('src/a/very/long/path/that/never/breaks.ts');
  });

  it('lets a following word join the tail of a hard-broken token', () => {
    const rows = wrapToRows('aaaaaaaa bb', 4);
    expect(rows).toEqual(['aaaa', 'aaaa', 'bb']);
  });

  it('honours existing newlines as paragraph breaks, blank lines included', () => {
    // A blank line in the source is a deliberate separator; collapsing it would
    // run a plan's summary into its steps.
    expect(wrapToRows('one\n\ntwo', 10)).toEqual(['one', '', 'two']);
  });

  it('turns a 600-character summary into many rows, not one truncated line', () => {
    // The exact failure this module exists to prevent: mode A slices by ELEMENT,
    // so a paragraph handed over as a single <Text> renders as one clipped line
    // and the frame's position indicator becomes a false statement.
    const summary = Array.from({ length: 100 }, () => 'word').join(' ');
    const rows = wrapToRows(summary, 40);
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(40);
  });

  it('treats a zero or negative width as 1 rather than looping forever', () => {
    expect(wrapToRows('ab', 0)).toEqual(['a', 'b']);
    expect(wrapToRows('ab', -5)).toEqual(['a', 'b']);
  });
});
