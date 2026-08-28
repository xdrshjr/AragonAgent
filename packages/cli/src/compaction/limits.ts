/**
 * COMPACTION_LIMITS — the single authority on every bound context compaction
 * enforces (context-auto-compaction §5.4).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts::inScope`), so no literal in this tree may hold a non-ASCII
 * byte. That regex is a HARDCODED DIRECTORY LIST, which is why adding this tree
 * and adding `compaction` to that list are the SAME change (C-7) - a scanner
 * that silently stops scanning is worse than no scanner. `fast/limits.ts`
 * records the identical trap one feature earlier.
 *
 * TWO KINDS OF NUMBER, AND THEY ARE NOT INTERCHANGEABLE - the distinction
 * `TEAM_LIMITS`, `TODO_LIMITS` and `FAST_LIMITS` all state:
 *
 *  - The entries below are STRUCTURAL. They describe what a digest, a
 *    summarization call and a card can physically carry. A user has no business
 *    tuning them.
 *  - The six `compaction.*` keys in `config/schema.ts` are POLICY: when to fire,
 *    how much to keep, which model, what to do on failure. Those are clamped,
 *    persisted and user-facing.
 */

export const COMPACTION_LIMITS = {
  /** Ceiling on the rendered digest, before the summarizer-window check. ~30k tokens. */
  digestMaxChars: 120_000,
  /** Output + system prompt + framing, kept out of the digest's share of the window. */
  summarizerReserveTokens: 8_000,

  // --- Per-message clips in the digest (§3.6.3). ---
  userChars: 2_000,
  assistantChars: 2_000,
  toolArgChars: 200,
  toolResultChars: 600,

  /**
   * Clip bound on the TAGGED text anchor.
   *
   * A CLIP, NOT A SHAPE SWITCH (D-21 / P1-9). v1 of the design kept the anchor
   * verbatim-standalone past this length and merged it into the block below it,
   * which made the anchor rule LENGTH-DEPENDENT and therefore non-idempotent: on
   * the second compaction the "first user message" is a summary. A 4 000-character
   * first message clipped with a visible marker keeps the rule "one leading
   * anchor, always recognizable"; a 40 000-character first message is not a goal
   * statement, and truncating it with a marker is the honest outcome.
   */
  anchorChars: 4_000,
  /** What the summarizer prompt asks for, and what the splice clips to. */
  summaryMaxChars: 6_000,
  summaryOutputTokens: 2_048,

  /**
   * Wall-clock budget for ONE summarization call.
   *
   * Longer than the fast reviewer's 20 s because the input is ~30x larger and the
   * output ~4x larger, and because the cost of a timeout here is a DEGRADED RUN
   * rather than a missing critique.
   *
   * COUPLED TO THE ENGINE'S `COMPACTION_HARD_TIMEOUT_MS` (120 s). The worst legal
   * host budget is two calls at this value back to back plus the digest render,
   * so `2 * callTimeoutMs` must stay strictly under the engine's ceiling. Raising
   * this without raising that makes the §3.7 ladder unreachable and turns every
   * slow-but-correct summarization into `manager_timeout`.
   */
  callTimeoutMs: 45_000,

  // --- Anti-loop guards (§3.8). ---
  /** Turns between compactions. Never two in a row: a compaction that just ran
   *  needs a real turn before its effect is measurable, because `lastUsage` is
   *  still the pre-compaction number until the next `turn_end`. */
  minTurnsBetween: 2,
  /** Compactions STARTED per run, both triggers, hard. */
  maxPerRun: 5,
  /** A splice must project occupancy below `threshold - this`, or it bought two turns. */
  minReclaimRatio: 0.15,
  /** Consecutive no-progress PRESSURE compactions before the proactive trigger self-disables. */
  stuckLimit: 2,

  // --- Tail relief (hardening §3.3 / W2). ---
  /**
   * Clip bound on an oversized `tool_result` body inside the RETAINED tail.
   *
   * 2 000 rather than `toolResultChars`' 600, and the two are not the same
   * question. That one bounds a message in the DIGEST, which the summarizer
   * reads once and which exists to be lossy. This one bounds a message the model
   * keeps WORKING FROM: it is the last two-to-four turns, and the run is about to
   * continue on them. Relief only ever runs when the alternative is a request the
   * provider cannot accept.
   */
  tailToolResultChars: 2_000,
  /**
   * Room reserved for the `<compacted_context>` block in the tail-budget
   * projection.
   *
   * THE BLOCK IS WRITTEN AFTER THE PROJECTION, which is why this exists at all:
   * relief measures a spliced history whose summary body is already in it, but
   * the `plan === null` path measures one where nothing has been written yet, and
   * a budget with no allowance would let the block push the result back over.
   */
  blockAllowanceTokens: 2_000,

  // --- The archive (hardening §3.5 / W4). ---
  /**
   * Files kept for ONE `runId`, newest first.
   *
   * PER RUN, NOT PER DIRECTORY (RV-6). `<home>/compaction/` is shared by every
   * `aragon` on the machine — `file-sink.ts:94-95` already treats concurrent
   * processes as normal — so a global count-based prune would delete a live
   * session's archives out from under it.
   */
  archiveMaxFiles: 20,
  /**
   * The cross-run sweep: 7 days.
   *
   * AGE RATHER THAN COUNT, for the reason above. Age can only ever delete files
   * whose run finished a week ago; a count can delete the newest file another
   * process wrote a second ago.
   */
  archiveMaxAgeMs: 604_800_000,
  /**
   * Per-file ceiling before dropped message bodies are clipped from the OLDEST
   * end. The metadata and the summary are never clipped: a truncated archive
   * that still says what happened beats none.
   */
  archiveMaxBytes: 8_000_000,

  // --- Sub-agent compaction (hardening §3.4 / W3). ---
  /** A child's `keepRecentTurns`, delivered through its config view. */
  childKeepRecentTurns: 2,
  /**
   * A child's guard-2 ceiling, delivered through `Compactor`'s instance bound.
   *
   * HERE RATHER THAN AS A `compaction.*` KEY, and the placement is the whole
   * argument: `maxPerRun` is STRUCTURAL (see this file's header), there is no
   * config path to it by design, and a child needs a tighter one. Both numbers
   * therefore stay in the one file that owns structural bounds.
   */
  childMaxPerRun: 2,

  /** Rows the collapsed transcript card renders; Ctrl+O expands. */
  cardTextRows: 6,
  /**
   * Below this many columns the status chip drops.
   *
   * 100, matching all four existing peers - `retry-view.ts`, `fast/limits.ts`,
   * `team/limits.ts`, `todo/limits.ts` (P2-2). A status-bar degradation ladder
   * that is nearly-but-not-quite uniform is a reading hazard bought for nothing.
   * The guaranteed reporting surface is `/compact status`, which is what makes
   * dropping the chip acceptable at all.
   */
  statusCompactCols: 100,
} as const;

/**
 * Bumped whenever the wording of the `<compacted_context>` block or the
 * summarizer system prompt changes, so a behaviour report can be tied to a block
 * revision with one grep - exactly what `FAST_BLOCK_VERSION` and
 * `TEAM_BLOCK_VERSION` are for.
 */
export const COMPACTION_BLOCK_VERSION = 'v1-2026-08';

/** Opening tag of the verbatim goal anchor (§3.6.5). */
export const ANCHOR_TAG_OPEN = '<original_task>';
export const ANCHOR_TAG_CLOSE = '</original_task>';
/** Opening tag of the spliced summary block. Recognized on the NEXT compaction. */
export const BLOCK_TAG_OPEN = '<compacted_context';
export const BLOCK_TAG_CLOSE = '</compacted_context>';
/** Marker appended to an anchor clipped at `anchorChars`. ASCII (see the header). */
export const ANCHOR_TRUNCATION_MARK = ' [truncated]';

/**
 * What tail relief writes where it removed text (hardening §3.3.2 rule 4).
 *
 * IN THE HISTORY THE MODEL READS, at the exact place the data went missing. A
 * model that sees this knows the output is partial and can re-run the tool; a
 * model handed a silently truncated file cannot tell the difference between "the
 * file ends here" and "the file was cut here".
 *
 * THE HOST OWNS IT, not core: `engine/compaction.ts` has no glyph vocabulary and
 * must not learn one, so `relieveTail` takes this as a callback. ASCII, per this
 * file's header.
 */
export function tailClipMarker(removed: number): string {
  return `\n[... ${removed} characters removed by context compaction ...]`;
}
