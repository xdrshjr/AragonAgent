import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { LOGO_ART, LOGO_ART_WIDTH, pickHeaderVariant, pickOpenerVariant } from '../ui/Logo.js';
describe('LOGO_ART', () => {
  it('is six rows', () => {
    expect(LOGO_ART).toHaveLength(6);
  });

  it('renders every row at the same declared width', () => {
    for (const line of LOGO_ART) {
      expect(stringWidth(line)).toBe(LOGO_ART_WIDTH);
    }
    expect(LOGO_ART_WIDTH).toBe(52);
  });
});

describe('pickHeaderVariant', () => {
  it('is a constant-height bar above the column floor', () => {
    expect(pickHeaderVariant(100)).toBe('bar');
    expect(pickHeaderVariant(40)).toBe('bar');
  });

  it('falls back to mini below the bar column floor', () => {
    expect(pickHeaderVariant(39)).toBe('mini');
    expect(pickHeaderVariant(0)).toBe('mini');
  });

  it('never returns a multi-row tier, whatever the width (A-9)', () => {
    // The header taking 8 rows on an empty session and 1 afterwards is what made
    // the viewport non-monotonic and made the first submit reflow the screen.
    // Both `art` and `banner` are now unreachable from here by construction.
    const variants = new Set<string>();
    for (let cols = 0; cols <= 200; cols += 1) variants.add(pickHeaderVariant(cols));
    expect([...variants].sort()).toEqual(['bar', 'mini']);
  });

  it('always yields a variant, so row 1 always carries the brand (R1)', () => {
    for (const cols of [0, 10, 39, 40, 47, 48, 52, 200]) {
      expect(typeof pickHeaderVariant(cols)).toBe('string');
    }
  });
});

describe('pickOpenerVariant', () => {
  it('gives the full wordmark to a tall, wide viewport', () => {
    expect(pickOpenerVariant(20, 100)).toBe('art');
    // Each boundary alone knocks it down a tier.
    expect(pickOpenerVariant(13, 100)).toBe('banner');
    expect(pickOpenerVariant(20, 51)).toBe('banner');
  });

  it('drops the opener entirely below the banner column floor', () => {
    expect(pickOpenerVariant(20, 47)).toBe('none');
    expect(pickOpenerVariant(0, 10)).toBe('none');
  });

  it('keeps four columns of headroom above the art width (rename C2)', () => {
    // Pins the safety margin as an invariant. The art renders with
    // `wrap="truncate"`, so a threshold equal to the art width would let a
    // single upstream column shear the right edge off the `N`; degrading to
    // `banner` in that band is the intended behaviour, not a near-miss.
    expect(pickOpenerVariant(20, LOGO_ART_WIDTH + 3)).toBe('banner');
    expect(pickOpenerVariant(20, LOGO_ART_WIDTH + 4)).toBe('art');
  });

  it('is judged against VIEWPORT rows, not terminal rows', () => {
    // 14 viewport rows is the `art` floor. A 28-row terminal has 20 viewport
    // rows, so it qualifies -- under the old rule the same terminal paid for the
    // wordmark out of the frame budget and lost 5 rows of content doing it.
    expect(pickOpenerVariant(14, 100)).toBe('art');
    expect(pickOpenerVariant(13, 100)).toBe('banner');
  });
});
