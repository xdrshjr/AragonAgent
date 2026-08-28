import { describe, expect, it } from 'vitest';
import { thumbRange } from '../ui/layout/scroll-indicator.js';

describe('thumbRange', () => {
  it('returns null when the content fits', () => {
    expect(thumbRange(20, 20, 0)).toBeNull();
    expect(thumbRange(20, 5, 0)).toBeNull();
  });

  it('returns null for a degenerate viewport', () => {
    expect(thumbRange(0, 100, 0)).toBeNull();
    expect(thumbRange(-3, 100, 0)).toBeNull();
    expect(thumbRange(Number.NaN, 100, 0)).toBeNull();
  });

  it('parks the thumb at the bottom when pinned (offset 0)', () => {
    // `offset` counts rows hidden BELOW the viewport, so 0 means "showing the
    // newest output" — the thumb belongs at the bottom of the rail. Getting
    // this inverted is the single most likely mistake in the whole module.
    const t = thumbRange(10, 100, 0)!;
    expect(t.start + t.size).toBe(10);
  });

  it('parks the thumb at the top at maximum offset', () => {
    const t = thumbRange(10, 100, 90)!;
    expect(t.start).toBe(0);
  });

  it('moves the thumb monotonically upward as the offset grows', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let offset = 0; offset <= 90; offset += 10) {
      const t = thumbRange(10, 100, offset)!;
      expect(t.start).toBeLessThanOrEqual(previous);
      previous = t.start;
    }
  });

  it('never returns a zero-height thumb, however long the transcript', () => {
    // An indicator that vanishes exactly when the transcript is longest is
    // worse than no indicator at all.
    for (const content of [200, 2_000, 50_000]) {
      const t = thumbRange(10, content, 0)!;
      expect(t.size).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps start + size within the viewport for 1..500 rows of content', () => {
    for (let content = 1; content <= 500; content += 1) {
      for (const viewport of [1, 5, 12, 40]) {
        const t = thumbRange(viewport, content, Math.floor(content / 3));
        if (!t) continue;
        expect(t.start).toBeGreaterThanOrEqual(0);
        expect(t.size).toBeGreaterThanOrEqual(1);
        expect(t.start + t.size).toBeLessThanOrEqual(viewport);
      }
    }
  });

  it('clamps an out-of-range offset instead of drawing off the rail', () => {
    const high = thumbRange(10, 100, 9_999)!;
    expect(high.start).toBe(0);
    const low = thumbRange(10, 100, -50)!;
    expect(low.start + low.size).toBe(10);
  });
});
