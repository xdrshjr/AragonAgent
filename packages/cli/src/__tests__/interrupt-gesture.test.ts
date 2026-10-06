import { describe, expect, it } from 'vitest';
import {
  advanceInterruptGesture, cancelInterruptConfirmation,
} from '../input/interrupt-gesture.js';

describe('interrupt confirmation', () => {
  it('confirms, aborts, then force-stops', () => {
    const first = advanceInterruptGesture({ phase: 'ready' }, 100);
    expect(first).toEqual({ state: { phase: 'armed', armedAt: 100 }, action: 'hint' });
    const second = advanceInterruptGesture(first.state, 200);
    expect(second).toEqual({ state: { phase: 'stopping' }, action: 'abort' });
    expect(advanceInterruptGesture(second.state, 9000)).toEqual({
      state: { phase: 'ready' }, action: 'force-stop',
    });
  });
  it.each([1499, 1500])('accepts the inclusive %i ms boundary', (elapsed) => {
    expect(advanceInterruptGesture({ phase: 'armed', armedAt: 100 }, 100 + elapsed)
      .action).toBe('abort');
  });
  it.each([1501, -1])('rearms outside the window (%i ms)', (elapsed) => {
    expect(advanceInterruptGesture({ phase: 'armed', armedAt: 100 }, 100 + elapsed))
      .toEqual({ state: { phase: 'armed', armedAt: 100 + elapsed }, action: 'hint' });
  });
  it('cancels confirmation without removing the rescue path', () => {
    expect(cancelInterruptConfirmation({ phase: 'armed', armedAt: 100 }))
      .toEqual({ phase: 'ready' });
    expect(cancelInterruptConfirmation({ phase: 'stopping' })).toEqual({ phase: 'stopping' });
  });
});
