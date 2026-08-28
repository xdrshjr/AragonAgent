/**
 * UPDATE_LIMITS - the single authority on every structural bound the updater
 * enforces (cli-auto-update section 5.4).
 *
 * ASCII ONLY: `src/update/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts`), so no literal in this tree may hold a non-ASCII byte. The
 * regex there is a hardcoded directory list, which is why adding this tree and
 * adding `update` to that list are the SAME change (C-2 / AC-18) - a scanner
 * that silently stops scanning is worse than no scanner.
 *
 * TWO KINDS OF NUMBER, AND THEY ARE NOT INTERCHANGEABLE - the distinction
 * `TEAM_LIMITS`, `TODO_LIMITS` and `FAST_LIMITS` all state:
 *
 *  - The entries below are STRUCTURAL. They describe what a background check, a
 *    detached install and a one-row readout can physically carry. A user has no
 *    business tuning them.
 *  - The four `update.*` keys in `config/schema.ts` are POLICY: whether to
 *    install at all, how often to ask, which registry, which dist-tag. Those are
 *    clamped, persisted and user-facing.
 *
 * NOTHING HERE IS IMPORTED AT RUNTIME BY `cli.tsx` (AC-1). This module and
 * `types.ts` are pure, dependency-free and side-effect-free; every other module
 * in this tree is reached only through the dynamic `import()` in section 3.8.
 */

export const UPDATE_LIMITS = {
  /** Never contend with first paint. */
  startupDelayMs: 3_000,
  /**
   * A background check has nobody waiting on it.
   *
   * Below `fetch-source.ts`'s `HTTP_TIMEOUT_MS` (15 s) ON PURPOSE: that one
   * bounds a download a human typed a command for, this one bounds a request the
   * user never asked for and must never notice.
   */
  checkTimeoutMs: 8_000,
  /**
   * Wall-clock budget for the `installing` PHASE and the lock's staleness
   * refresh - NEVER FOR THE CHILD (U-5 / P1-5).
   *
   * It decides when the UI stops saying "updating" and when a lock is treated as
   * abandoned. It is deliberately NOT `execFile`'s `timeout`, which stays `0`:
   * wiring it there makes Node `SIGTERM` npm mid-write - the broken global
   * installation U-3 and D-10 exist to prevent - and it would fire on exactly
   * the slow links where a five-minute install is the correct outcome.
   */
  installTimeoutMs: 300_000,
  /** The `/latest` document is ~2 KB; this is the C-8 ceiling, not a target. */
  manifestMaxBytes: 256 * 1024,
  /** Matches `fetch-source.ts`'s `MAX_REDIRECTS`. */
  maxRedirects: 3,
  /**
   * Longer than `skills`' 60 s, and the difference is the point: the holder here
   * is an npm install on a cold cache, not a file rename.
   */
  lockTtlMs: 600_000,
  /** First retry after a failed check or install. */
  backoffBaseMs: 1_800_000,
  /** Ceiling of the exponential. */
  backoffMaxMs: 86_400_000,
  /**
   * Consecutive failures before the row says anything at all (D-7).
   *
   * Below this the failure is silent, because silence is the requirement and an
   * unactionable recurring warning is the standard way updaters become hated.
   */
  failuresBeforeNotice: 3,
  /** Thundering-herd spread on the check interval (D-12). */
  jitterRatio: 0.15,
  /**
   * Bounded, redacted npm error tail, read from the install LOG FILE (U-5).
   *
   * There is a tail to read at all only because the child writes to a real file
   * descriptor rather than to `'ignore'`; a pipe would have died with the parent
   * and broken D-10.
   */
  stderrTailChars: 500,
  /**
   * Below this many columns the update line renders its short form (section 6.2).
   *
   * DELIBERATELY NOT `FAST_LIMITS.statusCompactCols`' 100 (`fast/limits.ts`).
   * That number governs a multi-part status chip competing with the context
   * gauge for the same row; this one governs a single short clause that owns its
   * row outright. Two numbers about two different things - do not unify them.
   */
  statusCompactCols: 60,
  /**
   * Non-zero exits of a version WE installed before it is rolled back
   * (cli-auto-update-hardening section 7.2 / D-30).
   *
   * Tested against the count of PREVIOUS launches, so `2` means "the third
   * launch rolls back". One crash can be transient - a machine that ran out of
   * memory once, or whose session file was corrupt, gets a second chance at the
   * release it just installed. Two is a pattern.
   *
   * NOTHING ELSE IN THIS TABLE BOUNDS THE ROLLBACK. There is deliberately no
   * `bootGuardMaxAgeMs`: the guard is armed only while `autoInstalledVersion`
   * equals the RUNNING version, so "a machine offline for a year" is a machine
   * still running the version we installed, and rolling it back to
   * `lastGoodVersion` is exactly as correct on day 400 as on day 1 (P1-3).
   */
  crashesBeforeRollback: 2,
  /**
   * Bound on the `npm view` fallback probe (H3).
   *
   * SAFE HERE AND FORBIDDEN FOR THE INSTALLER (C-20). A killed `npm view` has
   * written nothing; a killed `npm install -g` leaves a broken global
   * installation, which is why `installTimeoutMs` above bounds the PHASE and
   * never the child.
   */
  npmViewTimeoutMs: 10_000,
} as const;
