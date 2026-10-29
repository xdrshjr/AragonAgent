import { describe, expect, it } from 'vitest';
import {
  COOL,
  DARK_SURFACE,
  LIGHT,
  LIGHT_SURFACE,
  WARM,
  resolvePalette,
  type Palette,
} from '../ui/palettes.js';
import { THEME_NAMES } from '../model/config/schema.js';

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

describe('selection highlight readability (tui-selection-and-scroll-follow §4.4.4)', () => {
  it('pins every palette at WCAG AA against ITS OWN background', () => {
    // ═══ AGAINST `selectionBg`, NOT `DARK_SURFACE` ═══
    //
    // The highlight strips the row's inner SGR and repaints the run in these two
    // colours, so the surface a selected glyph actually sits on is the selection
    // background. Measuring against the terminal's own background would pass a
    // pair that is unreadable in the only place it is ever used — and a selection
    // the user cannot read is a selection they cannot trust, on the one gesture
    // whose entire promise is "what you see is what you get".
    for (const [name, palette] of [
      ['WARM', WARM],
      ['COOL', COOL],
      ['LIGHT', LIGHT],
    ] as const) {
      const ratio = contrastRatio(palette.selectionFg, palette.selectionBg);
      expect(
        ratio,
        `${name}: ${palette.selectionFg} on ${palette.selectionBg} -> ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the highlight distinguishable from the surrounding surface', () => {
    // A selection background that matched the terminal's own would highlight
    // nothing at all.
    expect(contrastRatio(WARM.selectionBg, DARK_SURFACE)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(COOL.selectionBg, DARK_SURFACE)).toBeGreaterThanOrEqual(3);
  });

  it('declares both halves as hex in every palette', () => {
    // `highlight.ts` tests for a hex shape and falls back to reverse video
    // otherwise, so a colour NAME here would silently disable the theme colours
    // on every truecolor terminal.
    for (const name of THEME_NAMES) {
      const p = resolvePalette(name);
      expect(p.selectionBg, `${name}.selectionBg`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(p.selectionFg, `${name}.selectionFg`).toMatch(/^#[0-9a-f]{6}$/i);
    }
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

// ---------------------------------------------------------------------------
// governAccent (governance-mode section 10.7 / AC-30 / AC-47)
// ---------------------------------------------------------------------------

function hue(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return 0;
  const sector = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (sector * 60 + 360) % 360;
}

/** Circular hue distance in degrees, 0..180. */
function hueDistance(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
}

/**
 * THE COMPARISON SET, ONE ARRAY (spec 10.7): a new semantic colour joins the badge's
 * collision list by being added HERE, once. `user` and `toolDone` are in it because
 * score gains are drawn in `toolDone` right beside the badge; `noticeWarn` and
 * `noticeError` because a governance badge must never read as a warning or an error.
 */
const GOVERN_ACCENT_DISTINCT_FROM = [
  'primary', 'accent', 'user', 'toolDone', 'noticeWarn', 'noticeError',
] as const satisfies readonly (keyof Palette)[];

const GOVERN_MIN_HUE_DEGREES = 30;

/** Each palette against ITS OWN surface - LIGHT is dark-on-light, never `DARK_SURFACE`. */
const GOVERN_ACCENT_CASES = [
  ['WARM', WARM, DARK_SURFACE],
  ['COOL', COOL, DARK_SURFACE],
  ['LIGHT', LIGHT, LIGHT_SURFACE],
] as const;

describe('governAccent (AC-47)', () => {
  for (const [name, palette, surface] of GOVERN_ACCENT_CASES) {
    it(`${name}: reads at WCAG AA on its own surface`, () => {
      const ratio = contrastRatio(palette.governAccent, surface);
      expect(
        ratio,
        `${name}: ${palette.governAccent} on ${surface} -> ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: sits at least ${GOVERN_MIN_HUE_DEGREES} degrees from all six semantic hues`, () => {
      for (const field of GOVERN_ACCENT_DISTINCT_FROM) {
        const distance = hueDistance(palette.governAccent, palette[field]);
        expect(
          distance,
          `${name}.governAccent ${palette.governAccent} vs ${field} ${palette[field]} -> ` +
            `${distance.toFixed(1)} deg`,
        ).toBeGreaterThanOrEqual(GOVERN_MIN_HUE_DEGREES);
      }
    });

    it(`${name}: is a hex colour, so the 256-colour downsample can see it`, () => {
      expect(palette.governAccent).toMatch(/^#[0-9a-f]{6}$/i);
    });
  }

  it('measures LIGHT against its light surface, not the dark one', () => {
    // The trap the spec names: LIGHT's accent is a dark magenta, readable on white and
    // (by construction) NOT on the warm dark surface.
    expect(contrastRatio(LIGHT.governAccent, LIGHT_SURFACE)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(LIGHT.governAccent, DARK_SURFACE)).toBeLessThan(4.5);
  });
});
