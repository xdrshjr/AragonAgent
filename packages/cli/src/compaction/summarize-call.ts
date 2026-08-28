/**
 * The bounded summarization call (context-auto-compaction §3.6.4).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope.
 *
 * THIS MODULE DOES NOT OWN AN `AbortController`, AND THAT IS A PROHIBITION
 * RATHER THAN AN OVERSIGHT - the identical rule `fast/review-call.ts` records at
 * length, and for the identical reason: the retry layer returns SILENTLY on
 * abort, so a cancellation and a timeout arrive as byte-identical bare `Error`s
 * carrying no `errorType`. Once the controller is private to this module, the
 * caller can no longer stamp WHICH of the two happened, and every cancelled
 * summarization is misreported as a failure.
 *
 * So this module RECEIVES the signal and a timeout callback, and returns an
 * outcome. It does not create, own, or classify the abort.
 */

import type { AssistantMessage, LLMRequest, ModelRef, TokenUsage } from '@aragon-agent/core';
import { COMPACTION_LIMITS } from './limits.js';
import { buildSummarySystemPrompt, buildSummaryUserMessage } from './summary-prompt.js';

/** The assistant text of a completion, or `''` for an answer with no text block. */
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

/**
 * The call's spend.
 *
 * OPTIONAL BY DECLARATION. All three adapters populate `usage` before yielding
 * `done`, but the field is `usage?` on `AssistantMessage`, and a `computeCost`
 * over `undefined` is a NaN that reaches the status bar and stays there for the
 * session (the RV-11 lesson from the fast tier).
 */
export function usageOf(message: AssistantMessage | undefined): TokenUsage {
  return message?.usage ?? { inputTokens: 0, outputTokens: 0 };
}

export function accumulateUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
  };
}

export interface SummarizeRequestParams {
  ref: ModelRef;
  apiKey: string;
  digest: string;
  instructions?: string;
  hasPriorSummary: boolean;
  /** Created and owned by the compactor; forwarded into the provider from there. */
  signal: AbortSignal;
  now: number;
}

/**
 * The request one summarization sends. NO TOOLS, no thinking, one bounded user
 * message - the exact shape `fast/review-call.ts` uses.
 */
export function buildSummarizeRequest(params: SummarizeRequestParams): LLMRequest {
  return {
    model: params.ref.modelId,
    ...(params.ref.baseUrl ? { baseUrl: params.ref.baseUrl } : {}),
    apiKey: params.apiKey,
    systemPrompt: buildSummarySystemPrompt({
      maxChars: COMPACTION_LIMITS.summaryMaxChars,
      ...(params.instructions ? { instructions: params.instructions } : {}),
      hasPriorSummary: params.hasPriorSummary,
    }),
    messages: [buildSummaryUserMessage(params.digest, params.now)],
    maxTokens: COMPACTION_LIMITS.summaryOutputTokens,
    // PAIRED WITH `temperature: 0` ON PURPOSE: the Anthropic adapter deletes
    // `temperature` whenever a thinking budget is set, so these two are one
    // choice and not two.
    thinkingLevel: 'off',
    temperature: 0,
    signal: params.signal,
  };
}

export interface SummarizeCallParams extends SummarizeRequestParams {
  /**
   * `ProviderRegistry.complete()` - NOT `stream()` (P2-6).
   *
   * Nothing consumes a summary incrementally, and `complete` is itself
   * `consumeStream(this.stream(...))`, which is the fast reviewer's precedent.
   */
  complete(providerId: string, request: LLMRequest): Promise<AssistantMessage>;
  /**
   * Fired when `callTimeoutMs` elapses.
   *
   * THE CALLER ABORTS, NOT THIS MODULE. See the file header.
   */
  onTimeout(): void;
}

export type SummarizeOutcome =
  | { ok: true; text: string; usage: TokenUsage }
  | { ok: false; error: unknown };

/** Send one summarization and bound it in wall clock. */
export async function runSummarizeCall(
  params: SummarizeCallParams,
): Promise<SummarizeOutcome> {
  const timer = setTimeout(params.onTimeout, COMPACTION_LIMITS.callTimeoutMs);
  try {
    const message = await params.complete(params.ref.providerId, buildSummarizeRequest(params));
    return { ok: true, text: assistantText(message), usage: usageOf(message) };
  } catch (error) {
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}
