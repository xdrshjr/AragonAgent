/**
 * Structural bounds for session identity and the session checkpoint
 * (tui-session-id-resume §3.13).
 *
 * ASCII ONLY - `src/session/**` is inside `glyphs.test.ts::inScope`.
 *
 * STRUCTURE, NOT POLICY: these are the shapes an id and a checkpoint can
 * physically take, so they live in the subsystem's own `limits.ts` like every
 * other subsystem's do (CLAUDE.md: "`limits.ts` is structural,
 * `config/schema.ts` is policy"). Nothing here is user-tunable (D-19): a
 * "show an id but never write it" switch would manufacture the one state this
 * feature must not have - an id a user can copy and cannot use.
 */

export const SESSION_ID_LIMITS = {
  /** 6 characters of `SESSION_ID_ALPHABET`: 31^6 is about 8.9e8 ids. */
  idLength: 6,
  /** The branch suffix, `-` plus this many characters. */
  suffixLength: 4,
  /** The upper bound `SESSION_ID_RE` already imposes (`store.ts:50`). */
  maxIdLength: 64,
  /** `maxIdLength - 1 - suffixLength` = 64 - 1 - 4. */
  maxRootLength: 59,
  /** `wx` reservation attempts before a fresh id is minted instead. */
  reserveAttempts: 5,
} as const;

export const SESSION_CHECKPOINT_LIMITS = {
  /** The window several `agent_end` events are merged into (T-11b). */
  debounceMs: 750,
  /** Floor between two writes, so a burst cannot land twice in one turn. */
  minWriteIntervalMs: 250,
  /** `renameSync` retries when Windows refuses to replace an open file (D-4). */
  renameAttempts: 3,
  /** Gap between those retries, waited synchronously (`Atomics.wait`). */
  renameRetryMs: 20,
  /** Consecutive failures before the log record is raised from warn to error. */
  loudFailureStreak: 3,
} as const;

/**
 * Structural bounds for branching a session into a NEW terminal window
 * (tui-branch-terminal-shortcut 5.3).
 *
 * WHY THESE LIVE HERE (R-12): this file's header says STRUCTURE, NOT POLICY, and
 * `cooldownMs` is a timing policy. The precedent is already in this file -
 * `SESSION_CHECKPOINT_LIMITS.debounceMs` / `minWriteIntervalMs` are timing
 * policies of exactly the same kind. D-17 keeps every one of these out of
 * `config/schema.ts`, so none of them is user-tunable.
 *
 * EVERY ENTRY NEEDS AN ENFORCEMENT POINT (R-7): a declared limit nobody checks is
 * worse than no limit, because it makes a review believe the case was handled.
 * `cooldownMs` is read in `branch-launch.ts` steps 1-2, `titleMaxCells` by
 * `truncateTitle()` in step 7, `spawnProbeMs` by the `trySpawn` timer,
 * `maxCommandLineCells` in step 4.5 BEFORE any spawn, and `maxRungs` as the
 * bound of the rung loop in step 8.
 */
export const BRANCH_TERMINAL_LIMITS = {
  /** Minimum gap between two successful opens (D-10). FAILURES DO NOT CONSUME IT. */
  cooldownMs: 2_000,
  /** Max cells of the new window title (`aragon ` + id; an id can be 64 long). */
  titleMaxCells: 60,
  /** How long to wait for the `'spawn'` event; a timeout counts as success. */
  spawnProbeMs: 1_500,
  /** Hard cap on one command line (base64 included); over it we refuse (step 4.5). */
  maxCommandLineCells: 8_000,
  /** How many rungs to try (the POSIX candidate table can be long; 3 covers reality). */
  maxRungs: 3,
} as const;
