/**
 * PROC_LIMITS — the single authority on every structural bound the process
 * supervisor enforces (background-service-supervision §6).
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts::inScope`), whose hardcoded directory regex this feature
 * extends. A NEW TREE IS INVISIBLE TO THAT SCAN UNTIL IT IS NAMED THERE, and a
 * guard rail that silently stops guarding is worse than no guard rail — this
 * package has now paid for that edit eleven times.
 *
 * TWO KINDS OF NUMBER, AND THEY ARE NOT INTERCHANGEABLE — the distinction
 * `TODO_LIMITS` and `TEAM_LIMITS` each record at length:
 *
 *  - Everything below is STRUCTURAL: how many rows a tail can physically carry,
 *    how many children one session may hold, how long a kill may take before it
 *    stops being a kill. A user has no business tuning them, so they are
 *    constants.
 *  - The four `bash.*` config keys (`config/schema.ts`) are POLICY: register the
 *    tools at all, let the classifier fire, how long a launch may block the
 *    turn, how long to wait for readiness. They are clamped, persisted and
 *    user-facing.
 */

export const PROC_LIMITS = {
  /**
   * Rows the per-service ring retains.
   *
   * DELIBERATELY A DIFFERENT NUMBER FROM `cardTailRows` BELOW, and from
   * `LIVE_TAIL_ROWS` (8) in `tools/tool-output-store.ts`. They bound unrelated
   * things — what `bash_output` can page back through, versus what one card
   * draws — and a shared literal is how a later edit collapses two bounds into
   * one.
   */
  serviceTailRows: 200,
  /** Rows a snapshot (and therefore a card) carries. */
  cardTailRows: 8,
  /**
   * Service RECORDS one session may hold.
   *
   * Eviction only ever removes a record in a TERMINAL state
   * (`exited | failed | stopped`). When all 16 are live `start()` refuses and
   * names the oldest ids rather than evicting: evicting a live record would
   * orphan a running server that nothing can any longer name or stop.
   */
  maxServices: 16,
  /**
   * How long `bash` waits after `'exit'` for the stdio streams to close before
   * settling anyway.
   *
   * This number IS defence 1. `'close'` fires only once every stream is closed,
   * and a detached grandchild that inherited the pipe keeps it open after the
   * shell is long gone — so a tool that settles on `'close'` alone has a path
   * that never settles at all.
   */
  drainMs: 250,
  /**
   * How long an aborted/timed-out `bash` waits after the kill before settling
   * WHETHER OR NOT the child ever reported exit.
   *
   * A pending promise after an abort is the bug; a possibly-premature result is
   * not.
   */
  killGraceMs: 2000,
  /** Readiness port probe interval. */
  probeIntervalMs: 500,
  /** Socket timeout for one readiness probe. */
  probeSocketTimeoutMs: 1000,
  /**
   * Output-event coalescing window inside the supervisor.
   *
   * At the SOURCE rather than in the view, because the same event is also
   * consumed by `/bg` and by `bash_output`. A webpack build emitting thousands
   * of lines a second must not become thousands of React renders.
   */
  outputCoalesceMs: 100,
  /** `SIGTERM` -> `SIGKILL` escalation window for a graceful stop. */
  stopGraceMs: 3000,
  /** Below this many terminal columns the status chip degrades to `[N]`. */
  statusCompactCols: 92,
} as const;

/**
 * Bumped whenever the wording of the `<background_services>` block changes, so a
 * behaviour report can be tied to a block revision with one grep.
 */
export const BACKGROUND_SERVICES_BLOCK_VERSION = 'v1';
