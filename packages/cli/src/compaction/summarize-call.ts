/** Bounded summary transport; local cancellation also settles uncooperative providers. */
import type { AssistantMessage, LLMRequest, ModelRef, TokenUsage } from '@aragon-agent/core';
import { COMPACTION_LIMITS } from './limits.js';
import { buildSummarySystemPrompt, buildSummaryUserMessage } from './summary-prompt.js';
import { CompactionOperation } from './operation.js';

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
    ...((total.cacheReadTokens !== undefined || next.cacheReadTokens !== undefined)
      ? { cacheReadTokens: (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0) } : {}),
    ...((total.cacheWriteTokens !== undefined || next.cacheWriteTokens !== undefined)
      ? { cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0) } : {}),
  };
}

export interface SummarizeRequestParams {
  ref: ModelRef;
  apiKey: string;
  digest: string;
  instructions?: string;
  hasPriorSummary: boolean;
  validationError?: string;
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
    }) + (params.validationError
      ? `\nPrevious delta rejected: ${params.validationError.slice(0, 200)}. Correct that error.` : ''),
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
  onUsage?(usage: TokenUsage): void;
}

export type SummarizeOutcome =
  | { ok: true; text: string; usage: TokenUsage }
  | { ok: false; error: unknown };

/** Send one summarization and bound it in wall clock. */
export async function runSummarizeCall(
  params: SummarizeCallParams,
): Promise<SummarizeOutcome> {
  const operation = new CompactionOperation(0, params.signal, COMPACTION_LIMITS.callTimeoutMs);
  let charged = false;
  try {
    const message = await operation.run(async () => {
      const result = await params.complete(params.ref.providerId,
        buildSummarizeRequest({ ...params, signal: operation.signal }));
      if (result.usage && !charged) {
        charged = true;
        params.onUsage?.(result.usage);
      }
      return result;
    }, COMPACTION_LIMITS.callTimeoutMs);
    return { ok: true, text: assistantText(message), usage: usageOf(message) };
  } catch (error) {
    if (errorText(error) === 'timeout') params.onTimeout();
    return { ok: false, error };
  } finally {
    operation.settle();
  }
}
