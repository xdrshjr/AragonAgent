/**
 * FAST_LIMITS — the single authority on every bound the fast tier enforces
 * (fast-model-tier §5.5).
 *
 * ASCII ONLY: `src/fast/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts`), so no literal in this tree may hold a non-ASCII byte. The
 * regex there is a hardcoded directory list, which is why adding this tree and
 * adding `fast` to that list are the SAME change (C-4 / AC-27) - a scanner that
 * silently stops scanning is worse than no scanner.
 *
 * TWO KINDS OF NUMBER, AND THEY ARE NOT INTERCHANGEABLE - the distinction
 * `TEAM_LIMITS` and `TODO_LIMITS` both state:
 *
 *  - The entries below are STRUCTURAL. They describe what a review call, a
 *    digest and a card can physically carry. A user has no business tuning them.
 *  - The ten `fast.*` keys in `config/schema.ts` are POLICY: which model, how
 *    often, how long a critique may be. Those are clamped, persisted and
 *    user-facing.
 *
 * `reviewMaxChars` therefore lives in the CONFIG and not here: it is the one
 * number whose right value depends on how much of their own context the user is
 * willing to spend on advice. `reviewOutputTokens` stays here because 512 tokens
 * is a bound on a protocol, not a preference.
 */

export const FAST_LIMITS = {
  /**
   * The flat input cost of one review (D-6 / R-2).
   *
   * THIS NUMBER IS THE WHOLE ECONOMIC ARGUMENT. The reviewer builds its own
   * bounded frame ring and never reads `agent.state.messages`, which after four
   * 60 KB file reads carries 240 KB of file bodies; shipping that to the "cheap"
   * model would make a review cost MORE than the turn it is reviewing.
   */
  digestMaxChars: 4_000,
  /** The user's request for the run, clamped. Without it the reviewer is asked
   *  whether work is on track without being told what the track is. */
  goalChars: 500,
  /** Per-frame assistant-text tail. Rolling, clipped on every append. */
  turnTailChars: 600,
  /** Per picked tool argument. Mirrors `TEAM_LIMITS.activityArgChars`. */
  toolArgChars: 120,
  /** Frames kept per run. `>=` the max of `reviewContextTurns`, with slack. */
  maxFramesRetained: 12,

  /** Hard cap on the review's own output. */
  reviewOutputTokens: 512,
  /**
   * Wall-clock budget for ONE review call INCLUDING RETRIES (D-H11).
   *
   * THE BUDGET HAS TWO TERMS AND ONLY ONE OF THEM SHRANK. Round 1 set 30 s as
   * IF-3's fallback: `ProviderRegistry.complete()` routed through a retrying
   * `stream()` with `maxRetries: 10`, so the budget covered
   * `attempts x (call + backoff)`. Round 2 gives the reviewer its own
   * `maxRetries: 1` registry (`wiring.ts`), which collapses that term to about
   * one call plus a one-second backoff - but it does nothing at all to the
   * other term, THE FAST MODEL'S OWN GENERATION LATENCY. The review asks for up
   * to `reviewOutputTokens` from a `digestMaxChars` prompt, and the tier is by
   * construction pointed at the cheapest endpoint the user has: the population
   * where a 15-25 s completion is ordinary rather than pathological.
   *
   * SO THIS IS 20 000 AND NOT 12 000. A timeout IS a strike (see `runReview`),
   * and `maxConsecutiveFailures` is 3, so a 12 s bound would convert "slow but
   * healthy provider" into a tier that self-disables for the session and
   * reports itself as MISCONFIGURED - the one register D-24 reserves for faults
   * that never self-heal, spent on one that does. 20 s keeps a margin over a
   * slow completion and still cuts a stuck review's occupancy of the
   * single-flight slot by a third. Lower it only with a measured p99, which
   * `manual-test.md` row 6 exists to produce.
   */
  reviewTimeoutMs: 20_000,
  /** Reviews STARTED per run. A 40-turn run at cadence 5 would otherwise buy 8
   *  critiques the lead increasingly ignores. */
  maxReviewsPerRun: 6,
  /** Consecutive NON-TRANSIENT failures before the reviewer self-disables. */
  maxConsecutiveFailures: 3,

  /**
   * A critique waiting for its injection window goes stale (RV-12).
   *
   * The window is not guaranteed to be prompt: one `task` dispatch is a single
   * tool call that can run for as long as its children need, so a critique triggered
   * just before one arrives at the far side describing a state five children
   * have since rewritten. Advice that is merely late is worse than no advice,
   * because the lead cannot tell that it is late.
   */
  pendingMaxAgeMs: 120_000,
  /** ... or is overtaken by the run itself, in turns. */
  pendingMaxTurnsBehind: 2,

  /** Rows the transcript card renders before eliding. */
  cardTextRows: 4,
  /** Below this many columns the status chip drops (D-20's treatment, not
   *  `agentMode`'s - the guaranteed reporting surface is `/fast status`). */
  statusCompactCols: 100,
} as const;

/**
 * Bumped whenever the wording of `<fast_tier>` or the review system prompt
 * changes, so a behaviour report can be tied to a block revision with one grep -
 * exactly what `TEAM_BLOCK_VERSION` and `TODO_BLOCK_VERSION` are for.
 */
export const FAST_BLOCK_VERSION = 'v2-2026-10';

/**
 * The bounds one task-summary label may consume
 * (tui-shortcut-drawer-and-task-summary D-11).
 *
 * STRUCTURAL, NOT POLICY, for the reason this file's header records: these say
 * what a one-line header label can PHYSICALLY carry, not what the user prefers.
 * The two user switches (`taskSummary.enabled` / `.fallback`) live in
 * `config/schema.ts` and are not interchangeable with these.
 *
 * THE THREE CAPS HAVE THREE DIFFERENT JOBS, and v1 left that implicit (P1-8):
 *
 *  - GENERATION (the system prompt in `summary-prompt.ts`): at most 6 words in
 *    space-separated languages, at most 12 characters in CJK. The normal path is
 *    constrained by this and by nothing else.
 *  - NORMALISATION (`normalizeTaskSummary`): `summaryMaxWords` and
 *    `cjkMaxGraphemes` are applied first, then `summaryMaxChars` catches the one
 *    case those two cannot - a long run with no whitespace. That order is
 *    asserted by `task-summary-normalize.test.ts`.
 *  - RENDERING: `maxCells` is the hard ceiling on the header cell. The header
 *    fits within whatever width is left; the drawer WRAPS instead of cutting.
 */
export const TASK_SUMMARY_LIMITS = {
  /** Hard cap on the call's own output. A label is not a paragraph. */
  outputTokens: 64,
  /**
   * Wall-clock budget for ONE summary call, INCLUDING the fast registry's single
   * retry. Short on purpose: the label is decoration on the header row, and a
   * user waiting for the first token must never wait on it - the call is fired
   * after `prompt()` has been started and nothing awaits it (AC-13).
   */
  timeoutMs: 8_000,
  /** How much of the user's message is sent. Long prompts are summarised from the head. */
  anchorMaxChars: 2_000,
  /** Storage ceiling. Only ever reached by a model that ignored the prompt rules. */
  summaryMaxChars: 60,
  /** Space-separated languages: the label is at most this many words. */
  summaryMaxWords: 8,
  /** CJK: the label is at most this many grapheme clusters. */
  cjkMaxGraphemes: 12,
  /**
   * The header cell's hard ceiling in terminal COLUMNS (not characters).
   *
   * Shared by `ui/layout/header-left.ts` and the drawer so the two cannot
   * disagree about how wide a label is allowed to be. v1 referenced this
   * constant without defining it (P1-8).
   */
  maxCells: 28,
} as const;

/**
 * Bumped whenever the task-summary system prompt's wording changes, so a
 * behaviour report can be tied to a revision with one grep - the same purpose
 * `FAST_BLOCK_VERSION` serves for the review prompt.
 */
export const TASK_SUMMARY_PROMPT_VERSION = 'v1-2026-10';
