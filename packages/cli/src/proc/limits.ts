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
   * JOB RECORDS one session may hold — services AND tasks share the number.
   *
   * NAMED `maxJobs`, NOT `maxServices` (long-task-jobs D-7). A constant that
   * counts two kinds of job while being called `maxServices` is the next edit's
   * bug: the limit and its refusal message would go on saying "service" while
   * the model is holding a training run.
   *
   * Eviction only ever removes a record in a TERMINAL state
   * (`exited | failed | stopped`). When all 16 are live `start()` refuses and
   * names the oldest ids rather than evicting: evicting a live record would
   * orphan a running server that nothing can any longer name or stop.
   */
  maxJobs: 16,
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

  // --- long-task-jobs: bounded waiting, progress, notices, log mirror --------
  //
  // EVERY ONE OF THESE IS STRUCTURAL, not policy. The user-tunable knobs are the
  // five `jobs.*` keys in `config/schema.ts` (how many seconds to wait, when
  // silence becomes `[stalled]`, whether to mirror the log, whether notices may
  // steer). What a result can PHYSICALLY carry lives here, for the reason this
  // file's header records at length.

  /**
   * Rows of new output one `job_wait` result carries, in addition to its status,
   * progress, cursor, `[note]`/`[stalled]` and `[next]` lines.
   *
   * THE NUMBER IS THE FEATURE. One wait must cost ~150 tokens, not the ~6k a
   * 200-row tail costs - that economy is the whole reason `job_wait` exists
   * instead of a seventh `bash_output` poll.
   */
  waitTailRows: 6,
  /** Seconds a single wait may block, as a STRUCTURAL floor and ceiling (`jobs.waitSeconds` is clamped into this range). */
  waitMinSeconds: 5,
  waitMaxSeconds: 60,
  /**
   * Characters one extracted progress line may occupy.
   *
   * Also the width the card's progress row is assumed to take, which is why
   * `ui/layout/virtual-window.ts` can count it as exactly one row.
   */
  waitProgressChars: 80,
  /**
   * Rows `extractProgress` scans, from the tail, before giving up.
   *
   * Eight because a tqdm bar plus its ETA plus the loss line above it is the
   * realistic worst case, and because a wider window is how a stale `100%` from
   * an earlier phase wins over the live one.
   */
  progressScanRows: 8,
  /** Notices one `<job_notices>` block may render. Bounded so the block stays ~8 lines. */
  maxNotices: 8,
  /** Log rows a failed job's notice carries. Two: the message and the frame above it. */
  noticeTailRows: 2,
  /** Rows `job_list` prints before it collapses the rest into `+N more`. */
  listRows: 8,
  /**
   * Consecutive waits with no new row and no progress change before the
   * `[guard]` line is prepended (R-3).
   *
   * A HINT, NEVER A REFUSAL: the seventh wait still waits. Refusing would take
   * the decision away from the model at exactly the point where it has the most
   * context.
   */
  maxConsecutiveWaits: 6,
  /** Bytes one mirrored job log may occupy before it stops appending. */
  logMirrorMaxBytes: 2_000_000,
  /** Coalescing window for the log mirror's appends (<=4 writes/second). */
  mirrorFlushMs: 250,
  /** Session directories the mirror keeps, newest by mtime. */
  mirrorRetainDirs: 5,
} as const;

/**
 * Bumped whenever the wording of the `<background_services>` block changes, so a
 * behaviour report can be tied to a block revision with one grep.
 */
export const BACKGROUND_SERVICES_BLOCK_VERSION = 'v1';

/**
 * The same discipline for the `<background_jobs>` block. A SEPARATE CONSTANT,
 * not a bump of the one above: the two blocks are spliced by different flags
 * (`bash.background` and `jobs.enabled`), so one version number covering both
 * would make "which block changed" unanswerable from a report.
 */
export const JOBS_BLOCK_VERSION = 'v1-2026-10';

/**
 * Head-room a single wait leaves below the tool ceiling (I-4).
 *
 * `jobs.waitSeconds * 1000 + JOB_WAIT_MARGIN_MS <= toolTimeoutMs` is the whole
 * reason a wait never needs to pause the idle watchdog (D-3): a 60 s wait inside
 * a 180 s tool call in a 210 s idle window cannot be mistaken for a hang.
 *
 * IT LIVES HERE RATHER THAN IN `config/schema.ts`, where the design document put
 * it, because the TOOL layer needs the same number for its call-time convergence
 * (AC-14) and nothing in `tools/` may import `config/` - a tool takes its policy
 * through closures. One constant, two readers, no second copy to drift. Recorded
 * in `docs/plans/long-task-jobs/spec.md` under `## 实施过程发现的方案缺陷` (I-2).
 */
export const JOB_WAIT_MARGIN_MS = 30_000;
