import { describe, expect, it } from 'vitest';
import { BUDGETS, frameDurations, percentile, slope, verdict } from '../scripts/lib/bench-math.mjs';

describe('percentile', () => {
  it('uses nearest rank', () => {
    const samples = Array.from({ length: 100 }, (_unused, index) => index + 1);
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile(samples, 100)).toBe(100);
    expect(percentile([5], 95)).toBe(5);
  });
  it('is NaN, not 0, for no data', () => {
    expect(Number.isNaN(percentile([], 95))).toBe(true);
  });
  it('does not depend on the order of the input', () => {
    expect(percentile([9, 1, 5, 3, 7], 50)).toBe(5);
  });
});

describe('verdict', () => {
  it.each([[400, 'green'], [401, 'amber'], [480, 'amber'], [481, 'red']])('%s ms against a 400 ms budget is %s', (value, expected) => {
    expect(verdict(value, 400)).toBe(expected);
  });
  it('treats a missing measurement as red', () => {
    expect(verdict(Number.NaN, 400)).toBe('red');
    expect(verdict(Number.POSITIVE_INFINITY, 400)).toBe('red');
  });
});

describe('slope and frameDurations', () => {
  it('recovers a straight line and is flat for a constant', () => {
    expect(slope([[0, 10], [1, 12], [2, 14]])).toBeCloseTo(2);
    expect(slope([[0, 5], [1, 5], [2, 5]])).toBe(0);
    expect(slope([[0, 1]])).toBe(0);
  });
  it('turns timestamps into durations', () => {
    expect(frameDurations([0, 16, 33, 50])).toEqual([16, 17, 17]);
    expect(frameDurations([1])).toEqual([]);
  });
});

describe('budgets', () => {
  it('are the numbers the spec states', () => {
    expect(BUDGETS).toMatchObject({ readyToShowP95Ms: 400, firstInputP95Ms: 1500, frameP95Ms: 16.7, longTaskMaxMs: 100, soakSlopeMbPerMin: 2 });
  });
});
