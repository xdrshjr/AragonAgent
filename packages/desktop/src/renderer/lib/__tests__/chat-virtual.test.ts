import { describe, expect, it } from 'vitest';
import { initialViewState, viewReducer } from '@aragon-agent/tui/model/agent/reducer';
import { buildOffsets, estimateHeight, rowAt, visibleRange } from '../chat-virtual.js';

describe('virtual window arithmetic', () => {
  const heights = [100, 50, 200, 80, 120];
  const offsets = buildOffsets(heights);

  it('builds prefix sums with the total last', () => {
    expect(offsets).toEqual([0, 100, 150, 350, 430, 550]);
  });

  it('finds the row containing a y offset', () => {
    expect(rowAt(offsets, 0)).toBe(0);
    expect(rowAt(offsets, 99)).toBe(0);
    expect(rowAt(offsets, 100)).toBe(1);
    expect(rowAt(offsets, 349)).toBe(2);
    expect(rowAt(offsets, 9999)).toBe(4);
  });

  it('returns the rows intersecting the viewport plus overscan', () => {
    expect(visibleRange(offsets, 160, 100, 0)).toEqual({ start: 2, end: 3 });
    expect(visibleRange(offsets, 160, 100, 120)).toEqual({ start: 0, end: 4 });
  });

  it('clamps at both ends and handles an empty list', () => {
    expect(visibleRange(offsets, 0, 100, 1000)).toEqual({ start: 0, end: 5 });
    expect(visibleRange([0], 0, 100, 100)).toEqual({ start: 0, end: 0 });
  });

  it('renders a bounded number of rows out of 5,000', () => {
    const many = buildOffsets(Array.from({ length: 5000 }, () => 60));
    const range = visibleRange(many, 150_000, 800, 800);
    expect(range.end - range.start).toBeLessThan(45);
    expect(range.start).toBeGreaterThan(2000);
  });

  it('estimates a height for an entry', () => {
    const state = viewReducer(initialViewState(), { type: 'submit', text: 'hello' });
    expect(estimateHeight(state.entries[0]!)).toBeGreaterThan(0);
  });
});
