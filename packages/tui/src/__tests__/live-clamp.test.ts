import { describe, expect, it } from 'vitest';
import { clampLiveText } from '../ui/live-clamp.js';

const rows = (text: string): number => (text.length === 0 ? 0 : text.split('\n').length);

describe('clampLiveText', () => {
  it('returns the text untouched when it already fits', () => {
    const text = 'a\nb\nc';
    const out = clampLiveText(text, 5);
    expect(out.text).toBe(text);
    expect(out.hiddenRows).toBe(0);
  });

  it('keeps the LAST rows, because that is where the cursor is', () => {
    const out = clampLiveText('1\n2\n3\n4\n5', 2);
    expect(out.text).toBe('4\n5');
    expect(out.hiddenRows).toBe(3);
  });

  it('accounts for every row: kept + hidden === original', () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    const out = clampLiveText(text, 20);
    expect(rows(out.text)).toBe(20);
    expect(rows(out.text) + out.hiddenRows).toBe(5000);
  });

  it('handles a single unterminated row', () => {
    expect(clampLiveText('only', 1)).toEqual({ text: 'only', hiddenRows: 0 });
  });

  it('degrades rather than throwing on a nonsense budget', () => {
    expect(clampLiveText('a\nb', 0)).toEqual({ text: '', hiddenRows: 2 });
    expect(clampLiveText('', 0)).toEqual({ text: '', hiddenRows: 0 });
    expect(clampLiveText('a\nb', Number.NaN).text).toBe('');
  });

  it('is idempotent', () => {
    const once = clampLiveText('1\n2\n3\n4\n5', 2);
    const twice = clampLiveText(once.text, 2);
    expect(twice.text).toBe(once.text);
    expect(twice.hiddenRows).toBe(0);
  });
});
