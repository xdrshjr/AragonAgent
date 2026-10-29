/**
 * Human wording for compaction outcomes (context-compaction-never-fires C).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts::inScope`), so every glyph the card draws comes from
 * `pickGlyphs` and nothing here may carry a non-ASCII byte.
 *
 * WHY THIS MODULE EXISTS AT ALL. The card used to print the raw rejection code
 * (`context not compacted #4: digest_budget_exceeded: $.digest`), which names the
 * internal gate and tells the user nothing they can act on. A decline is a
 * QUESTION ("why, and what do I do now"), so each code gets one phrase and - for
 * the ones a user can act on - one remedy.
 *
 * IT IS ALSO THE SELF-DISABLE NOTICE'S SOURCE. The one line that says
 * auto-compaction has paused reads the same phrase, so the card and the toast
 * cannot describe one failure two ways.
 */
import type { CompactionPhase } from './types.js';

/** One phrase plus, where it helps, the thing the user can do about it. */
export interface ReasonText {
  /** What happened, in one clause. Never contains the raw code. */
  text: string;
  /** The remedy, or `undefined` when there is nothing to offer. */
  action?: string;
}

const REASONS: Readonly<Record<string, ReasonText>> = {
  nothing_to_drop: {
    text: 'no safe cut - this run has too few user turns to keep',
    action: 'keep talking, or lower /compact keep',
  },
  digest_budget_exceeded: {
    text: 'the summary input was too large for one call',
    action: 'retry - the middle is elided now',
  },
  summarizer_window_exceeded: {
    text: 'the summary request does not fit the summarizer window',
    action: 'pick a summarizer with a larger window',
  },
  protected_memory_too_large: {
    text: 'the task memory does not fit its protection budget',
    action: 'start a fresh conversation',
  },
  invalid_memory_delta: {
    text: 'the summarizer returned an unusable memory delta',
    action: 'retry',
  },
  empty_memory_delta: {
    text: 'the summarizer returned an empty memory delta',
    action: 'retry',
  },
  no_token_reclaim: {
    text: 'the summary would not have reclaimed any tokens',
  },
  timeout: { text: 'the summarizer timed out', action: 'retry' },
  no_summarizer_model: {
    text: 'no summarizer model resolves',
    action: 'set a model or add a provider key',
  },
  no_api_key: { text: 'the summarizer provider has no API key' },
  already_running: { text: 'another compaction is already running' },
  invalid_prior_memory: {
    text: 'the existing task memory does not match this history',
    action: 'start a fresh conversation',
  },
  invalid_history: { text: 'this history cannot be split safely' },
  protected_multimodal_tail: {
    text: 'an image in the middle of this history would have to be dropped',
  },
  insufficient_reclaim: {
    text: 'the splice freed too little to stay below the threshold',
  },
  disabled: { text: 'auto-compaction is off for this session', action: '/compact on' },
  cancelled: { text: 'cancelled' },
  aborted: { text: 'cancelled' },
  stale_history: { text: 'the history changed while the summary was running' },
  adoption_failed: { text: 'the compacted history could not be adopted' },
};

/** Every rejection code that has wording above; a GUI that localizes them checks itself against this. */
export const COMPACTION_REASON_CODES: readonly string[] = Object.keys(REASONS);

/** The code part of a reason string (`digest_budget_exceeded: $.digest` -> `digest_budget_exceeded`). */
export function compactionReasonCode(reason: string): string {
  return reason.split(':', 1)[0]!.trim();
}

/**
 * A phrase for a rejection code, falling back to the code itself.
 *
 * THE FALLBACK IS THE RAW CODE, deliberately: a new gate nobody wrote wording for
 * must still say SOMETHING specific on the card, and an invented sentence would
 * be worse than a code the next reviewer can grep.
 */
export function describeCompactionReason(reason: string): ReasonText {
  const code = reason.split(':', 1)[0]!.trim();
  return REASONS[code] ?? { text: reason };
}

/** The card's one-line reason, with the remedy appended when there is one. */
export function compactionReasonLine(reason: string): string {
  const { text, action } = describeCompactionReason(reason);
  return action ? `${text} (${action})` : text;
}

const PHASES: Readonly<Record<CompactionPhase, string>> = {
  planning: 'planning the cut',
  digesting: 'building the digest',
  summarizing: 'summarizing',
  validating: 'validating the summary',
  applying: 'applying',
};

export function compactionPhaseLabel(phase: CompactionPhase): string {
  return PHASES[phase];
}
