import { describe, expect, it } from 'vitest';
import { COOL, DARK_SURFACE, LIGHT, WARM, resolvePalette, type Palette } from '../ui/palettes.js';
import { THEME_NAMES } from '../config/schema.js';

// ---------------------------------------------------------------------------
// WCAG relative luminance / contrast. Hand-rolled and test-only: the spec's
// zero-new-dependency rule applies, and nothing in the shipped bundle needs it.
// ---------------------------------------------------------------------------

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const n = Number.parseInt(h, 16);
  const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

/** WCAG 2.1 contrast ratio, 1:1 (identical) to 21:1 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('contrastRatio (the measuring stick itself)', () => {
  it('agrees with the two ends of the scale', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
  });
});

describe('WARM readability (A-7)', () => {
  it('keeps every body-text tier at WCAG AA on the dark surface', () => {
    // Pinned so a later "just nudging the hue" cannot quietly make the answer
    // text unreadable. Body copy is the largest thing on screen.
    for (const field of ['assistant', 'muted', 'hintFg'] as const) {
      const ratio = contrastRatio(WARM[field], DARK_SURFACE);
      expect(ratio, `${field} = ${WARM[field]} -> ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it('keeps the primary and accent colours legible too', () => {
    for (const field of ['primary', 'accent'] as const) {
      expect(contrastRatio(WARM[field], DARK_SURFACE), field).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('gives the chip enough contrast to be read inverted', () => {
    expect(contrastRatio(WARM.chip.fg, WARM.chip.bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('resolvePalette', () => {
  it('maps auto and warm onto WARM (auto never guesses light)', () => {
    // Terminals cannot report their background reliably, and guessing wrong
    // makes the app unreadable rather than merely ugly.
    expect(resolvePalette('auto')).toBe(WARM);
    expect(resolvePalette('warm')).toBe(WARM);
  });

  it('keeps the v0.3.0 palette reachable, including under its legacy name', () => {
    expect(resolvePalette('cool')).toBe(COOL);
    expect(resolvePalette('dark')).toBe(COOL);
  });

  it('maps light onto LIGHT', () => {
    expect(resolvePalette('light')).toBe(LIGHT);
  });

  it('resolves every declared theme name to a complete palette', () => {
    const fields: (keyof Palette)[] = [
      'primary',
      'accent',
      'user',
      'assistant',
      'thinking',
      'muted',
      'border',
      'code',
      'focusBorder',
      'idleBorder',
      'hintFg',
      'logoShadow',
    ];
    for (const name of THEME_NAMES) {
      const p = resolvePalette(name);
      for (const f of fields) {
        expect(p[f], `${name}.${String(f)}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(p.gradient, name).toHaveLength(3);
    }
  });

  it('makes WARM and COOL visibly different, so `--theme cool` is worth having', () => {
    expect(WARM.primary).not.toBe(COOL.primary);
    expect(WARM.assistant).not.toBe(COOL.assistant);
  });
});
