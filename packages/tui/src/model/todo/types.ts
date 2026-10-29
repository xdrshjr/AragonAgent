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

/**
 * The two settled states of a criterion, plus "not checked" and "being checked"
 * (todo-acceptance-criteria §6.1). Mutually exclusive and exhaustive.
 *
 * `in_progress` IS A STORE-OWNED DERIVED STATE (v2, P0-1): the model cannot write
 * it, the tool schema does not expose it, normalization always downgrades it to
 * `pending`, and `TodoStore.write()` re-derives at most one after every commit.
 * That is the same discipline `TodoItem`'s "exactly one in_progress" follows: one
 * state has exactly one writer, otherwise the derived phase, the rail's anchor
 * and the transcript card each read a different "criterion being checked".
 */
export type AcceptanceStatus = 'pending' | 'in_progress' | 'passed' | 'failed';

export interface AcceptanceItem {
  /** One checkable statement, sanitized, <= ACCEPT_LIMITS.contentChars. */
  content: string;
  /** How it will be checked (command / file / observation), <= checkChars. */
  check: string;
  status: AcceptanceStatus;
  /** Required for `passed` / `failed`; otherwise the verdict drops to `pending`. */
  evidence: string;
  /**
   * Explicit re-open. Only honoured when the same criterion's normalized
   * `content` is unchanged (§6.2.1 step 9). INPUT ONLY: never stored, consumed
   * and discarded by `write()`.
   */
  reopen?: boolean;
}

/** The immutable projection, isomorphic to `TodoSnapshot`. Rebuilt per commit. */
export interface AcceptanceSnapshot {
  items: AcceptanceItem[];
  total: number;
  /** `passed` + `failed`. */
  checkedCount: number;
  passedCount: number;
  failedCount: number;
  /** Injected clock, for the same reason `TodoSnapshot.updatedAt` has one (P2-4). */
  updatedAt: number;
}

/**
 * `work`   - at least one step is not completed.
 * `verify` - every step is completed and at least one criterion is unresolved.
 * `done`   - every step is completed and every criterion is settled (or there is
 *            no acceptance table at all).
 *
 * DERIVED, NEVER STORED (I-3): `derivePlanPhase` is the only judge.
 */
export type PlanPhase = 'work' | 'verify' | 'done';

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
  /**
   * The acceptance projection; `null` when there are no criteria (or the
   * capability is off).
   *
   * REQUIRED, NOT OPTIONAL (fail-closed, §6.1): `TodoStore` is the only writer and
   * it always knows what belongs here. Optional would let one call site silently
   * under-report an entire table. The cost is the 15 existing test fixtures that
   * spell out a `TodoSnapshot` literal (§7.3) - a mechanical edit, done in the
   * same step as this field.
   */
  acceptance: AcceptanceSnapshot | null;
}

/**
 * Why a list went away.
 *
 *   `user`  - `/todo clear`, or `/clear screen` (the screen-only form). Both are
 *             an explicit user instruction, which is I-2's standing exception;
 *             neither touches `messages`.
 *   `reset` - `/clear` (or its alias `/reset`) through `clearMessages()`, or a
 *             `/resume` whose file carried no list (§3.13).
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
