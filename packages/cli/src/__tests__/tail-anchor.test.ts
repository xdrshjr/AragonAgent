/**
 * Where the live tail anchors its content (tui-first-reply-bottom-aligned, plan A-prime).
 *
 * A property matrix rather than a rendered frame: `tail-anchor.ts` is pure and takes its
 * row heights as a callback, so every boundary that matters - an empty list, a zero
 * budget, a sum that lands exactly on the budget, and the safety margin - is one line
 * here instead of a Yoga layout. The rendered counterpart lives in
 * `scrollback-panels.test.tsx`.
 */

import { describe, expect, it } from 'vitest';
import type { Entry } from '../agent/reducer.js';
import { SCROLLBACK_LIMITS } from '../ui/scrollback/limits.js';
import { tailAnchor } from '../ui/scrollback/tail-anchor.js';

const SLACK = SCROLLBACK_LIMITS.tailAnchorSlackRows;

function user(id: string): Entry {
  return { id, kind: 'user', text: `message ${id}` };
}

/** `count` entries that each claim `rows` rows. */
function block(count: number, rows: number): Entry[] {
  return Array.from({ length: count }, (_, index) => user(`u${index}-${rows}`));
}

const flat = (): number => 1;

describe('tailAnchor', () => {
  it('anchors an empty list to the top, where nothing can be clipped', () => {
    expect(tailAnchor([], 24, flat)).toBe('top');
    expect(tailAnchor([], 0, flat)).toBe('top');
  });

  it('falls back to the bottom when the content does not fit, margin included', () => {
    const budget = 24;
    // `usable` is the largest sum that still fits: it must leave the margin free.
    const usable = budget - SLACK;
    expect(tailAnchor(block(usable, 1), budget, flat)).toBe('top');
    // One row more than that and the box would clip its NEWEST row, so it bottoms out.
    expect(tailAnchor(block(usable + 1, 1), budget, flat)).toBe('bottom');
  });

  it('keeps the slack on the bottom side: the budget alone is already too tight', () => {
    // The margin is spent BEFORE the box is full, deliberately - a wrong estimate must
    // cost a stacked frame, never a clipped newest row.
    expect(tailAnchor(block(24, 1), 24, flat)).toBe('bottom');
    expect(tailAnchor(block(24 - SLACK, 1), 24, flat)).toBe('top');
    expect(tailAnchor(block(24 - SLACK + 1, 1), 24, flat)).toBe('bottom');
  });

  it('bottoms out immediately on a zero, negative or unusable budget', () => {
    expect(tailAnchor([user('u1')], 0, flat)).toBe('bottom');
    expect(tailAnchor([user('u1')], SLACK, flat)).toBe('bottom');
    expect(tailAnchor([user('u1')], SLACK + 1, flat)).toBe('top');
    expect(tailAnchor([user('u1')], -5, flat)).toBe('bottom');
    expect(tailAnchor([user('u1')], Number.NaN, flat)).toBe('bottom');
  });

  it('uses the injected row heights instead of any table of its own', () => {
    const budget = 24;
    // The same single entry is 1 row or 20 rows depending only on the callback, which is
    // the whole point of injecting it: this module never imports a height estimator.
    expect(tailAnchor(block(1, 1), budget, () => 1)).toBe('top');
    expect(tailAnchor(block(1, 1), budget, () => 20)).toBe('top');
    // Three tall entries (60 rows) overflow the same box the short ones fit in.
    expect(tailAnchor(block(3, 1), budget, () => 20)).toBe('bottom');
  });

  it('stops as soon as the budget is exhausted, so a huge list costs two lookups', () => {
    const entries = block(500, 1);
    let calls = 0;
    const rowOf = (): number => {
      calls += 1;
      return 10;
    };
    expect(tailAnchor(entries, 24, rowOf)).toBe('bottom');
    expect(calls).toBe(3);
  });

  it('a per-entry estimate of zero can never make a full box overflow', () => {
    // Guards the arithmetic: excluded-style entries contribute nothing, so a list of
    // them stays top-anchored however long it is.
    expect(tailAnchor(block(50, 1), 24, () => 0)).toBe('top');
  });
});
