import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHROME_COLORS, TITLE_BAR_HEIGHT, chromeColors, isChromeTheme, overlayFor,
} from '../window-chrome.js';

const tokens = readFileSync(fileURLToPath(new URL('../../renderer/styles/tokens.css', import.meta.url)), 'utf8');

/** The value of `--name` inside the `:root[data-theme='<theme>']` block of tokens.css. */
function token(theme: string, name: string): string {
  const start = tokens.indexOf(`:root[data-theme='${theme}']`);
  expect(start, `tokens.css has a ${theme} block`).toBeGreaterThanOrEqual(0);
  const block = tokens.slice(start, tokens.indexOf('}', start));
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
  expect(match, `${name} in the ${theme} block`).not.toBeNull();
  return match![1]!.trim().toLowerCase();
}

describe('CHROME_COLORS mirrors tokens.css (AC-97)', () => {
  for (const theme of ['dark', 'light', 'warm'] as const) {
    it(`${theme}: bar / symbol / page equal --bg-surface-100 / --fg-default / --bg-default`, () => {
      expect(CHROME_COLORS[theme]).toEqual({
        bar: token(theme, '--bg-surface-100'),
        symbol: token(theme, '--fg-default'),
        page: token(theme, '--bg-default'),
      });
    });
  }

  it('the title bar height equals --titlebar-h', () => {
    expect(tokens).toMatch(new RegExp(`--titlebar-h:\\s*${TITLE_BAR_HEIGHT}px`));
  });
});

describe('chromeColors / isChromeTheme', () => {
  it('follows the OS only when no application theme is known', () => {
    expect(chromeColors(undefined, true)).toBe(CHROME_COLORS.dark);
    expect(chromeColors(undefined, false)).toBe(CHROME_COLORS.light);
  });

  it('accepts exactly the three themes', () => {
    for (const ok of ['dark', 'light', 'warm']) expect(isChromeTheme(ok)).toBe(true);
    for (const bad of ['cool', 'auto', '#fff', '', null, undefined, 1, {}]) expect(isChromeTheme(bad)).toBe(false);
  });
});

describe('overlayFor', () => {
  it('uses the APPLICATION theme, not the OS one (OS light + app dark stays dark)', () => {
    const overlay = overlayFor('dark', false, 1);
    expect(overlay.color).toBe(CHROME_COLORS.dark.bar);
    expect(overlay.symbolColor).toBe(CHROME_COLORS.dark.symbol);
    expect(overlay.backgroundColor).toBe(CHROME_COLORS.dark.page);
    expect(overlayFor('light', true, 1).color).toBe(CHROME_COLORS.light.bar);
  });

  it('falls back to the OS when the theme is unknown', () => {
    expect(overlayFor(undefined, true, 1).color).toBe(CHROME_COLORS.dark.bar);
    expect(overlayFor(undefined, false, 1).color).toBe(CHROME_COLORS.light.bar);
  });

  it('is one pixel shorter than the scaled title bar, so the divider line stays unbroken', () => {
    for (const zoom of [0.8, 1, 1.6]) {
      expect(overlayFor('warm', false, zoom).height).toBe(Math.round(40 * zoom) - 1);
    }
  });
});
