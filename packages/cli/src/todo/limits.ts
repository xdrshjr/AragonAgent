/**
 * TODO_LIMITS — the single authority on every structural bound this subsystem
 * enforces (todo-plan-execution §4.2).
 *
 * ASCII ONLY: `src/todo/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts`), whose `inScope` regex this feature extends. A NEW TREE IS
 * INVISIBLE TO THAT SCAN UNTIL IT IS ADDED (C-4), which is a guard rail that
 * silently stops guarding — the same hole the team feature had to close for
 * `team/`.
 *
 * TWO KINDS OF NUMBER, AND THEY ARE NOT INTERCHANGEABLE — the distinction
 * `TEAM_LIMITS` records at length:
 *
 *  - Everything below is STRUCTURAL: what the panel can physically carry, what
 *    a plan can mean, what a payload may weigh. A user has no business tuning
 *    them, so they are constants.
 *  - The two `todo.*` config keys (`config/schema.ts`) are POLICY: register the
 *    tool at all, render the rail at all. They are clamped, persisted and
 *    user-facing.
 */

export const TODO_LIMITS = {
  /** Items one list may hold. Extras are dropped with a repair note. */
  maxItems: 20,
  /** `TodoItem.content`, clamped (never rejected). */
  contentChars: 80,
  /** `TodoItem.activeForm`, clamped. */
  activeFormChars: 80,
  /**
   * Below this, a FRESH list is refused - the structural half of R-c ("simple
   * tasks are done directly, not planned"). Gated on an EMPTY store: shrinking
   * an existing list to one item is legitimate, so the guard must not fire
   * there (§3.3 step 2).
   */
  minFreshItems: 2,
  /** Rows the in-progress row may wrap to. Every other row truncates. */
  activeWrapRows: 2,
  /**
   * Below this many AVAILABLE rail rows (`todoRailRows`, NOT `viewportBudget`)
   * the rail is not mounted at all.
   */
  panelMinRows: 6,
  /** Below this many terminal columns the status-bar counter degrades to `[3/7]`. */
  statusCompactCols: 100,
  /**
   * Below this many columns the inline strip drops its `+N done` suffix
   * (todo-plan-followthrough §3.7 / D-19).
   *
   * NAMED RATHER THAN INLINED, and the reason is that it sits between two other
   * real bounds — `statusCompactCols` (100) above and `MIN_FULLSCREEN_COLS` (40)
   * in `frame.ts` — with nothing to tell a reader whether a bare `80` in the
   * component was a third policy or a typo for one of them.
   */
  stripDoneCols: 80,
  /**
   * Rows `todoRailRows()` subtracts while a team dispatch is live (§3.9 / P1-3).
   *
   * `TEAM_LIMITS.panelMaxRows` (5) + header + `+N more` + the mail line = 8, and
   * this is deliberately the FULL worst case rather than a measurement: an
   * over-subtraction costs one item row, an under-subtraction eats the `+N
   * below` marker - the one row whose absence is indistinguishable from "the
   * list is short" - and those two mistakes are not equally bad.
   */
  railReservedRows: 8,
  /**
   * Consecutive user turns an UNFINISHED list survives without a `todo_write`
   * before `beginUserTurn()` drops it (§3.2 / P1-7). Three keeps the common
   * interruption sequence ("wait, explain X" / "and Y?" / "ok, continue")
   * intact and returns the column on the fourth unrelated turn.
   */
  staleTurns: 3,
} as const;

/**
 * TODO_FOLLOW_LIMITS — the economy that makes auto-continue's worst case
 * ARITHMETIC rather than trust (todo-plan-followthrough §8.1).
 *
 * STRUCTURAL, NOT POLICY, exactly like `TODO_LIMITS` above: `todo.followThrough`
 * is the user-facing knob and it decides only WHETHER the loop runs. How far it
 * may run is not something a user has any way to reason about, and a setting
 * here would be a setting whose wrong value is a bill.
 */
export const TODO_FOLLOW_LIMITS = {
  /**
   * Auto-continuations for ONE LIST LINEAGE, however productive, and NOT reset
   * by a re-plan (P0-1 / D-16). See `FollowThroughBudget.used`.
   *
   * DELIBERATELY GREATER THAN `TODO_LIMITS.maxItems` (20): a fully productive
   * 20-step plan must never be cut off by the total cap, so the cap only ever
   * binds on pathology. Lowering it below `maxItems` would make the ceiling fire
   * on success, which is the one thing it must not do.
   */
  maxAutoContinuesPerList: 25,
  /**
   * Consecutive auto-continuations that completed nothing before control goes
   * back to the human. Two, so a model that merely forgot to tick an item gets
   * exactly one free nudge and a model that has stopped engaging with its own
   * plan does not get a third.
   */
  maxNoProgressContinues: 2,
  /**
   * Interactive grace window before an armed continuation fires. The notice text
   * derives its "in Ns" from THIS value rather than spelling 3 again, so the two
   * cannot disagree.
   */
  graceMs: 3000,
} as const;

/**
 * Bumped whenever the wording of the `<todo_planning>` block changes - INCLUDING
 * either `{{VISIBILITY}}` variant, which is part of the block - so a behaviour
 * report can be tied to a block revision with one grep.
 *
 * NOT BUMPED BY follow-through (D-3): the model is never told about the
 * mechanism, so the block is byte-identical to `bf6aeb1a`.
 */
export const TODO_BLOCK_VERSION = 'v1-2026-07';
