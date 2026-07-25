import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../ui/capabilities.js';
import { getTheme } from '../ui/theme.js';

describe('detectCapabilities', () => {
  it('forces monochrome for NO_COLOR and TERM=dumb', () => {
    expect(detectCapabilities({ NO_COLOR: '1' }).colorLevel).toBe(0);
    expect(detectCapabilities({ NO_COLOR: '' }).colorLevel).toBe(0);
    expect(detectCapabilities({ TERM: 'dumb' }).colorLevel).toBe(0);
  });

  it('reports truecolor for COLORTERM=truecolor', () => {
    expect(detectCapabilities({ COLORTERM: 'truecolor' }).colorLevel).toBe(3);
    expect(detectCapabilities({ COLORTERM: '24bit' }).colorLevel).toBe(3);
  });

  it('detects Unicode from a UTF locale or Windows Terminal, ASCII otherwise', () => {
    expect(detectCapabilities({ LANG: 'en_US.UTF-8' }).unicode).toBe(true);
    expect(detectCapabilities({ WT_SESSION: 'abc' }).unicode).toBe(true);
    expect(detectCapabilities({ TERM_PROGRAM: 'vscode' }).unicode).toBe(true);
    expect(detectCapabilities({}).unicode).toBe(false);
  });
});

describe('getTheme', () => {
  const caps3 = { colorLevel: 3 as const, unicode: true };

  it('dark and light palettes differ on at least one field', () => {
    const dark = getTheme('dark', caps3);
    const light = getTheme('light', caps3);
    expect(dark.primary).not.toBe(light.primary);
    expect(dark.diff.add).not.toBe(light.diff.add);
  });

  it('resolves auto to the dark palette deterministically', () => {
    const auto = getTheme('auto', caps3);
    const dark = getTheme('dark', caps3);
    expect(auto.primary).toBe(dark.primary);
  });

  it('swaps to ASCII symbols when unicode=false', () => {
    const ascii = getTheme('dark', { colorLevel: 3, unicode: false });
    expect(ascii.symbols.toolDone).toBe('[ok]');
    expect(ascii.symbols.gaugeFull).toBe('#');
    const uni = getTheme('dark', { colorLevel: 3, unicode: true });
    expect(uni.symbols.toolDone).toBe('✔');
    expect(uni.symbols.gaugeFull).toBe('█');
  });

  it('degrades to chalk-16 names at level 1 and to no color at level 0', () => {
    const level1 = getTheme('dark', { colorLevel: 1, unicode: true });
    expect(level1.primary).toBeTypeOf('string');
    expect(level1.primary).not.toContain('#');
    expect(level1.primary).toMatch(/^[a-zA-Z]+$/);

    const level0 = getTheme('dark', { colorLevel: 0, unicode: true });
    expect(level0.primary).toBeUndefined();
    expect(level0.gauge.low).toBeUndefined();
    expect(level0.gradient).toEqual([]);
  });

  it('keeps hex values at truecolor', () => {
    expect(getTheme('dark', caps3).primary).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
