/**
 * Runtime shapes for the fast tier (fast-model-tier §5.2 / §5.3).
 *
 * ASCII ONLY: `src/fast/**` is inside the glyph scanner's scope.
 *
 * `FastEvent` is a CLI-LOCAL stream and must stay that way (D-10 / I-1), for
 * the reason `TeamEvent` and `TodoEvent` each record: `packages/core` freezes
 * its runtime export list (`public-api.test.ts`) and forbids host coupling
 * (`no-host-coupling.test.ts`), so a new member of core's `AgentEvent` union
 * would break the first and teach core about a host shape it has no business
 * defining. This whole feature therefore changes ZERO files under
 * `packages/core/` (AC-30).
 */

import type { ModelRef, ThinkingLevel, TokenUsage } from '@aragon-agent/core';

/** Which model runs a piece of work. Two tiers, and deliberately not three. */
export type FastTierName = 'main' | 'fast';

/**
 * The resolved fast tier, or the reason there isn't one.
 *
 * A DISCRIMINATED UNION rather than a nullable `ModelRef`, because every UI
 * surface has to be able to say WHY the tier is off: "enabled but no model" and
 * "enabled but no key for openai" send the user to two different settings.
 */
export type FastTier =
  | { ok: true; ref: ModelRef; thinkingLevel: ThinkingLevel; sameAsMain: boolean }
  | { ok: false; reason: FastTierOffReason };

export type FastTierOffReason = 'disabled' | 'no_model' | 'no_adapter' | 'no_key';

/**
 * One completed turn of the lead, as the reviewer records it.
 *
 * `sealed` is what §3.5.1 turns on: a frame is complete only once every
 * `tool_execution_end` of its batch has landed, because `isError` and `ms` do
 * not exist before then (`agent-loop.ts:249-256`). A digest built from an
 * unsealed frame is structurally missing the single fact a reviewer most needs -
 * whether the batch it is reviewing just failed (RV-2 / D-22).
 */
export interface TurnFrame {
  /** 1-based within the run. */
  index: number;
  /** <= FAST_LIMITS.turnTailChars, appended and clipped per `text_delta`. */
  textTail: string;
  tools: Array<{ name: string; arg?: string; isError?: boolean; ms?: number }>;
  /** `formatStreamError` output, when the turn errored. */
  error?: string;
  /** Complete, and safe to digest (§3.5.1). */
  sealed: boolean;
}

/** One review, in whatever state it reached. Rendered by `FastCard`. */
export interface FastReview {
  /** 1-based within the SESSION, so `/fast status` can count them. */
  index: number;
  runId: number;
  /** The turn that triggered it. */
  turn: number;
  /** The resolved fast model id, for the card and the injected wrapper. */
  model: string;
  kind: 'ok' | 'advice' | 'empty' | 'failed' | 'dropped';
  /** Present only for `advice`. */
  text?: string;
  /** Failure reason / drop reason. */
  detail?: string;
  durationMs: number;
  usage?: TokenUsage;
  injected: boolean;
}

/** Everything `/fast status`, the chip and the settings line read. */
export interface FastSnapshot {
  /** The tier resolved AND the live switch is on. */
  live: boolean;
  /**
   * The reviewer switched ITSELF off after `maxConsecutiveFailures` in a row
   * (`FastReviewer.onReviewFailure`).
   *
   * ORTHOGONAL TO `live`, AND NEITHER IMPLIES THE OTHER. `live` answers "did
   * this tier resolve at all" and is `registered && enabled && tier.ok`; the
   * self-disable touches none of those three, so `live` stays `true` after it.
   * A consumer that wants to report "the fast reviews stopped happening" MUST
   * read this field: deriving it as `live === false` is a predicate that can
   * never be true, and a hand-written fixture makes its test green for ever.
   *
   * `available()` is deliberately NOT widened to include it — see the note on
   * `FastWiring.available`.
   */
  selfDisabled: boolean;
  model: string;
  sameAsMain: boolean;
  reviews: number;
  /** The live session budget, for the `n/N` render (fast-model-tier-hardening
   *  §5). Read in the SAME expression as `reviews`, so the numerator and the
   *  denominator cannot describe different moments. */
  reviewBudget: number;
  /**
   * Whether the session budget is exhausted. CARRIED, NOT DERIVED: callers MUST
   * NOT recompute `reviews >= reviewBudget`. In `offFastStatus()` both numbers
   * are `0` placeholders for "there is no tier", and that comparison would
   * report a budget reached for a session that never had one (RV-H10).
   */
  budgetReached: boolean;
  usage: TokenUsage;
  /**
   * No price table for `model` (C-11 / RV-4).
   *
   * `ModelRegistry.buildRuntimeModel` returns `cost: { input: 0, output: 0 }`
   * for a model the static table has never seen, and the fast tier is precisely
   * where an unrecognised id is LIKELY. Rendering that as `$0.00` would make the
   * feature look free while it is spending money.
   */
  pricingUnknown: boolean;
  /** A review call is open right now. */
  inFlight: boolean;
}

/**
 * The CLI-local event stream. `FastReviewer` emits; `FastWiring` forwards;
 * `AgentController.subscribeFast` exposes; `App` and `runHeadless` consume.
 */
export type FastEvent =
  | { type: 'review_start'; index: number; turn: number }
  | { type: 'review_end'; review: FastReview }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'tier_changed'; snapshot: FastSnapshot };

export type FastEventListener = (event: FastEvent) => void;
