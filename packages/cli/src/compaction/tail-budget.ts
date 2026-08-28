/**
 * The tail-relief projection - what a retained tail may occupy, and whether it
 * has to be clipped (context-auto-compaction-hardening §3.3.3 / W2).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope.
 *
 * ITS OWN MODULE BY A PRE-MADE DECISION, not an improvised split. The design's
 * §7 records it in advance: "If `compactor.ts` approaches the guideline during
 * implementation, the tail-relief projection block moves to
 * `compaction/tail-budget.ts` - noted here so the decision is not improvised."
 * It did (`CLAUDE.md` caps a source file at 1 000 lines), so it did.
 *
 * PURE APART FROM THE LOG SINK. Everything it needs arrives as an argument,
 * which is what lets the projection be tested without standing up a `Compactor`.
 */

import {
  estimatePromptTokens,
  relieveTail,
  type Message,
  type TailReliefResult,
} from '@aragon-agent/core';
import { COMPACTION_LIMITS, tailClipMarker } from './limits.js';
import { requiredHeadroom } from './pressure.js';

/**
 * What the whole history may occupy and still leave room for one reply.
 *
 * THE BLOCK ALLOWANCE IS NOT PADDING. On the `plan === null` path the
 * `<compacted_context>` block has not been written when this is measured, so a
 * budget with no room reserved for it would let the block push the relieved
 * history straight back over.
 */
export function tailBudgetTokens(input: {
  contextWindow: number;
  maxOutputTokens: number;
}): number {
  return Math.max(
    0,
    input.contextWindow -
      requiredHeadroom({ maxOutputTokens: input.maxOutputTokens }) -
      COMPACTION_LIMITS.blockAllowanceTokens,
  );
}

export interface TailReliefAttempt {
  messages: readonly Message[];
  /** Index the tail starts at; nothing before it is eligible. */
  from: number;
  systemPrompt: string;
  budget: number;
  /** W2 fires rarely; when it does it is the most interesting event in the session. */
  log: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * Relieve the tail when - and ONLY when - the history is over budget.
 * `null` means "it fits, or nothing was eligible".
 *
 * THE PROJECTION IS THE GATE. Relief is a real, bounded, announced data loss
 * inside the turns the run is about to continue from, so it must never become a
 * routine tidy-up: it runs only when the alternative is a request the provider
 * cannot accept.
 */
export function attemptTailRelief(attempt: TailReliefAttempt): TailReliefResult | null {
  if (attempt.budget <= 0) return null;
  const projected = estimatePromptTokens(attempt.messages as Message[], attempt.systemPrompt);
  if (projected <= attempt.budget) return null;

  const relief = relieveTail(attempt.messages, {
    from: attempt.from,
    clipChars: COMPACTION_LIMITS.tailToolResultChars,
    targetTokens: attempt.budget,
    systemPrompt: attempt.systemPrompt,
    marker: tailClipMarker,
  });
  if (relief.clippedMessages === 0) return null;

  attempt.log('compaction_tail_relief', {
    clippedMessages: relief.clippedMessages,
    charsRemoved: relief.charsRemoved,
    projectedBefore: projected,
    budget: attempt.budget,
  });
  return relief;
}

/** The shape `CompactionRecord.tailRelief` and the archive both carry. */
export function reliefSummary(relief: TailReliefResult): {
  messages: number;
  charsRemoved: number;
} {
  return { messages: relief.clippedMessages, charsRemoved: relief.charsRemoved };
}
