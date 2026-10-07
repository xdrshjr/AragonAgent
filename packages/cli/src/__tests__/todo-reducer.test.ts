/**
 * The reducer half of the transcript story (AC-29, plus the I-2 clear rules).
 *
 * Every tool call normally produces a `kind: 'tool'` entry, so a 7-item list
 * updated twice per item would be 14 near-identical cards in the one surface the
 * user reads most. §3.8 answers that with ONE `kind: 'todo'` entry per turn,
 * rewritten in place — and that requires BOTH halves asserted here: the generic
 * card is suppressed, and the entry is driven from the store.
 */

import { describe, expect, it } from 'vitest';
import {
  initialViewState,
  reduceEvent,
  viewReducer,
  type Entry,
  type ViewAction,
  type ViewState,
} from '../agent/reducer.js';
import type { TodoSnapshot } from '../todo/types.js';

function snapshot(done: number, total: number): TodoSnapshot {
  return {
    items: Array.from({ length: total }, (_, i) => ({
      content: `step ${i + 1}`,
      activeForm: `doing ${i + 1}`,
      status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending',
    })),
    total,
    doneCount: done,
    activeIndex: done < total ? done : -1,
    updatedAt: 1,
  };
}

function fold(actions: ViewAction[], from = initialViewState()): ViewState {
  return actions.reduce(viewReducer, from);
}

const todoEntries = (state: ViewState): Entry[] => state.entries.filter((e) => e.kind === 'todo');

describe('SELF_RENDERING_TOOLS suppression (D-10)', () => {
  it('AC-29: a todo_write call produces NO generic tool entry', () => {
    const actions = reduceEvent({
        type: 'message_update',
        streamEvent: { type: 'tool_call_start', toolCallId: 't1', toolName: 'todo_write' },
      } as never);
    const state = fold(actions);
    expect(state.entries).toEqual([]);
    expect(state.runPhase).toBe('preparing-tool');
  });

  it('every OTHER tool is untouched', () => {
    expect(
      reduceEvent({
        type: 'message_update',
        streamEvent: { type: 'tool_call_start', toolCallId: 't1', toolName: 'bash' },
      } as never),
    ).toEqual([{ type: 'toolCallStart', toolCallId: 't1', toolName: 'bash' }]);
  });

  it('the four later handlers need no rule of their own', () => {
    // Suppressing only `tool_call_start` is sufficient BECAUSE every later
    // handler resolves through `findToolEntryId`, which returns `undefined` when
    // no entry was created, and every one of them already early-returns. This
    // asserts that end to end rather than by reading the code.
    const state = fold([
      { type: 'toolExecStart', toolCallId: 't1' },
      { type: 'toolCallDelta', toolCallId: 't1', argsDelta: '{' },
      { type: 'toolCallEnd', toolCallId: 't1', args: {} },
      { type: 'toolExecEnd', toolCallId: 't1', isError: false, duration: 1, preview: 'x' },
    ]);
    expect(state.entries).toEqual([]);
  });
});

describe('the todo entry (§5.2)', () => {
  it('a new task clears live projections but keeps the old card and assigns a new id', () => {
    const before = fold([
      { type: 'submit', text: 'old task' },
      { type: 'todoUpdate', snapshot: snapshot(1, 3) },
      { type: 'runEnd' },
    ]);
    const oldCard = todoEntries(before)[0]!;
    const cleared = fold([
      { type: 'submit', text: 'new task' }, { type: 'todoCleared' },
    ], before);
    expect(cleared.todos).toBeNull();
    expect(cleared.todoEntryId).toBeUndefined();
    const after = viewReducer(cleared, { type: 'todoUpdate', snapshot: snapshot(0, 4) });
    expect(todoEntries(after)[0]).toEqual(oldCard);
    expect(todoEntries(after)).toHaveLength(2);
    expect(todoEntries(after)[1]!.id).not.toBe(oldCard.id);
  });
  it('AC-29: one card per turn; a second write rewrites it, a new turn appends', () => {
    let state = fold([
      { type: 'submit', text: 'do the thing' },
      { type: 'todoUpdate', snapshot: snapshot(0, 3) },
      { type: 'todoUpdate', snapshot: snapshot(1, 3) },
    ]);
    expect(todoEntries(state)).toHaveLength(1);
    const card = todoEntries(state)[0]!;
    expect(card.kind === 'todo' && card.doneCount).toBe(1);
    expect(card.kind === 'todo' && card.live).toBe(true);

    state = fold(
      [
        { type: 'runEnd' },
        { type: 'submit', text: 'and the next thing' },
        { type: 'todoUpdate', snapshot: snapshot(2, 3) },
      ],
      state,
    );
    expect(todoEntries(state)).toHaveLength(2);
  });

  it('C-5: runEnd settles the card so it can reach <Static>', () => {
    const state = fold([
      { type: 'submit', text: 'x' },
      { type: 'todoUpdate', snapshot: snapshot(0, 2) },
      { type: 'runEnd' },
    ]);
    const card = todoEntries(state)[0]!;
    expect(card.kind === 'todo' && card.live).toBe(false);
  });

  it('mirrors the live list into ViewState.todos, which is what mounts the rail', () => {
    let state = fold([{ type: 'todoUpdate', snapshot: snapshot(1, 4) }]);
    expect(state.todos?.total).toBe(4);
    state = viewReducer(state, { type: 'todoCleared' });
    expect(state.todos).toBeNull();
    // THE ENTRY STAYS: it is history, and history is not retracted.
    expect(todoEntries(state)).toHaveLength(1);
  });

  it('AC-17 (view half): both /clear and /reset drop the list (I-2 user override)', () => {
    // `/clear` used to KEEP the list here, on the reading that the model still
    // believed in the plan. The rail is on the screen the user just asked to be
    // cleared, so an explicit `/clear` now takes it — I-2's `'user'` exception,
    // the same one `/todo clear` uses. The command half of this (the STORE being
    // cleared too, which is what `/save` and `/todo continue` read) is asserted
    // in `clear-command-todo.test.ts`; this is only the mirror.
    const base = fold([
      { type: 'submit', text: 'x' },
      { type: 'todoUpdate', snapshot: snapshot(1, 3) },
    ]);

    const cleared = viewReducer(base, { type: 'clearTranscript' });
    expect(cleared.todos).toBeNull();
    expect(cleared.todoEntryId).toBeUndefined();

    const reset = viewReducer(base, { type: 'resetConversation' });
    expect(reset.todos).toBeNull();
    expect(reset.todoEntryId).toBeUndefined();
  });

  it('restoreEntries drops the turn pointer, as it already does for team', () => {
    const base = fold([
      { type: 'submit', text: 'x' },
      { type: 'todoUpdate', snapshot: snapshot(0, 2) },
    ]);
    const restored = viewReducer(base, { type: 'restoreEntries', entries: [] });
    expect(restored.todoEntryId).toBeUndefined();
  });
});
