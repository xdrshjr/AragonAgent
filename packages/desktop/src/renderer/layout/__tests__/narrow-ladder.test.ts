import { describe, expect, it } from 'vitest';
import {
  INSPECTOR_MIN, MAIN_MIN, RAIL_WIDTH, RESIZER_WIDTH, computeLayoutTier, inspectorMaxWidth, widthNeeded,
} from '../layout-tier.js';

describe('computeLayoutTier', () => {
  it('needs rail + sidebar + inspector floor + main floor for tier 1, and drops the sidebar for tier 2', () => {
    expect(widthNeeded(true, 260)).toBe(RAIL_WIDTH + 260 + RESIZER_WIDTH + INSPECTOR_MIN + MAIN_MIN);
    expect(widthNeeded(false, 260)).toBe(RAIL_WIDTH + INSPECTOR_MIN + MAIN_MIN); // 728
    expect(widthNeeded(false, 260)).toBe(728);
  });

  it('the boundaries are exact', () => {
    const need1 = widthNeeded(true, 260);
    const need2 = widthNeeded(false, 260);
    expect(computeLayoutTier(need1, 260, true, false)).toBe(1);
    expect(computeLayoutTier(need1 - 1, 260, true, false)).toBe(2);
    expect(computeLayoutTier(need2, 260, true, false)).toBe(2);
    expect(computeLayoutTier(need2 - 1, 260, true, false)).toBe(3);
  });

  it('the threshold follows the sidebar width instead of a fixed number (RV-1)', () => {
    // 988 CSS px holds a 200px sidebar + inspector, but not a 260px one (the old fixed 960 was wrong for both).
    expect(computeLayoutTier(948, 200, true, false)).toBe(1);
    expect(computeLayoutTier(948, 260, true, false)).toBe(2);
    expect(computeLayoutTier(948, 420, true, false)).toBe(2);
    expect(widthNeeded(true, 420)).toBeGreaterThan(widthNeeded(true, 200));
  });

  it('an 800px window at zoom 1.6 (500 CSS px) is tier 3', () => {
    expect(computeLayoutTier(800 / 1.6, 260, true, false)).toBe(3);
  });

  it('an 800px window at zoom 1.0 with the default sidebar is tier 2', () => {
    expect(computeLayoutTier(800, 260, true, false)).toBe(2);
  });

  it('is always tier 1 without an inspector, in settings, or before the first measurement', () => {
    expect(computeLayoutTier(300, 260, false, false)).toBe(1);
    expect(computeLayoutTier(300, 260, true, true)).toBe(1);
    expect(computeLayoutTier(0, 260, true, false)).toBe(1);
  });
});

describe('inspectorMaxWidth', () => {
  it('is what is left after the rail, a visible sidebar and the main floor, capped at 640', () => {
    expect(inspectorMaxWidth(1600, true, 260, 1)).toBe(640);
    expect(inspectorMaxWidth(1100, true, 260, 1)).toBe(1100 - RAIL_WIDTH - 260 - RESIZER_WIDTH - MAIN_MIN);
    expect(inspectorMaxWidth(1100, false, 260, 2)).toBe(640);
  });

  it('never goes below the tier floor', () => {
    expect(inspectorMaxWidth(500, false, 260, 3)).toBe(280);
    expect(inspectorMaxWidth(600, true, 420, 1)).toBe(INSPECTOR_MIN);
  });
});
