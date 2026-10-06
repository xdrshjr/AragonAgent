/**
 * `TodoStore` — the session's todo list plus its CLI-local event stream
 * (todo-plan-execution §3.5).
 *
 * ASCII ONLY: `src/todo/**` is inside the glyph scanner's scope.
 *
 * ZERO I/O OF ANY KIND, and no timers. That is what lets `todo_write` be the one
 * tool in the array with no error path beyond a malformed payload (R-h), and it
 * is why `AgentController` can own this object as unconditionally as it owns
 * `TeamRuntime`.
 *
 * The list projects the current plan. Explicit clear/reset and a new TUI task
 * may remove that projection while the model still remembers the old plan.
 * Continuations preserve it; legacy callers retain completion/staleness rules.
 *
 * Every write is a FULL REPLACEMENT and every clear is a FULL REMOVAL - there is
 * no partial update anywhere, which is what makes I-9 ("the panel is never a
 * contradiction of the model") provable rather than argued.
 */

import { getLogger } from '../logging/logger.js';
import { TODO_LIMITS } from './limits.js';
import { normalizeTodos, type NormalizeResult } from './normalize.js';
import type {
  TodoClearReason,
  TodoEvent,
  TodoEventListener,
  TodoItem,
  TodoSnapshot,
} from './types.js';

export class TodoStore {
  private items: TodoItem[] = [];
  private updatedAt = 0;
  /** Consecutive `beginUserTurn()` calls since the last `write()`. */
  private turnsSinceWrite = 0;
  private readonly listeners = new Set<TodoEventListener>();

  /**
   * @param now Injected clock. Defaults to `Date.now`; a test passes a counter
   *            so `TodoSnapshot.updatedAt` is not wall time (P2-4).
   */
  constructor(private readonly now: () => number = Date.now) {}

  /** `null` means no list, which is what leaves the rail unmounted entirely. */
  snapshot(): TodoSnapshot | null {
    if (this.items.length === 0) return null;
    return {
      items: this.items,
      total: this.items.length,
      doneCount: this.items.filter((item) => item.status === 'completed').length,
      activeIndex: this.items.findIndex((item) => item.status === 'in_progress'),
      updatedAt: this.updatedAt,
    };
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Commit a model payload.
   *
   * ZERO SURVIVORS LEAVES THE PREVIOUS LIST UNTOUCHED (AC-9). A model sending
   * nothing usable is a BUG, and destroying a working plan because of one
   * malformed call is the worst available reaction; the caller turns the empty
   * result into an error the model can act on. Contrast `restore()`, where an
   * empty list is a FACT about a file and therefore means "clear".
   */
  write(raw: unknown): NormalizeResult {
    const result = normalizeTodos(raw, TODO_LIMITS.maxItems);
    if (result.items.length === 0) {
      this.emit({
        type: 'rejected',
        reason: 'No usable todo items: each needs a non-empty content string.',
      });
      return result;
    }

    this.items = result.items;
    this.updatedAt = this.now();
    this.turnsSinceWrite = 0;

    const snapshot = this.snapshot();
    // COUNTS ONLY, NEVER ITEM TEXT (D-19 / §3.14). It is user-task content, it
    // is unbounded in aggregate, and the counts answer every question a log can
    // answer here: did the list move, and was the payload repaired?
    //
    // SCOPE `'agent'`, NOT `'todo'`. §3.14 writes `'todo'`, but `LogScope` is a
    // CLOSED UNION in `logging/logger.ts` and that file is not in the change
    // plan; team mode faced the identical choice and files its CLI-local events
    // under `'agent'` (`install.ts::attachTeamEvents`). Following that precedent
    // keeps the diff focused and keeps a support reader filtering on one scope
    // for everything a turn did. See spec §15 IF-1.
    getLogger().debug('agent', 'todo_write', {
      total: snapshot?.total ?? 0,
      done: snapshot?.doneCount ?? 0,
      active: snapshot?.activeIndex ?? -1,
      repairs: result.repairs.length,
    });

    if (snapshot) this.emit({ type: 'updated', snapshot });
    return result;
  }

  /**
   * `/resume`. Runs through `normalizeTodos` — a session file is user-editable
   * input and gets a model payload's treatment.
   *
   * AN EMPTY (OR ALL-DROPPED) ARRAY CLEARS; IT DOES NOT NO-OP (P0-2 / D-22).
   * `/resume` has just called `replaceMessages`, so the conversation the current
   * list belonged to is gone; leaving it on screen is I-2 INVERTED — a panel
   * that disagrees with the model, which §1.2 ranks below having no panel at
   * all. The two entry points share normalization and differ only here, which is
   * exactly the difference between "the model sent nothing" (a bug) and "the
   * file has nothing" (a fact).
   */
  restore(items: unknown): void {
    const result = normalizeTodos(items, TODO_LIMITS.maxItems);
    if (result.items.length === 0) {
      this.clear('reset');
      return;
    }
    this.items = result.items;
    this.updatedAt = this.now();
    this.turnsSinceWrite = 0;
    const snapshot = this.snapshot();
    if (snapshot) this.emit({ type: 'updated', snapshot });
  }

  clear(reason: TodoClearReason): void {
    this.items = [];
    this.updatedAt = this.now();
    this.turnsSinceWrite = 0;
    this.emit({ type: 'cleared', reason });
  }

  /**
   * The turn boundary (§3.2).
   *
   * Called from `AgentController.prompt()` and NOT from `steer()` — the same
   * asymmetry, for the same reason, that `askRounds = 0` already has: a steer is
   * a mid-turn interjection, not a new task. The stale counter inherits that
   * asymmetry for free, which is the behaviour you want: a steer must not age
   * out the plan it is steering.
   *
   * A new TUI task drops the old plan here, while a continuation preserves it.
   * With no policy, legacy callers retain completed/stale-plan expiration.
   * Clearing at `agent_end` would erase the final progress before the user can
   * inspect it and remove the plan that automatic continuation still needs.
   */
  beginUserTurn(policy?: 'new-task' | 'continue'): void {
    if (this.items.length === 0 || policy === 'continue') return;
    if (policy === 'new-task') {
      this.clear('turn');
      return;
    }

    if (this.items.every((item) => item.status === 'completed')) {
      this.clear('turn');
      return;
    }

    // ...but a partial list is not immortal (P1-7 / D-21). Without a bound, a
    // plan abandoned mid-way holds a fifth of the terminal for the rest of the
    // session, showing work nobody is doing - the "furniture when idle" R-g
    // rules out. Self-healing, because the model's next write is a full
    // replacement: the panel is ABSENT while the model still knows the plan,
    // which is the safe direction (I-9).
    this.turnsSinceWrite += 1;
    if (this.turnsSinceWrite > TODO_LIMITS.staleTurns) this.clear('stale');
  }

  /**
   * Report a refusal that never reached `write()` (§3.3 steps 1 and 2).
   *
   * THE COMPENSATING PATH FOR SUPPRESSING THE TOOL CARD (§3.8): `todo_write`
   * renders its own transcript entry, so without this the one case that produces
   * nothing visible would be the case that most needs to be visible.
   */
  reject(reason: string): void {
    this.emit({ type: 'rejected', reason });
  }

  subscribe(listener: TodoEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Per-listener isolation: one bad subscriber cannot fail a tool call. */
  private emit(event: TodoEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Swallowed on purpose. A UI subscriber that throws is a UI bug, and
        // failing the model's tool call over it would be a worse one.
      }
    }
  }
}
