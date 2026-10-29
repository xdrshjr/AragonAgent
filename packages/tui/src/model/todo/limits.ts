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
  /** Minimum shared middle rows for the compact rail. */
  panelMinRows: 3,
  /** Full rail includes a blank separator and separate overflow markers. */
  panelFullRows: 6,
  /** Below this many terminal columns the status-bar counter degrades to `[3/7]`. */
  statusCompactCols: 100,
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
 *
 * BUMPED BY todo-acceptance-criteria (D-3 inverted): that feature CHANGES what
 * the model reads, so the revision must be greppable from a behaviour report.
 */
export const TODO_BLOCK_VERSION = 'v2-2026-10';

/**
 * ACCEPT_LIMITS - the structural bounds of the acceptance table
 * (todo-acceptance-criteria §6.1). STRUCTURAL, NOT POLICY, exactly like
 * `TODO_LIMITS`: what a rail row, a transcript row and a model payload can
 * physically carry.
 */
export const ACCEPT_LIMITS = {
  /**
   * TWELVE, DELIBERATELY FEWER THAN `TODO_LIMITS.maxItems` (20). A plan with more
   * than a dozen criteria is not a plan, it is a test suite - and `check` is where
   * a suite belongs ("npm test"). The cap is semantic pressure: the model either
   * merges criteria or admits it wrote a suite.
   */
  maxItems: 12,
  /** `AcceptanceItem.content`, clamped (never rejected). */
  contentChars: 100,
  /** `AcceptanceItem.check`, clamped. May be empty: a weak criterion, not an error. */
  checkChars: 120,
  /** `AcceptanceItem.evidence`, clamped. */
  evidenceChars: 200,
  /**
   * A FRESH plan must declare at least this many usable criteria (§6.2.3 step 4).
   * Gated on an EMPTY store AND on `todo.acceptance` being on: the requirement is
   * "plan the criteria too", so it applies exactly where the capability does.
   * Named `...Criteria`, not `...Items`, so it cannot be confused with
   * `TODO_LIMITS.minFreshItems` (2) used two steps earlier.
   */
  minFreshCriteria: 1,
} as const;

/**
 * TODO_RESULT_LIMITS - the bound on what `todo_write` returns each turn
 * (I-11 / §6.4.4). The acceptance paragraph pushes the text from about 700
 * characters to roughly 1100, and every character is paid for on every call, so
 * the ceiling is structural rather than advisory.
 */
export const TODO_RESULT_LIMITS = {
  maxChars: 1400,
  /** Appended when the text had to be clipped, so a clipped answer says so. */
  truncationNote: 'Note: result text truncated.',
} as const;

/**
 * VERIFY_MESSAGE_LIMITS - the CONSTRUCTIVE bound of `buildVerifyMessage`
 * (§6.6.2 / AC-22), in the tradition of `buildChildDigest`: independent of how
 * long the lists are, because every row it emits is clamped.
 *
 * The two numbers are ONE arithmetic, measured rather than estimated: at 5
 * unchecked + 2 failed with `check` at 100 and `evidence` at 60 the worst case is
 * 19 rows / 1699 characters, leaving 101 characters below `maxChars` and one row
 * below `maxRows`.
 */
export const VERIFY_MESSAGE_LIMITS = {
  uncheckedItems: 5,
  failedItems: 2,
  checkChars: 100,
  evidenceChars: 60,
  maxChars: 1800,
  maxRows: 20,
} as const;
