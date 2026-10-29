import { describe, expect, it } from 'vitest';
import {
  applyScroll,
  applyScrollTimes,
  clampScroll,
  isPinnedToBottom,
  pageSize,
  type ScrollIntent,
  type ViewportMetrics,
} from '../ui/layout/scroll.js';

const metrics = (viewport: number, content: number): ViewportMetrics => ({ viewport, content });

describe('clampScroll', () => {
  it('clamps into [0, overflowLines]', () => {
    expect(clampScroll(-5, 10)).toBe(0);
    expect(clampScroll(0, 10)).toBe(0);
    expect(clampScroll(7, 10)).toBe(7);
    expect(clampScroll(99, 10)).toBe(10);
  });

  it('collapses to 0 when there is nothing to scroll', () => {
    expect(clampScroll(4, 0)).toBe(0);
    expect(clampScroll(4, -3)).toBe(0);
  });
});

describe('pageSize', () => {
  it('keeps two lines of context and never returns less than one', () => {
    expect(pageSize(20)).toBe(18);
    expect(pageSize(3)).toBe(1);
    expect(pageSize(1)).toBe(1);
    expect(pageSize(0)).toBe(1);
  });
});

describe('applyScroll', () => {
  const m = metrics(10, 100); // overflow = 90

  it('moves up line by line and page by page', () => {
    expect(applyScroll({ offset: 0 }, 'lineUp', m)).toEqual({ offset: 1 });
    expect(applyScroll({ offset: 1 }, 'pageUp', m)).toEqual({ offset: 9 });
  });

  it('moves down and snaps to the bottom inside the tolerance', () => {
    expect(applyScroll({ offset: 20 }, 'pageDown', m)).toEqual({ offset: 12 });
    // A PgDn landing 1 row short pins instead of parking in a fake off-bottom
    // state the user cannot press their way out of.
    expect(applyScroll({ offset: 9 }, 'pageDown', m)).toEqual({ offset: 0 });
    expect(applyScroll({ offset: 2 }, 'lineDown', m)).toEqual({ offset: 0 });
    expect(applyScroll({ offset: 5 }, 'pageDown', m)).toEqual({ offset: 0 });
  });

  it('does not snap on upward intents (otherwise leaving the bottom is impossible)', () => {
    expect(applyScroll({ offset: 0 }, 'lineUp', m)).toEqual({ offset: 1 });
    expect(applyScroll({ offset: 1 }, 'lineUp', m)).toEqual({ offset: 2 });
    const tiny = metrics(10, 12); // overflow = 2, inside the snap tolerance
    expect(applyScroll({ offset: 0 }, 'lineUp', tiny)).toEqual({ offset: 1 });
    expect(applyScroll({ offset: 0 }, 'toTop', tiny)).toEqual({ offset: 2 });
  });

  it('jumps to the top and back to the bottom', () => {
    expect(applyScroll({ offset: 0 }, 'toTop', m)).toEqual({ offset: 90 });
    expect(applyScroll({ offset: 90 }, 'toBottom', m)).toEqual({ offset: 0 });
  });

  it('stays pinned when the content fits the viewport', () => {
    const fits = metrics(20, 5);
    const intents: ScrollIntent[] = ['lineUp', 'lineDown', 'pageUp', 'pageDown', 'toTop', 'toBottom'];
    for (const intent of intents) {
      expect(applyScroll({ offset: 0 }, intent, fits)).toEqual({ offset: 0 });
    }
  });

  it('never exceeds the overflow', () => {
    expect(applyScroll({ offset: 90 }, 'pageUp', m)).toEqual({ offset: 90 });
  });
});

describe('isPinnedToBottom', () => {
  it('is true only at offset 0', () => {
    expect(isPinnedToBottom({ offset: 0 })).toBe(true);
    expect(isPinnedToBottom({ offset: 1 })).toBe(false);
  });
});

/** One `setState` per coalesced wheel burst (mouse-wheel-region-routing §5.5). */
describe('applyScrollTimes', () => {
  const m = metrics(10, 100); // overflow = 90

  it('folds N line steps into one result', () => {
    expect(applyScrollTimes({ offset: 0 }, 'lineUp', m, 3)).toEqual({ offset: 3 });
    expect(applyScrollTimes({ offset: 10 }, 'lineUp', m, 6)).toEqual({ offset: 16 });
  });

  it('is exactly equivalent to folding applyScroll by hand', () => {
    // Folding rather than multiplying is what keeps the wheel's notion of
    // "pinned to the bottom" identical to the keyboard's — `applyScroll` owns
    // the downward bottom-snap and the clamp.
    let byHand = { offset: 30 };
    for (let i = 0; i < 7; i += 1) byHand = applyScroll(byHand, 'lineDown', m);
    expect(applyScrollTimes({ offset: 30 }, 'lineDown', m, 7)).toEqual(byHand);
  });

  it('treats a repeat below 1 as a single step', () => {
    expect(applyScrollTimes({ offset: 0 }, 'lineUp', m, 0)).toEqual({ offset: 1 });
    expect(applyScrollTimes({ offset: 0 }, 'lineUp', m, -9)).toEqual({ offset: 1 });
    expect(applyScrollTimes({ offset: 0 }, 'lineUp', m, Number.NaN)).toEqual({ offset: 1 });
  });

  it('clamps an absurd repeat count', () => {
    // An unbounded fold is a free CPU-burn primitive for a free-spinning wheel
    // (R-10). The clamp is invisible here because the offset saturates anyway —
    // what matters is that it returns at all.
    expect(applyScrollTimes({ offset: 0 }, 'lineUp', m, 1e9)).toEqual({ offset: 90 });
  });
});
