import { describe, expect, it } from 'vitest';
import { thumbRange } from '../ui/layout/scroll-indicator.js';
import { createElement } from 'react';
import { render } from 'ink-testing-library';
import { ScrollIndicator } from '../ui/layout/ScrollIndicator.js';
import { getTheme } from '../ui/theme.js';
import { pickGlyphs } from '../ui/glyphs.js';

const CAPS = { colorLevel: 3 as const, unicode: true };
const THEME = getTheme('cool', CAPS);

/** One rendered frame of a `rows`-row rail carrying the given thumb. */
function railFrame(rows: number, thumb: ReturnType<typeof thumbRange>): string {
  const { lastFrame, unmount } = render(
    createElement(ScrollIndicator, { rows, thumb, theme: THEME, caps: CAPS }),
  );
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

function drawnLines(frame: string): string[] {
  return frame.split('\n').filter((line) => line.trim() !== '');
}

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


describe('ScrollIndicator rendering (defect 6)', () => {
  // The rail used to push one track cell per row even when `thumb === null`, so an
  // EMPTY transcript still drew a full-height column of track glyphs. The column
  // itself must stay reserved (the feedback loop at the top of the component), but
  // there is no position to mark when the content fits.
  it('draws no track cells when the content fits', () => {
    const glyphs = pickGlyphs(CAPS);
    const frame = railFrame(10, null);
    expect(frame).not.toContain(glyphs.scrollTrack);
    expect(frame).not.toContain(glyphs.scrollThumb);
    expect(drawnLines(frame)).toHaveLength(0);
  });

  it('still draws a full-height track and the thumb when the content overflows', () => {
    const glyphs = pickGlyphs(CAPS);
    const frame = railFrame(10, { start: 8, size: 2 });
    expect(drawnLines(frame)).toHaveLength(10);
    expect(drawnLines(frame).filter((line) => line.includes(glyphs.scrollTrack))).toHaveLength(8);
    expect(drawnLines(frame).filter((line) => line.includes(glyphs.scrollThumb))).toHaveLength(2);
  });
});

describe('draggable thumb geometry', () => {
  it('retains both endpoints at the one-row overflow boundary', () => {
    expect(thumbRange(20, 21, 1, true)).toEqual({ start: 0, size: 19 });
    expect(thumbRange(20, 21, 0, true)).toEqual({ start: 1, size: 19 });
    expect(thumbRange(1, 2, 0, true)).toEqual({ start: 0, size: 1 });
  });
});
