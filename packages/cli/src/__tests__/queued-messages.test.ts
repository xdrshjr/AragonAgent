import { describe, expect, it } from 'vitest';
import { mergePendingEntries } from '../agent/queued-messages.js';
import { initialViewState, viewReducer } from '../agent/reducer.js';

describe('pending steering survives transcript lifetime', () => {
  it('preserves pending order around retained entries and is immutable and idempotent', () => {
    const pending = ['a', 'b', 'c'].map((queueId) => ({ queueId, text: 'same\nfull body' }));
    const entries = [
      { id: 'history', kind: 'user' as const, text: 'before' },
      { id: 'visible-b', kind: 'queued' as const, ...pending[1]! },
      { id: 'after', kind: 'user' as const, text: 'after' },
    ];
    const original = structuredClone(entries);
    const merged = mergePendingEntries(entries, pending);
    expect(merged.map((entry) => entry.id)).toEqual([
      'history', 'pending:a', 'visible-b', 'after', 'pending:c',
    ]);
    expect(mergePendingEntries(merged, pending)).toEqual(merged);
    expect(entries).toEqual(original);
  });
  it('merges by ID and preserves identical messages and full text', () => {
    const pending = ['a', 'b'].map((queueId) => ({ queueId, text: 'same\nfull body' }));
    const entries = [{ id: 'e1', kind: 'queued' as const, ...pending[0]! }];
    const merged = mergePendingEntries(entries, pending);
    expect(merged).toEqual([...entries, { id: 'pending:b', kind: 'queued', ...pending[1] }]);
    expect(mergePendingEntries(merged, pending)).toEqual(merged);
  });

  it('receipt restores cleared history before removing pending', () => {
    let state = viewReducer(initialViewState(), {
      type: 'steerQueued', queueId: 'a', text: 'full\nbody',
    });
    state = viewReducer(state, { type: 'clearTranscript' });
    expect(state.entries).toEqual([]);
    expect(mergePendingEntries(state.entries, state.pendingSteering)).toEqual([
      { id: 'pending:a', kind: 'queued', queueId: 'a', text: 'full\nbody' },
    ]);
    state = viewReducer(state, { type: 'steeringAccepted', ids: ['a'] });
    expect(state.entries).toEqual([{ id: 'pending:a', kind: 'user', text: 'full\nbody' }]);
    expect(state.pendingSteering).toEqual([]);
  });

  it('deduplicates IDs even after receipt and clear without deduplicating text', () => {
    const action = { type: 'steerQueued' as const, queueId: 'a', text: 'same' };
    let state = viewReducer(initialViewState(), action);
    expect(viewReducer(state, action)).toBe(state);
    state = viewReducer(state, { type: 'steeringAccepted', ids: ['a'] });
    state = viewReducer(state, { type: 'clearTranscript' });
    expect(viewReducer(state, action)).toBe(state);
    expect(viewReducer(state, { ...action, queueId: 'b' }).pendingSteering).toHaveLength(1);
  });

  it('tracks tool execution independently of transcript and unrelated errors', () => {
    let state = viewReducer(initialViewState(), { type: 'runStart' });
    state = viewReducer(state, { type: 'toolExecStart', toolCallId: 't', toolName: 'read_file' });
    state = viewReducer(state, { type: 'clearTranscript' });
    expect(state.activeTool?.name).toBe('read_file');
    state = viewReducer(state, { type: 'notice', level: 'error', text: 'copy failed' });
    expect(state.runOutcome).toBe('none');
  });

  it('reset and restore discard pending', () => {
    const queued = viewReducer(initialViewState(), {
      type: 'steerQueued', queueId: 'a', text: 'pending',
    });
    expect(viewReducer(queued, { type: 'resetConversation' }).pendingSteering).toEqual([]);
    expect(viewReducer(queued, { type: 'restoreEntries', entries: [] }).pendingSteering).toEqual([]);
  });
});
