/**
 * `TodoStore` — state, event stream and the turn boundary (AC-14..AC-18, AC-41).
 *
 * The clock is INJECTED throughout (P2-4): a snapshot assertion that reads wall
 * time is a test that fails on a slow machine and nowhere else.
 */

import { describe, expect, it } from 'vitest';
import { TodoStore } from '../todo/store.js';
import { TODO_LIMITS } from '../todo/limits.js';
import type { TodoEvent } from '../todo/types.js';

function makeStore(): { store: TodoStore; events: TodoEvent[] } {
  let tick = 0;
  const store = new TodoStore(() => {
    tick += 1;
    return tick;
  });
  const events: TodoEvent[] = [];
  store.subscribe((e) => events.push(e));
  return { store, events };
}

const THREE = [
  { content: 'a', status: 'completed' },
  { content: 'b', status: 'in_progress' },
  { content: 'c', status: 'pending' },
];

describe('TodoStore', () => {
  it('an empty store has no snapshot at all, which is what unmounts the rail', () => {
    const { store } = makeStore();
    expect(store.isEmpty()).toBe(true);
    expect(store.snapshot()).toBeNull();
  });

  it('write() commits, derives the counts, and emits one updated event', () => {
    const { store, events } = makeStore();
    store.write(THREE);
    const snapshot = store.snapshot()!;
    expect(snapshot.total).toBe(3);
    expect(snapshot.doneCount).toBe(1);
    expect(snapshot.activeIndex).toBe(1);
    expect(snapshot.updatedAt).toBeGreaterThan(0);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('updated');
  });

  it('AC-14: beginUserTurn() clears a fully-completed list with reason "turn"', () => {
    const { store, events } = makeStore();
    store.write([{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }]);
    events.length = 0;
    store.beginUserTurn();
    expect(store.snapshot()).toBeNull();
    expect(events).toEqual([{ type: 'cleared', reason: 'turn' }]);
  });

  it('AC-15: the FIRST turn boundary keeps an unfinished list and emits nothing', () => {
    // "continue", "now do the rest", "what about step 4" are the most common
    // follow-ups in the world, and destroying the plan on the way into them is
    // unforgivable (D-6).
    const { store, events } = makeStore();
    store.write(THREE);
    events.length = 0;
    store.beginUserTurn();
    expect(store.snapshot()!.total).toBe(3);
    expect(events).toEqual([]);
  });

  it('AC-41: an unfinished list expires after staleTurns, and a write resets the count', () => {
    const { store, events } = makeStore();
    store.write(THREE);
    events.length = 0;

    for (let i = 0; i < TODO_LIMITS.staleTurns; i += 1) store.beginUserTurn();
    expect(store.snapshot()).not.toBeNull();
    expect(events).toEqual([]);

    store.beginUserTurn();
    expect(store.snapshot()).toBeNull();
    expect(events).toEqual([{ type: 'cleared', reason: 'stale' }]);

    // ...and a write anywhere in the sequence puts the counter back to zero.
    store.write(THREE);
    for (let i = 0; i < TODO_LIMITS.staleTurns; i += 1) store.beginUserTurn();
    store.write(THREE);
    for (let i = 0; i < TODO_LIMITS.staleTurns; i += 1) store.beginUserTurn();
    expect(store.snapshot()).not.toBeNull();
  });

  it('AC-9 (store half): a payload with zero survivors LEAVES THE LIST ALONE', () => {
    // A model sending nothing usable is a BUG; destroying a working plan over
    // one malformed call is the worst available reaction. Contrast `restore()`.
    const { store, events } = makeStore();
    store.write(THREE);
    events.length = 0;
    const result = store.write('nope');
    expect(result.items).toEqual([]);
    expect(store.snapshot()!.total).toBe(3);
    expect(events).toEqual([
      { type: 'rejected', reason: 'No usable todo items: each needs a non-empty content string.' },
    ]);
  });

  it('AC-36 (store half): restore([]) CLEARS rather than no-opping (P0-2 / D-22)', () => {
    // `/resume` has just called `replaceMessages`, so the conversation the list
    // belonged to is gone. Leaving it on screen is I-2 INVERTED — a panel that
    // disagrees with the model, which §1.2 ranks below having no panel at all.
    const { store, events } = makeStore();
    store.write(THREE);
    events.length = 0;
    store.restore([]);
    expect(store.snapshot()).toBeNull();
    expect(events).toEqual([{ type: 'cleared', reason: 'reset' }]);
  });

  it('restore() runs a session file through the SAME normalizer a model gets', () => {
    // A file on disk is user-editable input and gets a model payload's treatment.
    const { store, events } = makeStore();
    store.restore([
      { content: 'x'.repeat(200), status: 'nonsense' },
      { content: '  ' },
      { content: 'real', status: 'pending' },
    ]);
    const snapshot = store.snapshot()!;
    expect(snapshot.total).toBe(2);
    expect(snapshot.items[0]!.content).toHaveLength(TODO_LIMITS.contentChars);
    expect(snapshot.activeIndex).toBe(0);
    expect(events.at(-1)!.type).toBe('updated');
  });

  it('AC-18: a throwing listener neither blocks the others nor fails the write', () => {
    const store = new TodoStore(() => 1);
    const seen: string[] = [];
    store.subscribe(() => {
      throw new Error('bad subscriber');
    });
    store.subscribe((e) => seen.push(e.type));
    expect(() => store.write(THREE)).not.toThrow();
    expect(seen).toEqual(['updated']);
  });

  it('unsubscribe actually detaches', () => {
    const { store, events } = makeStore();
    const off = store.subscribe(() => events.push({ type: 'cleared', reason: 'user' }));
    off();
    store.write(THREE);
    expect(events.filter((e) => e.type === 'cleared')).toEqual([]);
  });

  it('clear() reports the reason it was given, and reject() only emits', () => {
    const { store, events } = makeStore();
    store.write(THREE);
    events.length = 0;
    store.reject('nope');
    expect(store.snapshot()).not.toBeNull();
    store.clear('user');
    expect(events).toEqual([
      { type: 'rejected', reason: 'nope' },
      { type: 'cleared', reason: 'user' },
    ]);
  });
});
