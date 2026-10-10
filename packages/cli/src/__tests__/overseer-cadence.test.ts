import { describe, expect, it } from 'vitest';
import {
  clampNextCheckMs,
  nextOverseerLadderStepMs,
  resolveOverseerFirstCheckMs,
} from '../team/overseer.js';
import { TEAM_LIMITS } from '../team/limits.js';

/**
 * The cadence ladder's MATH (subagent-overseer-v2 D-2 / §7.1-1), asserted as
 * arithmetic rather than through timers: the MonitorLoop owns no policy of
 * its own, it only calls these two functions, so the numbers here are the
 * numbers the dispatch runs by.
 */
describe('resolveOverseerFirstCheckMs (D-8 priority)', () => {
  it('the dedicated key wins when set', () => {
    expect(
      resolveOverseerFirstCheckMs({ overseerIntervalMs: 120_000, subagentTimeoutMs: 45_000 }),
    ).toBe(120_000);
  });

  it('a positive subagentTimeoutMs is the compat source when the key is 0', () => {
    // Users who already treated the wall clock as a trigger point keep that
    // trigger - as the FIRST CHECK, never as a kill (D-4).
    expect(
      resolveOverseerFirstCheckMs({ overseerIntervalMs: 0, subagentTimeoutMs: 45_000 }),
    ).toBe(45_000);
  });

  it('the structural default when neither names one', () => {
    expect(resolveOverseerFirstCheckMs({ overseerIntervalMs: 0, subagentTimeoutMs: 0 })).toBe(
      TEAM_LIMITS.overseerDefaultCheckMs,
    );
  });
});

describe('nextOverseerLadderStepMs (D-2 growth and clamps)', () => {
  it('grows by the structural ratio', () => {
    expect(nextOverseerLadderStepMs(300_000)).toBe(480_000);
    expect(nextOverseerLadderStepMs(480_000)).toBe(768_000);
  });

  it('clamps from above at overseerNextCheckMaxMs', () => {
    expect(nextOverseerLadderStepMs(768_000)).toBe(900_000);
    expect(nextOverseerLadderStepMs(10_000_000)).toBe(900_000);
  });

  it('clamps from below at overseerNextCheckMinMs', () => {
    // Only reachable from a tiny configured base (a test or a very aggressive
    // user) - the floor keeps one bad value from turning into a busy-loop.
    expect(nextOverseerLadderStepMs(1)).toBe(TEAM_LIMITS.overseerNextCheckMinMs);
  });

  it('AC-11: a healthy slow child is looked at logarithmically - <= 8 checks in 60 min', () => {
    // Check moments with the shipped defaults: 300 / 780 / 1548 / 2448 / 3348s
    // ... every further rung is the 900 s cap.
    let step: number = TEAM_LIMITS.overseerDefaultCheckMs;
    let at = 0;
    const moments: number[] = [];
    for (let i = 0; i < 20 && at <= 3_600_000; i += 1) {
      at += step;
      moments.push(at);
      step = nextOverseerLadderStepMs(step);
    }
    expect(moments.slice(0, 5)).toEqual([300_000, 780_000, 1_548_000, 2_448_000, 3_348_000]);
    expect(moments.length).toBeLessThanOrEqual(8);
  });
});

describe('clampNextCheckMs (the model-chosen override)', () => {
  it('clamps into the same range the ladder uses', () => {
    expect(clampNextCheckMs(5)).toBe(TEAM_LIMITS.overseerNextCheckMinMs);
    expect(clampNextCheckMs(10_000_000)).toBe(TEAM_LIMITS.overseerNextCheckMaxMs);
    expect(clampNextCheckMs(240_000)).toBe(240_000);
    expect(clampNextCheckMs(-1)).toBeUndefined();
    expect(clampNextCheckMs('soon' as unknown)).toBeUndefined();
  });
});
