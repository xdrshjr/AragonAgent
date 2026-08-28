/**
 * `/todo follow` and the `/todo continue` rewrite
 * (todo-plan-followthrough §4.3 / AC-16, AC-17).
 *
 * Driven through `runSlashInput` rather than by calling the command object, so
 * the argument parsing (`follow` / `auto`) is exercised the way a user reaches
 * it.
 */

import { describe, expect, it, vi } from 'vitest';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';
import { TODO_FOLLOW_LIMITS } from '../todo/limits.js';
import {
  buildContinuationMessage,
  emptyBudget,
  type FollowThroughBudget,
} from '../todo/follow-through.js';
import { DEFAULT_TODO_CONFIG, type TodoConfig } from '../config/schema.js';
import type { TodoSnapshot } from '../todo/types.js';

const registry = new CommandRegistry();
registerBuiltinCommands(registry);

const PLAN: TodoSnapshot = {
  items: [
    { content: 'Read the reducer', activeForm: 'Reading the reducer', status: 'completed' },
    { content: 'Design the store', activeForm: 'Designing the store', status: 'in_progress' },
    { content: 'Add the test', activeForm: 'Adding the test', status: 'pending' },
  ],
  total: 3,
  doneCount: 1,
  activeIndex: 1,
  updatedAt: 1,
};

interface Harness {
  ctx: (args: string) => CommandContext;
  todoConfig: () => TodoConfig;
  persisted: Partial<TodoConfig>[];
  notices: string[];
  toasts: string[];
  submits: { text: string; opts?: { userInitiated?: boolean } }[];
  /** How many times `setTodoConfig` rebuilt the prompt (§4.3 / P2-10). */
  rebuilds: () => number;
}

function harness(
  over: {
    snapshot?: TodoSnapshot | null;
    running?: boolean;
    budget?: FollowThroughBudget;
    todo?: Partial<TodoConfig>;
  } = {},
): Harness {
  let todo: TodoConfig = { ...DEFAULT_TODO_CONFIG, ...(over.todo ?? {}) };
  let rebuilds = 0;
  const persisted: Partial<TodoConfig>[] = [];
  const notices: string[] = [];
  const toasts: string[] = [];
  const submits: { text: string; opts?: { userInitiated?: boolean } }[] = [];

  const controller = {
    getTodoConfig: () => todo,
    setTodoConfig: (patch: Partial<TodoConfig>) => {
      todo = { ...todo, ...patch };
      // The real method calls `rebuildSystemPrompt()` UNCONDITIONALLY; the
      // command must not route around it to avoid that (§4.3).
      rebuilds += 1;
      return todo;
    },
    getTodoSnapshot: () => over.snapshot ?? null,
    isRunning: () => over.running ?? false,
    isTodoRegistered: () => true,
    isTodoEnabled: () => true,
    clearTodos: vi.fn(),
  } as unknown as CommandContext['controller'];

  return {
    todoConfig: () => todo,
    persisted,
    notices,
    toasts,
    submits,
    rebuilds: () => rebuilds,
    ctx: (args: string) =>
      ({
        args,
        controller,
        notify: (_level: string, text: string) => notices.push(text),
        toast: (_level: string, text: string) => toasts.push(text),
        persistConfig: (patch: { todo?: Partial<TodoConfig> }) => {
          if (patch.todo) persisted.push(patch.todo);
        },
        submit: (text: string, opts?: { userInitiated?: boolean }) =>
          submits.push({ text, opts }),
        followBudget: over.budget ?? emptyBudget(),
      }) as unknown as CommandContext,
  };
}

describe('/todo follow', () => {
  it('accepts all three modes and writes BOTH the runtime and the file', async () => {
    for (const mode of ['auto', 'off', 'notify'] as const) {
      const h = harness();
      await runSlashInput(registry, `/todo follow ${mode}`, h.ctx);
      // The runtime, or the command reports success and changes nothing until
      // the next launch (P1-2)...
      expect(h.todoConfig().followThrough).toBe(mode);
      // ...and the file, or it does not survive the session.
      expect(h.persisted).toEqual([{ followThrough: mode }]);
      expect(h.toasts.join(' ')).toContain('Follow-through');
    }
  });

  it('goes through `setTodoConfig`, prompt rebuild and all (§4.3 / P2-10)', async () => {
    // An implementer must not add a branch that bypasses `setTodoConfig` to
    // avoid the unconditional rebuild: that trades a free string concatenation
    // for the exact "reports success, changes nothing" bug the method prevents.
    const h = harness();
    await runSlashInput(registry, '/todo follow auto', h.ctx);
    expect(h.rebuilds()).toBe(1);
  });

  it('names the ceiling when switching to auto, so the cost is visible up front', async () => {
    const h = harness();
    await runSlashInput(registry, '/todo follow auto', h.ctx);
    expect(h.toasts.join(' ')).toContain(String(TODO_FOLLOW_LIMITS.maxAutoContinuesPerList));
  });

  it('rejects an unknown mode without changing anything', async () => {
    const h = harness();
    await runSlashInput(registry, '/todo follow sometimes', h.ctx);
    expect(h.notices.join(' ')).toContain('Usage: /todo follow <notify|auto|off>');
    expect(h.todoConfig().followThrough).toBe('notify');
    expect(h.persisted).toEqual([]);
  });

  it('rejects a bare `/todo follow` the same way', async () => {
    const h = harness();
    await runSlashInput(registry, '/todo follow', h.ctx);
    expect(h.notices.join(' ')).toContain('Usage: /todo follow');
    expect(h.persisted).toEqual([]);
  });

  it('is listed in the unknown-argument hint, so it is discoverable', async () => {
    const h = harness();
    await runSlashInput(registry, '/todo wat', h.ctx);
    expect(h.notices.join(' ')).toContain('follow <mode>');
  });
});

describe('/todo status reports follow-through', () => {
  it('shows the mode with no list', async () => {
    const h = harness({ todo: { followThrough: 'off' } });
    await runSlashInput(registry, '/todo status', h.ctx);
    expect(h.notices.join(' ')).toContain('Follow-through: off.');
  });

  it('shows `N/25 used` in auto mode ONLY', async () => {
    // Printing `0/25` under `notify` would advertise a budget nothing is
    // spending (§4.3).
    const spent: FollowThroughBudget = { ...emptyBudget(), used: 2, anchorTotal: 3 };
    const auto = harness({ snapshot: PLAN, todo: { followThrough: 'auto' }, budget: spent });
    await runSlashInput(registry, '/todo status', auto.ctx);
    expect(auto.notices.join(' ')).toContain(
      `Follow-through: auto (2/${TODO_FOLLOW_LIMITS.maxAutoContinuesPerList} used).`,
    );

    const notify = harness({ snapshot: PLAN, budget: spent });
    await runSlashInput(registry, '/todo status', notify.ctx);
    expect(notify.notices.join(' ')).toContain('Follow-through: notify.');
    expect(notify.notices.join(' ')).not.toContain('used');
  });
});

describe('/todo continue', () => {
  it('AC-16: submits the ENUMERATED message, not round 1s fixed string', async () => {
    const h = harness({ snapshot: PLAN });
    await runSlashInput(registry, '/todo continue', h.ctx);
    expect(h.submits).toHaveLength(1);
    expect(h.submits[0]!.text).toBe(buildContinuationMessage(PLAN));
    expect(h.submits[0]!.text).not.toBe('Continue with the remaining todo items.');
  });

  it('AC-17: passes `userInitiated: false`, so it stays out of prompt history', async () => {
    // The user typed `/todo continue`, which the SLASH history already has;
    // putting this canned paragraph under the composer's up-arrow as well would
    // record the same event twice, in the more verbose of the two forms.
    const h = harness({ snapshot: PLAN });
    await runSlashInput(registry, '/todo continue', h.ctx);
    expect(h.submits[0]!.opts).toEqual({ userInitiated: false });
  });

  it('still refuses while running, and with nothing left', async () => {
    const running = harness({ snapshot: PLAN, running: true });
    await runSlashInput(registry, '/todo continue', running.ctx);
    expect(running.submits).toEqual([]);
    expect(running.notices.join(' ')).toContain('Already running.');

    const done = harness({ snapshot: { ...PLAN, doneCount: 3, activeIndex: -1 } });
    await runSlashInput(registry, '/todo continue', done.ctx);
    expect(done.submits).toEqual([]);
    expect(done.notices.join(' ')).toContain('Nothing left to continue.');
  });
});
