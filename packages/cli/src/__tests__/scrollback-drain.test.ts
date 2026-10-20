import { describe, expect, it, vi } from 'vitest';
import { createScrollbackDrain, overflowMarker } from '../ui/scrollback/drain.js';

describe('scrollback drain', () => {
  it('is FIFO and takeAll empties it', () => {
    const drain = createScrollbackDrain();
    drain.enqueue(['a1', 'a2'], { id: 'a', kind: 'user' });
    drain.enqueue(['b1'], { id: 'b', kind: 'assistant' });
    expect(drain.pending()).toBe(3);
    expect(drain.takeAll()).toEqual(['a1', 'a2', 'b1']);
    expect(drain.pending()).toBe(0);
    expect(drain.takeAll()).toEqual([]);
  });

  it('folds the oldest entries into one counted marker on overflow', () => {
    const drain = createScrollbackDrain({ capacity: 2 });
    for (const id of ['a', 'b', 'c', 'd']) drain.enqueue([id], { id, kind: 'user' });
    expect(drain.elided()).toBe(2);
    expect(drain.takeAll()).toEqual([overflowMarker(2), 'c', 'd']);
    // The marker prints once.
    drain.enqueue(['e'], { id: 'e', kind: 'user' });
    expect(drain.takeAll()).toEqual(['e']);
    expect(drain.elided()).toBe(2);
  });

  it('takeUpTo takes whole entries and never splits one', () => {
    const drain = createScrollbackDrain();
    drain.enqueue(['a1', 'a2', 'a3'], { id: 'a', kind: 'user' });
    drain.enqueue(['b1', 'b2'], { id: 'b', kind: 'user' });
    expect(drain.takeUpTo(4)).toEqual(['a1', 'a2', 'a3']);
    expect(drain.takeUpTo(4)).toEqual(['b1', 'b2']);
  });

  it('takeUpTo always takes the first entry even when it is taller than the cap', () => {
    const drain = createScrollbackDrain();
    drain.enqueue(['a1', 'a2', 'a3'], { id: 'a', kind: 'user' });
    expect(drain.takeUpTo(1)).toEqual(['a1', 'a2', 'a3']);
  });

  it('fires onEnqueue on every enqueue and onDrained only when rows left', () => {
    const drain = createScrollbackDrain();
    drain.onEnqueue = vi.fn();
    drain.onDrained = vi.fn();
    drain.takeAll();
    expect(drain.onDrained).not.toHaveBeenCalled();
    drain.enqueue(['x'], { id: 'x', kind: 'user' });
    expect(drain.onEnqueue).toHaveBeenCalledTimes(1);
    drain.takeAll();
    expect(drain.onDrained).toHaveBeenCalledTimes(1);
  });
});
