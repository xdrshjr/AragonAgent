/**
 * `/clear` as a COMMAND (clear-command-context-reset T-7..T-11 / T-21).
 *
 * Driven through the real `CommandRegistry` and `runSlashInput`, because the
 * defect this feature fixes was invisible at every lower level: the command
 * existed, ran, and quietly cleared the wrong thing. Only the action sequence the
 * user's input actually produces can pin "the screen was cleared and the history
 * was not", or its successor, "the history is cleared and the screen follows it".
 */

import { describe, expect, it, vi } from 'vitest';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';
import {
  initialViewState, viewReducer, type ViewAction, type ViewState,
} from '../agent/reducer.js';
import type { ConversationResetResult } from '../agent/conversation-reset.js';

const registry = new CommandRegistry();
registerBuiltinCommands(registry);

interface Harness {
  state: () => ViewState;
  actions: ViewAction[];
  notices: { level: string; text: string }[];
  toasts: string[];
  clearTodos: ReturnType<typeof vi.fn>;
  resetConversation: ReturnType<typeof vi.fn>;
  ctx: (args: string) => CommandContext;
}

/**
 * The controller is a TWO-METHOD fake on purpose: `resetConversation` is the only
 * thing the command is allowed to reach for, and `clearTodos` belongs to the
 * `screen` branch. A fake carrying `clearMessages` / `clearAllQueues` as well
 * would let a regression that clears the right state in the wrong place still
 * pass.
 */
function harness(opts: {
  result?: ConversationResetResult;
  entries?: ViewState['entries'];
  pendingSteering?: ViewState['pendingSteering'];
} = {}): Harness {
  const actions: ViewAction[] = [];
  let state: ViewState = {
    ...initialViewState(),
    entries: opts.entries ?? ([
      { id: 'e1', kind: 'user', text: 'first question' },
      { id: 'e2', kind: 'assistant', text: 'first answer', thinkingOpen: false, streaming: false },
    ] as ViewState['entries']),
    pendingSteering: opts.pendingSteering ?? [],
    status: 'running',
    turnProduced: true,
  };
  const notices: { level: string; text: string }[] = [];
  const toasts: string[] = [];
  const dispatch = (action: ViewAction): void => {
    actions.push(action);
    state = viewReducer(state, action);
  };
  const clearTodos = vi.fn();
  const resetConversation = vi.fn(async () => opts.result ?? {
    ok: true, interrupted: false, archivedPath: null, messagesCleared: 2,
  });
  const controller = {
    clearTodos,
    resetConversation,
    getTodoSnapshot: () => null,
  } as unknown as CommandContext['controller'];
  return {
    state: () => state,
    actions,
    notices,
    toasts,
    clearTodos,
    resetConversation,
    ctx: (args: string) => ({
      args,
      controller,
      get state() {
        return state;
      },
      dispatch,
      notify: (level: string, text: string) => notices.push({ level, text }),
      toast: (_level: string, text: string) => toasts.push(text),
      transcriptEntries: () => state.entries,
    }) as unknown as CommandContext,
  };
}

describe('/clear starts a new conversation', () => {
  it('dispatches resetConversation and does not dispatch clearTranscript', async () => {
    const h = harness();
    await runSlashInput(registry, '/clear', h.ctx);

    expect(h.actions).toEqual([{ type: 'resetConversation' }]);
    expect(h.actions).not.toContainEqual({ type: 'clearTranscript' });
    expect(h.resetConversation).toHaveBeenCalledOnce();
    expect(h.toasts).toEqual(['Started a new conversation.']);
    // THE WHOLE BUG, IN ONE ASSERTION: the run facts a reset used to keep.
    expect(h.state().status).toBe('idle');
    expect(h.state().entries).toEqual([]);
    expect(h.state().turnProduced).toBe(false);
  });

  it('asks the controller to interrupt', async () => {
    const h = harness();
    await runSlashInput(registry, '/clear', h.ctx);
    // `interrupt: true` is what routes the reset through `forceStop()` - the one
    // method that bumps the run generation and hard-kills a wedged foreground
    // bash. A `false` here reverts P0-2 without touching anything else.
    expect(h.resetConversation).toHaveBeenCalledWith(expect.objectContaining({ interrupt: true }));
  });

  it('passes a live transcript reader rather than a snapshot', async () => {
    const h = harness();
    let rowsSeenAtArchive = -1;
    // THE ROW THAT ARRIVES WHILE THE RESET WAITS. `/clear` interrupts a run and
    // then waits for it to unwind; the engine writes its last tool cards during
    // that wait, and those rows belong in the archive. A thunk reads them.
    h.resetConversation.mockImplementation(async (opts: { readTranscript: () => unknown[] }) => {
      h.ctx('').dispatch({ type: 'submit', text: 'card written while unwinding' });
      rowsSeenAtArchive = opts.readTranscript().length;
      return { ok: true, interrupted: true, archivedPath: null, messagesCleared: 3 };
    });
    await runSlashInput(registry, '/clear', h.ctx);

    // Two rows existed when the command was entered; THREE existed when the
    // archive read the screen. A captured value would have reported two.
    expect(rowsSeenAtArchive).toBe(3);
  });

  it('/reset behaves byte-identically to /clear', async () => {
    // Implementation identity, not just equal outcomes: two bodies that happened
    // to behave the same would pass an action-sequence comparison and then drift.
    expect(registry.get('clear')!.run).toBe(registry.get('reset')!.run);
    const viaClear = harness();
    const viaReset = harness();
    await runSlashInput(registry, '/clear', viaClear.ctx);
    await runSlashInput(registry, '/reset', viaReset.ctx);
    expect(viaReset.actions).toEqual(viaClear.actions);
    expect(viaReset.toasts).toEqual(viaClear.toasts);
  });

  it('reports how many queued messages it cancelled', async () => {
    const h = harness({
      pendingSteering: [
        { queueId: 'a', text: 'first queued' },
        { queueId: 'b', text: 'second queued' },
      ],
    });
    await runSlashInput(registry, '/clear', h.ctx);

    // THE COUNT IS READ BEFORE THE CLEAR (P1-2 / C-9): `clearAllQueues()` empties
    // `pendingUserSteering`, so a count taken afterwards is always 0 - a notice
    // that states a falsehood.
    expect(h.notices).toContainEqual({ level: 'warn', text: expect.stringContaining('2') });
  });

  it('says nothing about queues when none were pending', async () => {
    const h = harness();
    await runSlashInput(registry, '/clear', h.ctx);
    expect(h.notices.filter((n) => n.level === 'warn')).toEqual([]);
  });

  it('reports the archived path with a way back', async () => {
    const h = harness({
      result: {
        ok: true, interrupted: true, archivedPath: 'C:/home/sessions/cleared/a.json',
        messagesCleared: 2,
      },
    });
    await runSlashInput(registry, '/clear', h.ctx);

    const notice = h.notices.find((n) => n.level === 'info');
    expect(notice?.text).toContain('C:/home/sessions/cleared/a.json');
    // "Archived" without a way to find the file is a reassurance, not a recovery.
    expect(notice?.text).toContain('/resume');
  });

  it('reports the reason instead of silently doing nothing when the reset fails', async () => {
    const h = harness({
      result: {
        ok: false, reason: 'still-running',
        message: 'Could not stop the current run. Press Esc twice to force-stop, then /clear.',
      },
    });
    await runSlashInput(registry, '/clear', h.ctx);

    expect(h.notices).toContainEqual({
      level: 'warn',
      text: 'Could not stop the current run. Press Esc twice to force-stop, then /clear.',
    });
    // ZERO SIDE EFFECTS (I-4): no dispatch at all, so the screen it could not
    // clear is still on screen.
    expect(h.actions).toEqual([]);
    expect(h.toasts).toEqual([]);
    expect(h.state().entries).toHaveLength(2);
  });

  it('refuses an unknown argument without clearing anything', async () => {
    const h = harness();
    await runSlashInput(registry, '/clear foo', h.ctx);

    expect(h.notices).toEqual([
      { level: 'warn', text: 'Unknown argument "foo" - use /clear [screen].' },
    ]);
    expect(h.resetConversation).not.toHaveBeenCalled();
    expect(h.actions).toEqual([]);
  });
});

describe('/clear screen keeps the old behaviour', () => {
  it('clears the transcript and the todo panel, and nothing else', async () => {
    const h = harness();
    await runSlashInput(registry, '/clear screen', h.ctx);

    expect(h.actions).toEqual([{ type: 'clearTranscript' }]);
    expect(h.clearTodos).toHaveBeenCalledOnce();
    // THE POINT OF KEEPING THE FORM (I-3): the conversation survives, so a user
    // who only wanted their screen back cannot lose an hour of context.
    expect(h.resetConversation).not.toHaveBeenCalled();
  });

  it('is silent, byte for byte as /clear used to be', async () => {
    const h = harness();
    await runSlashInput(registry, '/clear screen', h.ctx);
    expect(h.notices).toEqual([]);
    expect(h.toasts).toEqual([]);
  });
});
