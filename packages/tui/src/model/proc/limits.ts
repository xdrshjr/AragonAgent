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
   *
   * IT IS A BOUND, NOT A VERDICT. Expiry says "stop waiting"; it does NOT say
   * the pipe was held, and the note is only printed when the streams are
   * observed still open at that moment (`proc/output-streams.ts` records the
   * release-gate failure a timer-based verdict caused). The ordinary path does
   * not even reach this bound: two ended streams after `'exit'` settle the call
   * with the byte-identical body, one notification earlier.
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
  /**
   * How long to KEEP ASKING whether the `SIGKILL` actually landed before
   * declaring the job `stopped`.
   *
   * THIS NUMBER IS NOT A GUESS ABOUT THE PLATFORM. `killTree` spawns `taskkill`,
   * which is a process of its own: a Windows tree kill of a shell plus its node
   * child measures ~0.8 s on the reference machine (while starting `cmd` costs
   * 50 ms), so the fixed 250 ms this used to allow expired first and `stop()`
   * reported `stopped` with the child still running - AC-18 caught exactly that.
   * The wait stays BOUNDED against the opposite failure (a promise that never
   * resolves); at this deadline the record keeps the honest `killIncomplete`
   * flag instead.
   */
  killVerifyMs: 2000,
  /** Liveness poll interval while waiting for a `SIGKILL` to land. */
  killVerifyPollMs: 50,
  /**
   * How long ONE synchronous tree kill (`killTreeSync`) may take.
   *
   * MEASURED, NOT GUESSED. A `taskkill /pid <shell> /t /f` of a shell plus its
   * node child takes 1027-1058 ms on the reference machine on an IDLE host (five
   * samples, 2026-10-23), so the old 2000 ms was 1.9x the honest cost and the
   * 2026-10-23 release run - where the whole suite took 340 s against the usual
   * 200-240 s - is comfortably inside the range where a single tree kill exceeds
   * it. Crossing it is not a slow kill, it is NO kill: `spawnSync` kills
   * `taskkill` itself at the deadline and the tree keeps running (verified: a
   * 150 ms budget left the child alive 1.5 s later, `ETIMEDOUT` / `status null`).
   *
   * 5000 ms is ~5x the measured cost. It is a CEILING and not a cost: a tree that
   * dies in the usual second still returns in that second. The worst case is
   * `maxJobs` (16) trees at the ceiling on an exit hook, which is why this is not
   * any larger - the reaper prefers a reported miss to an exit that never ends,
   * and the miss is now reported (`ProcRecord.killIncomplete`).
   */
  killTreeSyncTimeoutMs: 5000,
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
  /**
   * Seconds a single wait may block, as a STRUCTURAL floor and ceiling (`jobs.waitSeconds` is clamped into this range).
   *
   * THE ONE AUTHORITY FOR THE CEILING (extended-job-wait I-2): the executor
   * override (`JOB_WAIT_TOOL_CEILING_MS`), `WAIT_SECONDS_RANGE.max`, the tool
   * description and the prompt block all derive from, or are asserted equal to,
   * `waitMaxSeconds`. Changing it here and missing another reader is how a wait
   * is silently cut short by a layer nobody remembered.
   */
  waitMinSeconds: 5,
  waitMaxSeconds: 1200,
  /**
   * Cadence of the in-wait heartbeat, in ms.
   *
   * ONE HZ because the reader needs "a few seconds ago" precision, not a stream:
   * subscribing to the supervisor's 100 ms output coalescing would mean ~12000
   * pointless view updates across a 20-minute wait. The same beat also carries the
   * wall-clock deadline re-check (see `proc/wait.ts`).
   */
  waitHeartbeatMs: 1000,
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
export const JOBS_BLOCK_VERSION = 'v2-2026-10';

/**
 * Head-room the executor's own `job_wait` timer leaves above the longest wait.
 *
 * It is a SECOND, INDEPENDENT clock, not a coupling to `toolTimeoutMs`
 * (extended-job-wait I-4'): the idle watchdog is paused for the whole wait, so
 * when `waitForJob` itself misbehaves this is the only thing left that can end
 * the call. `toolTimeoutMs` no longer constrains a wait at all.
 */
export const JOB_WAIT_MARGIN_MS = 30_000;

/** The executor ceiling for `job_wait`: the longest wait plus its margin (1230 s). */
export const JOB_WAIT_TOOL_CEILING_MS = PROC_LIMITS.waitMaxSeconds * 1000 + JOB_WAIT_MARGIN_MS;
