import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../ui/capabilities.js';
import { getTheme } from '../ui/theme.js';
import { clampTheme, isThemeName, THEME_NAMES } from '../config/schema.js';
import { COOL, WARM } from '../ui/palettes.js';

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

  it.each([['0', 0], ['false', 0], ['1', 1], ['2', 2], ['3', 3]] as const)(
    'honors FORCE_COLOR=%s over automatic truecolor detection', (force, level) => {
      expect(detectCapabilities({ COLORTERM: 'truecolor', FORCE_COLOR: force }).colorLevel).toBe(level);
    },
  );

  it('detects Unicode from a UTF locale or Windows Terminal, ASCII otherwise', () => {
    expect(detectCapabilities({ LANG: 'en_US.UTF-8' }).unicode).toBe(true);
    expect(detectCapabilities({ WT_SESSION: 'abc' }).unicode).toBe(true);
    expect(detectCapabilities({ TERM_PROGRAM: 'vscode' }).unicode).toBe(true);
    expect(detectCapabilities({}).unicode).toBe(false);
  });

  it('uses the same glyphs in AragonMesh as Windows Terminal without a locale hint', () => {
    const embedded = detectCapabilities({ TERM_PROGRAM: 'aragonmesh', COLORTERM: 'truecolor' });
    const manual = detectCapabilities({ WT_SESSION: 'abc', COLORTERM: 'truecolor' });
    expect(embedded).toEqual(manual);
    expect(getTheme('warm', embedded)).toEqual(getTheme('warm', manual));
    expect(getTheme('warm', embedded).symbols.boxStyle).toBe('round');
  });

  it.each([{ LANG: 'C' }, { LC_ALL: 'C' }, { LANG: 'zh_CN.GBK' }])('recognizes the embedded terminal independently of locale %j', locale => {
    expect(detectCapabilities({ ...locale, TERM_PROGRAM: 'aragonmesh' }).unicode).toBe(true);
  });
});

describe('getTheme', () => {
  const caps3 = { colorLevel: 3 as const, unicode: true };

  it('cool and light palettes differ on at least one field', () => {
    const cool = getTheme('cool', caps3);
    const light = getTheme('light', caps3);
    expect(cool.primary).not.toBe(light.primary);
    expect(cool.diff.add).not.toBe(light.diff.add);
  });

  it('resolves auto to the WARM palette deterministically', () => {
    expect(getTheme('auto', caps3).primary).toBe(WARM.primary);
    expect(getTheme('warm', caps3).primary).toBe(WARM.primary);
  });

  it('keeps the v0.3.0 palette reachable under its new name (R-4)', () => {
    expect(getTheme('cool', caps3).primary).toBe(COOL.primary);
    expect(COOL.primary).not.toBe(WARM.primary);
  });

  it('swaps to ASCII symbols when unicode=false', () => {
    const ascii = getTheme('cool', { colorLevel: 3, unicode: false });
    expect(ascii.symbols.toolDone).toBe('[ok]');
    expect(ascii.symbols.gaugeFull).toBe('#');
    const uni = getTheme('cool', { colorLevel: 3, unicode: true });
    expect(uni.symbols.toolDone).toBe('✔');
    expect(uni.symbols.gaugeFull).toBe('█');
  });

  it('degrades to chalk-16 names at level 1 and to no color at level 0', () => {
    const level1 = getTheme('cool', { colorLevel: 1, unicode: true });
    expect(level1.primary).toBeTypeOf('string');
    expect(level1.primary).not.toContain('#');
    expect(level1.primary).toMatch(/^[a-zA-Z]+$/);

    const level0 = getTheme('cool', { colorLevel: 0, unicode: true });
    expect(level0.primary).toBeUndefined();
    expect(level0.gauge.low).toBeUndefined();
    expect(level0.gradient).toEqual([]);
  });

  it('keeps hex values at truecolor', () => {
    expect(getTheme('cool', caps3).primary).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('degrades the full-screen chrome fields across every color depth', () => {
    const fields = ['focusBorder', 'idleBorder', 'hintFg', 'logoShadow'] as const;

    for (const level of [0, 1, 2, 3] as const) {
      const theme = getTheme('cool', { colorLevel: level, unicode: true });
      for (const field of fields) {
        if (level === 0) {
          expect(theme[field], field).toBeUndefined();
        } else if (level === 1) {
          expect(theme[field], field).toMatch(/^[a-zA-Z]+$/); // chalk-16 name
        } else {
          expect(theme[field], field).toMatch(/^#[0-9a-f]{6}$/i);
        }
      }
    }
  });

  it('gives dark and light distinct chrome colors', () => {
    const dark = getTheme('cool', caps3);
    const light = getTheme('light', caps3);
    expect(dark.focusBorder).not.toBe(light.focusBorder);
    expect(dark.hintFg).not.toBe(light.hintFg);
  });
});

describe('clampTheme (the single migration gate, R-P1-3 / A-13)', () => {
  it('maps the v0.3.0 name `dark` onto `cool`, idempotently', () => {
    // R-4: someone who explicitly chose dark in v0.3.0 must not have their
    // screen change colour. This is the ONLY place the mapping lives, because
    // config resolution, `config set theme` and `/theme` all funnel through it.
    expect(clampTheme('dark', 'auto')).toBe('cool');
    expect(clampTheme(clampTheme('dark', 'auto'), 'auto')).toBe('cool');
  });

  it('passes every current name through unchanged', () => {
    for (const name of THEME_NAMES) expect(clampTheme(name, 'auto')).toBe(name);
  });

  it('falls back silently on nonsense - it does not throw or exit', () => {
    expect(clampTheme('nonsense', 'auto')).toBe('auto');
    expect(clampTheme(undefined, 'warm')).toBe('warm');
    expect(clampTheme(42, 'light')).toBe('light');
  });

  it('does not consider `dark` a current theme name', () => {
    expect(isThemeName('dark')).toBe(false);
    expect(isThemeName('cool')).toBe(true);
  });
});
