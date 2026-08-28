/**
 * The bounded review call (fast-model-tier §3.5.3, extracted here by
 * fast-model-tier-hardening W3).
 *
 * ASCII ONLY: `src/fast/**` is inside the glyph scanner's scope.
 *
 * THIS MODULE DOES NOT OWN AN `AbortController`, AND THAT IS A P0 PROHIBITION
 * RATHER THAN AN OVERSIGHT (RV-H1 / AC-H16). Encapsulating a controller with the
 * call it aborts is correct everywhere else in this codebase, which is exactly
 * why it has to be forbidden in writing here:
 *
 *   - `callAbort` and `callAbortReason` are SHARED MUTABLE STATE between the
 *     call and the lifecycle. The call arms them and reads the reason in its
 *     catch; `cancelCall()` — reached from `abort()`, `endRun()` and
 *     `dispose()` — stamps `'cancelled'` BEFORE aborting.
 *   - Once the controller is private to this module, that stamp becomes
 *     impossible, every cancelled review falls into the failure branch, and each
 *     one scores a strike. Three ordinary runs then self-disable the tier for the
 *     rest of the session behind a warn quoting an internal stream message.
 *   - It cannot be recovered at the catch: the retry layer returns SILENTLY on
 *     abort (`retry.ts` G3, deliberately — a user Esc must not be blamed on the
 *     network), so a cancellation and a timeout arrive as byte-identical bare
 *     `Error`s carrying no `errorType`.
 *
 * ROUND 1 SHIPPED THAT DEFECT AND FIXED IT AS IF-7. So this module RECEIVES the
 * signal and a timeout callback, and returns an outcome. It does not create,
 * own, or classify the abort. `fast-reviewer.test.ts`'s cancellation cases are
 * the behavioural guard; they were written before this file existed.
 */

import type { AssistantMessage, LLMRequest, ModelRef, TokenUsage } from '@aragon-agent/core';
import { FAST_LIMITS } from './limits.js';
import { buildReviewSystemPrompt } from './prompt.js';

/**
 * The two `LLMErrorType`s the retry layer classifies as retryable.
 *
 * THESE ARE TRANSIENT AND DO NOT COUNT AS STRIKES (D-24 / R-17). Self-disabling
 * exists for a MISCONFIGURED tier - a wrong model id, a dead gateway, a key with
 * no access - because that is the case a user must be told about, since it will
 * never fix itself. A fast provider that is merely busy for ninety seconds is
 * the opposite. This matters MORE since round 2 gave the reviewer a fail-fast
 * registry (W2): fewer retries means transients surface more often, so the
 * strike counter must keep ignoring them or the fail-fast policy would cause the
 * self-disable round 1 worked to prevent.
 */
const TRANSIENT_ERROR_TYPES: ReadonlySet<string> = new Set(['rate_limit', 'overloaded']);

/** The assistant text of a completion, or `''` for a tool-only answer. */
export function assistantText(message: AssistantMessage | undefined): string {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether a failure is the provider being busy rather than the tier being wrong. */
export function classifyReviewFailure(err: unknown): { errorType: string; transient: boolean } {
  const raw = (err as { errorType?: unknown } | null)?.errorType;
  const errorType = typeof raw === 'string' ? raw : 'unknown';
  return { errorType, transient: TRANSIENT_ERROR_TYPES.has(errorType) };
}

/**
 * The review's spend.
 *
 * OPTIONAL BY DECLARATION (RV-11). All three adapters populate `usage` before
 * yielding `done`, but the field is `usage?` on `AssistantMessage`, and
 * `computeCost(undefined, cost)` is a NaN that reaches the status bar and stays
 * there for the session.
 */
export function usageOf(message: AssistantMessage | undefined): {
  usage: TokenUsage;
  missing: boolean;
} {
  const usage = message?.usage;
  return {
    usage: usage ?? { inputTokens: 0, outputTokens: 0 },
    missing: usage === undefined,
  };
}

export function accumulateUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
  };
}

export interface ReviewRequestParams {
  ref: ModelRef;
  apiKey: string;
  digest: string;
  /** `fast.reviewMaxChars` — the ceiling the system prompt states. */
  reviewMaxChars: number;
  /** Created and owned by `reviewer.ts`; forwarded into `withRetry` from there. */
  signal: AbortSignal;
  now: number;
}

/**
 * The request one review sends. NO TOOLS, no thinking, one bounded user message.
 */
export function buildReviewRequest(params: ReviewRequestParams): LLMRequest {
  return {
    model: params.ref.modelId,
    ...(params.ref.baseUrl ? { baseUrl: params.ref.baseUrl } : {}),
    apiKey: params.apiKey,
    systemPrompt: buildReviewSystemPrompt({ maxChars: params.reviewMaxChars }),
    messages: [{ role: 'user', content: params.digest, timestamp: params.now }],
    maxTokens: FAST_LIMITS.reviewOutputTokens,
    // PAIRED WITH `temperature: 0` ON PURPOSE: the Anthropic adapter deletes
    // `temperature` whenever a thinking budget is set (`anthropic.ts:395-402`),
    // so these two are one choice and not two.
    thinkingLevel: 'off',
    temperature: 0,
    signal: params.signal,
  };
}

export interface ReviewCallParams extends ReviewRequestParams {
  complete(providerId: string, request: LLMRequest): Promise<AssistantMessage>;
  /**
   * Fired when `reviewTimeoutMs` elapses.
   *
   * THE CALLER ABORTS, NOT THIS MODULE. `reviewer.ts` implements this as "stamp
   * `callAbortReason = 'timeout'`, then abort", which is what keeps a timeout
   * (a strike) distinguishable from a cancellation (not a strike) once the retry
   * layer has flattened both into the same bare `Error` — see the file header.
   */
  onTimeout(): void;
}

export type ReviewCallOutcome =
  | { ok: true; message: AssistantMessage }
  | { ok: false; error: unknown };

/**
 * Send one review and bound it in time.
 *
 * THE TIMEOUT IS AUTHORITATIVE OVER THE RETRY LAYER'S SLEEP, and that is not
 * automatic (RV-H12). The fast registry spreads `DEFAULT_RETRY_POLICY`, so it
 * inherits `respectRetryAfter: true`, and a `Retry-After` is applied with
 * `Math.max` AFTER the `maxDelayMs` clamp (`retry.ts:316-324`) — one honoured
 * retry may therefore ask to sleep up to the 60 s `retryAfterCeilingMs`. Two
 * inherited properties stop that from pinning the single-flight slot for a
 * minute: `defaultSleep` resolves on either the timer or the signal's `abort`
 * (`retry.ts:417-427`, guard G2), and the `signal` this request carries is
 * forwarded into `withRetry` by `ProviderRegistry.stream()`. A change to either
 * is a change to this design.
 */
export async function runReviewCall(params: ReviewCallParams): Promise<ReviewCallOutcome> {
  const timer = setTimeout(params.onTimeout, FAST_LIMITS.reviewTimeoutMs);
  try {
    const message = await params.complete(params.ref.providerId, buildReviewRequest(params));
    return { ok: true, message };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}
