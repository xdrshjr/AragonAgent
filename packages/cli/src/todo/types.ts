/**
 * Runtime shapes for the todo subsystem (todo-plan-execution §5.1).
 *
 * ASCII ONLY: `src/todo/**` is inside the glyph scanner's scope.
 *
 * `TodoEvent` is CLI-LOCAL and is deliberately NOT a member of core's
 * `AgentEvent` union (D-11), exactly as `TeamEvent` is not: core freezes its
 * runtime export list (`public-api.test.ts`) and forbids host coupling
 * (`no-host-coupling.test.ts`), so a new event member would break the first and
 * teach core about a host shape it has no business defining.
 */

/**
 * Re-exported so `config/schema.ts` can name the mode without importing the
 * decision module (todo-plan-followthrough §3.1). TYPE-ONLY, so the apparent
 * cycle `types -> follow-through -> types` is erased at compile time and there
 * is no runtime import at all.
 */
export type { FollowThroughMode } from './follow-through.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  /** Imperative, sanitized, <= TODO_LIMITS.contentChars. */
  content: string;
  /** Present continuous, shown while in progress. Falls back to `content`. */
  activeForm: string;
  status: TodoStatus;
}

/** The immutable projection the UI renders. Rebuilt on every write. */
export interface TodoSnapshot {
  items: TodoItem[];
  total: number;
  doneCount: number;
  /** Index of the single in_progress item, or -1 when everything is completed. */
  activeIndex: number;
  /**
   * Stamped by an INJECTED clock (`TodoStore`'s constructor takes
   * `now?: () => number`, defaulting to `Date.now`), for the reason `TeamPanel`
   * takes a `now?` prop: a snapshot test that reads the wall clock is a test
   * that fails on a slow machine and nowhere else (P2-4).
   */
  updatedAt: number;
}

/**
 * Why a list went away.
 *
 *   `user`  - `/todo clear`, or `/clear`. Both are an explicit user instruction,
 *             which is I-2's standing exception; neither touches `messages`.
 *   `reset` - `/reset`, or a `/resume` whose file carried no list (§3.13).
 *   `turn`  - a new TUI task started, or a legacy caller began a turn after
 *             every item was completed.
 *   `stale` - unfinished, and unwritten for more than `TODO_LIMITS.staleTurns`
 *             consecutive turns (§3.2 / P1-7).
 */
export type TodoClearReason = 'user' | 'reset' | 'turn' | 'stale';

export type TodoEvent =
  | { type: 'updated'; snapshot: TodoSnapshot }
  | { type: 'rejected'; reason: string }
  | { type: 'cleared'; reason: TodoClearReason };

export type TodoEventListener = (event: TodoEvent) => void;
