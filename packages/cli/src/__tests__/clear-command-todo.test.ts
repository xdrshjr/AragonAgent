/**
 * `/clear` takes the todo panel with it (slash-clear-leaves-todo-panel).
 *
 * Driven through `runSlashInput` rather than by calling the command object, so
 * the path a user actually reaches is the path under test — and because the
 * defect this pins was invisible to a reducer-level assertion. The rail mounts
 * on `ViewState.todos`, but `/save`, `/todo status`, `/todo continue` and
 * follow-through all read the STORE directly, so a fix that only nulled the
 * mirror would leave the screen and the data disagreeing. Both halves are
 * asserted below for exactly that reason: assert only `state.todos` and a
 * mirror-only regression passes.
 */

import { describe, expect, it } from 'vitest';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';
import { initialViewState, viewReducer, type ViewAction, type ViewState } from '../agent/reducer.js';
import { TodoStore } from '../todo/store.js';

const registry = new CommandRegistry();
registerBuiltinCommands(registry);

interface Harness {
  store: TodoStore;
  /** `App.tsx` mounts the rail and the chip on this. */
  railMounted: () => boolean;
  entryCount: () => number;
  notices: string[];
  toasts: string[];
  ctx: (args: string) => CommandContext;
}

function harness(opts: { withList?: boolean } = {}): Harness {
  let clock = 0;
  const store = new TodoStore(() => ++clock);
  let state: ViewState = initialViewState();
  const notices: string[] = [];
  const toasts: string[] = [];
  const dispatch = (action: ViewAction): void => {
    state = viewReducer(state, action);
  };

  // The App's own subscription (`App.tsx`), copied so the store -> mirror leg is
  // exercised rather than assumed.
  store.subscribe((event) => {
    if (event.type === 'updated') dispatch({ type: 'todoUpdate', snapshot: event.snapshot });
    else if (event.type === 'cleared') dispatch({ type: 'todoCleared' });
  });

  if (opts.withList !== false) {
    // "the task finished": every item completed, which is the screen the user
    // is looking at when they type `/clear`.
    store.write([
      { content: 'Read the reducer', activeForm: 'Reading', status: 'completed' },
      { content: 'Patch the store', activeForm: 'Patching', status: 'completed' },
      { content: 'Run the tests', activeForm: 'Running', status: 'completed' },
    ]);
  }

  const controller = {
    clearMessages: () => store.clear('reset'),
    clearAllQueues: () => {},
    clearTodos: () => store.clear('user'),
    getTodoSnapshot: () => store.snapshot(),
    isRunning: () => false,
  } as unknown as CommandContext['controller'];

  return {
    store,
    railMounted: () => state.todos !== null,
    entryCount: () => state.entries.length,
    notices,
    toasts,
    ctx: (args: string) =>
      ({
        args,
        controller,
        get state() {
          return state;
        },
        dispatch,
        notify: (_level: string, text: string) => notices.push(text),
        toast: (_level: string, text: string) => toasts.push(text),
      }) as unknown as CommandContext,
  };
}

describe('/clear and the todo panel (I-2 user override)', () => {
  it('clears the transcript AND both halves of the list', async () => {
    const h = harness();
    expect(h.railMounted()).toBe(true);
    expect(h.entryCount()).toBe(1);

    await runSlashInput(registry, '/clear', h.ctx);

    expect(h.entryCount()).toBe(0);
    expect(h.railMounted()).toBe(false);
    // THE HALF A MIRROR-ONLY FIX MISSES: `/save`, `/todo status|continue` and
    // follow-through all ask the store, not `ViewState`.
    expect(h.store.snapshot()).toBeNull();
  });

  it('says nothing when there was no list to clear', async () => {
    // `TodoStore.clear()` has no `isEmpty` early return, so this still emits;
    // the reducer branch it lands in writes two already-default fields. Silence
    // here is what makes it safe to clear unconditionally, with no "No todo
    // list." guard of the kind `/todo clear` has.
    const h = harness({ withList: false });

    await runSlashInput(registry, '/clear', h.ctx);

    expect(h.railMounted()).toBe(false);
    expect(h.store.snapshot()).toBeNull();
    expect(h.notices).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  it('clears the transcript even mid-run, unlike /todo clear', async () => {
    // `/todo clear` refuses while a run is in progress. Copying that guard here
    // would leave `/clear` unable to clear even the transcript — a worse
    // regression than the bug it was meant to bound. The cleared list heals on
    // the model's next full-replacement write.
    const h = harness();
    const running = {
      ...h.ctx(''),
      controller: {
        clearTodos: () => h.store.clear('user'),
        getTodoSnapshot: () => h.store.snapshot(),
        isRunning: () => true,
      } as unknown as CommandContext['controller'],
    };

    await runSlashInput(registry, '/clear', () => running as CommandContext);

    expect(h.entryCount()).toBe(0);
    expect(h.railMounted()).toBe(false);
    expect(h.store.snapshot()).toBeNull();
    expect(h.notices).toEqual([]);
  });

  it('/reset still drops both, and still says so', async () => {
    // The contrast that localizes the change: `/reset` clears `messages` as
    // well, and remains the only command that does.
    const h = harness();

    await runSlashInput(registry, '/reset', h.ctx);

    expect(h.entryCount()).toBe(0);
    expect(h.railMounted()).toBe(false);
    expect(h.store.snapshot()).toBeNull();
    expect(h.toasts).toEqual(['Started a new conversation.']);
  });
});
