import { describe, expect, it } from 'vitest';
import {
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
