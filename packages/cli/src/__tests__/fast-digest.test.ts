/**
 * `buildReviewDigest` (fast-model-tier §3.5.2 / D-6 / R-2 / §8.1).
 *
 * THE BOUND IS THE ECONOMIC ARGUMENT. A review whose input grew with the session
 * would cost more than the main-model turn it is reviewing — the exact inversion
 * this feature exists to prevent — so `digestMaxChars` is asserted directly, and
 * so is the rule that the NEWEST frames survive the trimming.
 */

import { describe, expect, it } from 'vitest';
import { buildReviewDigest } from '../fast/digest.js';
import { FAST_LIMITS } from '../fast/limits.js';
import type { TurnFrame } from '../fast/types.js';

function frame(over: Partial<TurnFrame> = {}): TurnFrame {
  return {
    index: 1,
    textTail: '',
    tools: [],
    sealed: true,
    ...over,
  };
}

describe('buildReviewDigest', () => {
  it('includes SEALED frames only (RV-2 / D-22)', () => {
    const out = buildReviewDigest({
      frames: [
        frame({ index: 1, textTail: 'settled work' }),
        frame({ index: 2, textTail: 'still writing', sealed: false }),
      ],
      goal: 'g',
      contextTurns: 5,
    });
    expect(out).toContain('settled work');
    // A frame that is still accumulating is never half-rendered into a prompt.
    expect(out).not.toContain('still writing');
  });

  it('carries the triggering turn`s isError and ms, which only exist once sealed', () => {
    const out = buildReviewDigest({
      frames: [
        frame({
          index: 3,
          tools: [{ name: 'bash', arg: 'npm test', isError: true, ms: 1200 }],
        }),
      ],
      goal: 'ship it',
      contextTurns: 3,
    });
    // AC-32: the reviewer must not be asked whether the run is on track while
    // being denied the fact that the last batch just failed.
    expect(out).toContain('bash(npm test)');
    expect(out).toContain('FAILED');
    expect(out).toContain('1200ms');
  });

  it('windows to `contextTurns`, newest first', () => {
    const frames = [1, 2, 3, 4, 5].map((i) => frame({ index: i, textTail: `turn-${i}` }));
    const out = buildReviewDigest({ frames, goal: 'g', contextTurns: 2 });
    expect(out).toContain('turn-4');
    expect(out).toContain('turn-5');
    expect(out).not.toContain('turn-3');
  });

  it('states the goal, clamped', () => {
    const out = buildReviewDigest({ frames: [], goal: 'x'.repeat(2000), contextTurns: 3 });
    expect(out.startsWith('Goal: ')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(FAST_LIMITS.digestMaxChars);
  });

  it('says so plainly when no goal was captured', () => {
    expect(buildReviewDigest({ frames: [], goal: '', contextTurns: 3 })).toContain('(not captured)');
  });

  it('holds the bound with 12 frames of 5000 characters each, keeping the newest', () => {
    const frames = Array.from({ length: 12 }, (_, i) =>
      frame({ index: i + 1, textTail: `${i + 1}:${'y'.repeat(5000)}` }),
    );
    const out = buildReviewDigest({ frames, goal: 'g', contextTurns: 10 });
    expect(out.length).toBeLessThanOrEqual(FAST_LIMITS.digestMaxChars);
    // Trimming drops the OLDEST frame and rebuilds: the reviewer's question is
    // about what just happened, so losing the tail would hand it the beginning
    // of a run and ask about the end of one.
    expect(out).toContain('Turn 12');
  });

  it('never reads message history - it has no way to (D-6)', () => {
    // A structural assertion rather than a behavioural one: the function's whole
    // input is a frame ring, a goal string and a number. There is no seam
    // through which 240 KB of file bodies could reach it.
    expect(buildReviewDigest.length).toBe(1);
    const out = buildReviewDigest({ frames: [], goal: 'g', contextTurns: 3 });
    expect(out.length).toBeLessThan(FAST_LIMITS.digestMaxChars);
  });
});
