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
