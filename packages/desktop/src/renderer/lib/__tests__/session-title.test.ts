import { describe, expect, it } from 'vitest';
import { TITLE_ROW_MAX, TITLE_TOOLTIP_MAX, displayTitle } from '../session-title.js';

describe('displayTitle', () => {
  it('collapses newlines, tabs, NBSP and runs of spaces into single spaces', () => {
    expect(displayTitle('之前的任务：\n  给这个项目\t添加\u00a0\u00a0用户系统\r\n', 'x', 200)).toBe('之前的任务： 给这个项目 添加 用户系统');
  });

  it('falls back for empty, whitespace-only, null and undefined', () => {
    for (const raw of ['', '   \n\t ', null, undefined]) expect(displayTitle(raw, 'Untitled', 200)).toBe('Untitled');
  });

  it('leaves a short title untouched', () => {
    expect(displayTitle('hello', 'x', 200)).toBe('hello');
  });

  it('cuts a 5000-character title to the row / tooltip budgets', () => {
    const long = 'a'.repeat(5000);
    expect([...displayTitle(long, 'x', TITLE_ROW_MAX)]).toHaveLength(TITLE_ROW_MAX + 1); // + the ellipsis
    expect(displayTitle(long, 'x', TITLE_ROW_MAX).endsWith('…')).toBe(true);
    expect([...displayTitle(long, 'x', TITLE_TOOLTIP_MAX)]).toHaveLength(TITLE_TOOLTIP_MAX + 1);
  });

  it('never splits a surrogate pair', () => {
    const emoji = '😀'.repeat(300);
    const cut = displayTitle(emoji, 'x', 5);
    expect(cut).toBe('😀😀😀😀😀…');
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  });

  it('does not add an ellipsis at exactly the limit', () => {
    expect(displayTitle('a'.repeat(200), 'x', 200)).toBe('a'.repeat(200));
  });
});
