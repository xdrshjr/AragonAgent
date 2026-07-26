import { describe, expect, it } from 'vitest';
import {
  decideRenderMode,
  frameHeight,
  FALLBACK_ROWS,
  MIN_FULLSCREEN_COLS,
  MIN_FULLSCREEN_ROWS,
} from '../ui/layout/frame.js';

const TTY = { isTTY: true, rows: 40, columns: 120 };

describe('frameHeight (invariant I-1)', () => {
  it('stays strictly below rows for every reachable terminal height', () => {
    // Lower bound MUST be 1, not MIN_FULLSCREEN_ROWS: rows < 12 is reachable at
    // run time via the resize placeholder screen (§4.11), and a clamp of 11 there
    // returns >= rows — exactly the ink.js:121 clearTerminal disaster.
    for (let r = 1; r <= 200; r += 1) {
      expect(frameHeight(r)).toBeLessThan(r);
    }
  });

  it('never returns a negative height', () => {
    for (let r = 1; r <= 200; r += 1) {
      expect(frameHeight(r)).toBeGreaterThanOrEqual(0);
    }
    // r = 1 is the one height where "< rows" forces a zero-row frame.
    expect(frameHeight(1)).toBe(0);
    expect(frameHeight(2)).toBe(1);
  });

  it('falls back to 24 rows when stdout reports no size', () => {
    expect(frameHeight(undefined)).toBe(FALLBACK_ROWS - 1);
    expect(frameHeight(undefined)).toBe(23);
    expect(frameHeight(0)).toBe(23);
  });
});

describe('decideRenderMode', () => {
  it('honors an explicit opt-out above everything else', () => {
    expect(decideRenderMode({ fullscreen: false }, {}, TTY)).toBe('inline');
  });

  it('never takes over a non-TTY stdout, even when forced', () => {
    expect(decideRenderMode({ fullscreen: true }, {}, { rows: 40, columns: 120 })).toBe('inline');
    expect(decideRenderMode({ fullscreen: true }, {}, undefined)).toBe('inline');
  });

  it('lets --fullscreen override every heuristic downgrade', () => {
    const forced = { fullscreen: true };
    expect(decideRenderMode(forced, { TERM: 'dumb' }, TTY)).toBe('fullscreen');
    expect(decideRenderMode(forced, { CI: 'true' }, TTY)).toBe('fullscreen');
    expect(decideRenderMode(forced, {}, { isTTY: true, rows: 4, columns: 120 })).toBe('fullscreen');
    expect(decideRenderMode(forced, {}, { isTTY: true, rows: 40, columns: 10 })).toBe('fullscreen');
  });

  it('downgrades on TERM=dumb, CI, and undersized terminals', () => {
    expect(decideRenderMode({}, { TERM: 'dumb' }, TTY)).toBe('inline');
    expect(decideRenderMode({}, { CI: '1' }, TTY)).toBe('inline');
    expect(
      decideRenderMode({}, {}, { isTTY: true, rows: MIN_FULLSCREEN_ROWS - 1, columns: 120 }),
    ).toBe('inline');
    expect(
      decideRenderMode({}, {}, { isTTY: true, rows: 40, columns: MIN_FULLSCREEN_COLS - 1 }),
    ).toBe('inline');
    expect(decideRenderMode({}, {}, { isTTY: true })).toBe('inline');
  });

  it('treats CI="" / CI=0 / CI=false as not-CI', () => {
    expect(decideRenderMode({}, { CI: '' }, TTY)).toBe('fullscreen');
    expect(decideRenderMode({}, { CI: '0' }, TTY)).toBe('fullscreen');
    expect(decideRenderMode({}, { CI: 'false' }, TTY)).toBe('fullscreen');
  });

  it('defaults to fullscreen on a healthy interactive terminal', () => {
    expect(decideRenderMode({}, {}, TTY)).toBe('fullscreen');
    expect(
      decideRenderMode({}, {}, { isTTY: true, rows: MIN_FULLSCREEN_ROWS, columns: MIN_FULLSCREEN_COLS }),
    ).toBe('fullscreen');
  });
});
