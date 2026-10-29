/** The wait card's pure pieces (extended-job-wait AC-25). */

import { describe, expect, it } from 'vitest';
import { barCellsFor, formatWaitClock, percentOf, renderBar } from '../ui/layout/wait-bar.js';

const UNICODE = { gaugeFull: '#', gaugeEmpty: '-' };
const WIDE = { gaugeFull: '\u2588', gaugeEmpty: '\u2591' };

describe('renderBar', () => {
  it.each([0, -1, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY * 0])(
    '%s is an empty bar',
    (fraction) => {
      expect(renderBar(fraction, 10, UNICODE)).toBe('----------');
    },
  );

  it('keeps an unfinished bar from looking finished or untouched (I-8)', () => {
    expect(renderBar(0.001, 10, UNICODE)).toBe('#---------');
    expect(renderBar(0.999, 10, UNICODE)).toBe('#########-');
  });

  it.each([1, 1.5])('%s fills the bar', (fraction) => {
    expect(renderBar(fraction, 10, UNICODE)).toBe('##########');
  });

  it('is the same width for both glyph sets', () => {
    for (const f of [0, 0.3, 0.5, 0.97, 1]) {
      expect(renderBar(f, 17, WIDE)).toHaveLength(renderBar(f, 17, UNICODE).length);
    }
  });
});

describe('barCellsFor / percentOf / formatWaitClock', () => {
  it('scales with the terminal inside 8..28', () => {
    expect(barCellsFor(40)).toBe(12);
    expect(barCellsFor(20)).toBe(8);
    expect(barCellsFor(400)).toBe(28);
    expect(barCellsFor(Number.NaN)).toBe(8);
  });

  it('rounds a percentage DOWN so 99.9% never prints 100%', () => {
    expect(percentOf(0.999)).toBe(99);
    expect(percentOf(2)).toBe(100);
    expect(percentOf(Number.NaN)).toBe(0);
  });

  it('formats the same clocks the status bar uses', () => {
    expect(formatWaitClock(252_000)).toBe('4m12s');
    expect(formatWaitClock(600_000)).toBe('10m00s');
    expect(formatWaitClock(45_000)).toBe('45s');
  });
});
