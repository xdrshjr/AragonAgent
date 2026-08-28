import { describe, expect, it } from 'vitest';
import { mergeDeltas } from '../agent/coalesce.js';
import type { ViewAction } from '../agent/reducer.js';

describe('mergeDeltas', () => {
  it('merges consecutive text deltas into one', () => {
    const merged = mergeDeltas([
      { type: 'textDelta', delta: 'Hel' },
      { type: 'textDelta', delta: 'lo ' },
      { type: 'textDelta', delta: 'world' },
    ]);
    expect(merged).toEqual([{ type: 'textDelta', delta: 'Hello world' }]);
  });

  it('flushes before a non-delta so order stays text, tool, text', () => {
    const actions: ViewAction[] = [
      { type: 'textDelta', delta: 'A' },
      { type: 'textDelta', delta: 'B' },
      { type: 'toolCallStart', toolCallId: 't1', toolName: 'bash' },
      { type: 'textDelta', delta: 'C' },
    ];
    const merged = mergeDeltas(actions);
    expect(merged).toEqual([
      { type: 'textDelta', delta: 'AB' },
      { type: 'toolCallStart', toolCallId: 't1', toolName: 'bash' },
      { type: 'textDelta', delta: 'C' },
    ]);
  });

  it('flushes on a kind change (thinking then text) preserving order', () => {
    const merged = mergeDeltas([
      { type: 'thinkingDelta', delta: 'plan ' },
      { type: 'thinkingDelta', delta: 'it' },
      { type: 'textDelta', delta: 'answer' },
    ]);
    expect(merged).toEqual([
      { type: 'thinkingDelta', delta: 'plan it' },
      { type: 'textDelta', delta: 'answer' },
    ]);
  });

  it('is a no-op for an empty list', () => {
    expect(mergeDeltas([])).toEqual([]);
  });
});

/**
 * The third merged kind (agent-activity-presentation-live §3.3.2 / D-30 / P1-5).
 *
 * It merges DIFFERENTLY from the two text kinds, and the difference is the
 * payload's shape: `rows` is the store's whole tail rather than an increment, so
 * consecutive tails collapse to the LAST rather than concatenating.
 *
 * ONE PENDING SLOT, DISCRIMINATED, NEVER TWO. A second independent slot for the
 * object payload would let a chunk overtake a token and reorder the two streams
 * — exactly what I-L4-1 forbids: "never what is dispatched, never the order."
 * The four transitions below are what pin that.
 */
describe('mergeDeltas — toolOutputDelta (D-30 / P1-5)', () => {
  const tail = (id: string, rows: string[], at: number): ViewAction => ({
    type: 'toolOutputDelta',
    toolCallId: id,
    rows,
    at,
  });

  it('keeps the LAST tail when the toolCallId matches, not the concatenation', () => {
    const merged = mergeDeltas([
      tail('c1', ['a'], 1),
      tail('c1', ['a', 'b'], 2),
      tail('c1', ['a', 'b', 'c'], 3),
    ]);
    expect(merged).toEqual([tail('c1', ['a', 'b', 'c'], 3)]);
  });

  it('does NOT merge across tool-call ids — that would repaint another card', () => {
    const merged = mergeDeltas([tail('c1', ['a'], 1), tail('c2', ['x'], 2)]);
    expect(merged).toEqual([tail('c1', ['a'], 1), tail('c2', ['x'], 2)]);
  });

  it('a `toolExecEnd` between two tails flushes the first (E-18)', () => {
    const end: ViewAction = {
      type: 'toolExecEnd',
      toolCallId: 'c1',
      isError: false,
      duration: 5,
      preview: 'done',
    };
    const merged = mergeDeltas([tail('c1', ['a'], 1), end, tail('c1', ['b'], 2)]);
    expect(merged).toEqual([tail('c1', ['a'], 1), end, tail('c1', ['b'], 2)]);
  });

  it('transition: text -> toolOutput flushes the text FIRST', () => {
    const merged = mergeDeltas([
      { type: 'textDelta', delta: 'A' },
      { type: 'textDelta', delta: 'B' },
      tail('c1', ['a'], 1),
    ]);
    expect(merged).toEqual([{ type: 'textDelta', delta: 'AB' }, tail('c1', ['a'], 1)]);
  });

  it('transition: toolOutput -> text flushes the tail FIRST', () => {
    const merged = mergeDeltas([
      tail('c1', ['a'], 1),
      { type: 'textDelta', delta: 'A' },
      { type: 'textDelta', delta: 'B' },
    ]);
    expect(merged).toEqual([tail('c1', ['a'], 1), { type: 'textDelta', delta: 'AB' }]);
  });

  it('transition: thinking -> toolOutput -> thinking keeps all three in order', () => {
    const merged = mergeDeltas([
      { type: 'thinkingDelta', delta: 'p' },
      tail('c1', ['a'], 1),
      { type: 'thinkingDelta', delta: 'q' },
    ]);
    expect(merged).toEqual([
      { type: 'thinkingDelta', delta: 'p' },
      tail('c1', ['a'], 1),
      { type: 'thinkingDelta', delta: 'q' },
    ]);
  });

  it('neither stream can overtake the other over a long interleaving', () => {
    // The property I-L4-1 states, asserted as a property rather than as a case.
    const input: ViewAction[] = [];
    for (let i = 0; i < 20; i += 1) {
      input.push({ type: 'textDelta', delta: `t${i}` });
      input.push(tail('c1', [`row ${i}`], i));
    }
    const merged = mergeDeltas(input);
    const kinds = merged.map((a) => a.type);
    for (let i = 0; i < kinds.length - 1; i += 1) {
      expect(kinds[i]).not.toBe(kinds[i + 1]);
    }
    expect(kinds[0]).toBe('textDelta');
    expect(merged).toHaveLength(40);
  });

  it('leaves a two-kind run of text deltas merging exactly as before', () => {
    // The regression half: adding a third kind must not change the two that
    // were there, including the empty-delta case.
    expect(
      mergeDeltas([
        { type: 'textDelta', delta: '' },
        { type: 'textDelta', delta: 'x' },
      ]),
    ).toEqual([{ type: 'textDelta', delta: 'x' }]);
  });
});
