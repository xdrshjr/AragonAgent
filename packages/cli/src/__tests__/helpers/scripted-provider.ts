/**
 * A scripted `LLMProvider`, for the offline compaction harness
 * (context-auto-compaction-hardening §3.7.2 / W6).
 *
 * WHY THIS EXISTS. `core/src/__tests__/compaction-loop.test.ts` drives the
 * ENGINE against a scripted provider and covers the seam thoroughly. What no
 * test drove is the CLI's compaction stack against a provider: every CLI test
 * injects `complete` directly, so `summarize-call.ts`, the registry, the retry
 * policy and the digest -> prompt -> response -> splice chain had never been
 * exercised together. Six of the seven not-skippable manual rows were the only
 * coverage those paths had, and none had been run.
 *
 * IT IMPLEMENTS THE SAME INTERFACE THE REAL ADAPTERS DO, which is what keeps
 * this a harness rather than a fiction - and it RECORDS EVERY REQUEST, because
 * "what was actually sent after the compaction" is the assertion those manual
 * rows exist to make and no unit test can.
 */

import {
  LLMError,
  type AssistantMessage,
  type LLMErrorType,
  type LLMProvider,
  type LLMRequest,
  type ModelInfo,
  type StreamEvent,
  type TokenUsage,
} from '@aragon-agent/core';

export type ScriptStep =
  | {
      kind: 'assistant';
      text?: string;
      toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
      usage?: TokenUsage;
    }
  /** Throws `context_overflow`, i.e. the provider refusing the request outright. */
  | { kind: 'overflow' }
  | { kind: 'error'; errorType: LLMErrorType }
  /** Served to the SUMMARIZER's `complete()` call. */
  | { kind: 'summary'; text: string };

export interface ScriptedProvider extends LLMProvider {
  /** Every request this provider was handed, in order, across both entry points. */
  readonly requests: LLMRequest[];
  /**
   * The AGENT LOOP's requests - everything that is not a summarization.
   *
   * NOT "requests that arrived through `stream()`", AND THAT IS AN IMPLEMENTATION
   * FINDING RATHER THAN A NAMING PREFERENCE. The design assumed `complete()` was
   * the summarizer's entry point, but `ProviderRegistry.complete` is
   * `consumeStream(this.stream(...))` BY DESIGN (llm-api-retry-backoff §5.4:
   * routing it through `provider.complete()` would leave `completeLLM` as the one
   * public entry point with no retry). So a summarization and a turn both reach
   * this object through `stream()`, and telling them apart needs a property of
   * the REQUEST.
   */
  readonly agentRequests: LLMRequest[];
  /** The summarizer's requests, by the shape `buildSummarizeRequest` produces. */
  readonly summarizerRequests: LLMRequest[];
  /** Steps not yet consumed, so a test can assert the script ran to the end. */
  remaining(): number;
}

/**
 * Is this the summarizer's request?
 *
 * THREE PROPERTIES `buildSummarizeRequest` SETS TOGETHER AND DELIBERATELY - its
 * own comment says "NO TOOLS, no thinking, one bounded user message", and the
 * `temperature: 0` / `thinkingLevel: 'off'` pair is documented there as ONE
 * choice rather than two. The agent loop sets none of them.
 */
function isSummarizerRequest(request: LLMRequest): boolean {
  return (
    request.temperature === 0 &&
    request.thinkingLevel === 'off' &&
    (request.tools === undefined || request.tools.length === 0) &&
    request.messages.length === 1
  );
}

const DEFAULT_USAGE: TokenUsage = { inputTokens: 1_000, outputTokens: 100 };

function assistantFrom(step: Extract<ScriptStep, { kind: 'assistant' | 'summary' }>): AssistantMessage {
  if (step.kind === 'summary') {
    return {
      role: 'assistant',
      content: [{ type: 'text', text: step.text }],
      usage: DEFAULT_USAGE,
      stopReason: 'end_turn',
    };
  }
  const content: AssistantMessage['content'] = [];
  if (step.text) content.push({ type: 'text', text: step.text });
  for (const c of step.toolCalls ?? []) {
    content.push({ type: 'tool_call', toolCallId: c.id, toolName: c.name, args: c.args });
  }
  return {
    role: 'assistant',
    content,
    usage: step.usage ?? DEFAULT_USAGE,
    stopReason: (step.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn',
  };
}

function errorFor(id: string, step: Extract<ScriptStep, { kind: 'overflow' | 'error' }>): LLMError {
  const type: LLMErrorType = step.kind === 'overflow' ? 'context_overflow' : step.errorType;
  return new LLMError(`scripted ${type}`, id, type, false, 400);
}

/**
 * Build a provider from a script.
 *
 * THE SCRIPT IS ONE QUEUE SHARED BY BOTH ENTRY POINTS, deliberately: a test that
 * asserts "three provider calls in order" is asserting about the ORDER the
 * compaction ladder produces, and two independent queues would let a wrong order
 * pass. Running off the end of the script repeats the last `assistant` step
 * rather than throwing, so a test only has to script the part it is about.
 */
export function scriptedProvider(id: string, steps: ScriptStep[]): ScriptedProvider {
  const queue = [...steps];
  const requests: LLMRequest[] = [];
  const agentRequests: LLMRequest[] = [];
  const summarizerRequests: LLMRequest[] = [];
  const record = (request: LLMRequest): void => {
    requests.push(request);
    (isSummarizerRequest(request) ? summarizerRequests : agentRequests).push(request);
  };
  let last: ScriptStep = { kind: 'assistant', text: 'ok' };

  const next = (): ScriptStep => {
    const step = queue.shift();
    if (step) {
      last = step;
      return step;
    }
    return last;
  };

  const provider: ScriptedProvider = {
    id,
    displayName: `scripted:${id}`,
    defaultBaseUrl: 'https://example.invalid',
    requests,
    agentRequests,
    summarizerRequests,
    remaining: () => queue.length,

    async *stream(request: LLMRequest): AsyncIterableIterator<StreamEvent> {
      record(request);
      const step = next();
      if (step.kind === 'overflow' || step.kind === 'error') {
        yield { type: 'error', error: errorFor(id, step) };
        return;
      }
      const message = assistantFrom(step);
      for (const block of message.content) {
        if (block.type === 'text') yield { type: 'text_delta', delta: block.text };
      }
      yield { type: 'done', message, usage: message.usage ?? DEFAULT_USAGE };
    },

    async complete(request: LLMRequest): Promise<AssistantMessage> {
      record(request);
      const step = next();
      // `complete()` THROWS RATHER THAN YIELDING AN ERROR EVENT, which is what the
      // real adapters do and what `runSummarizeCall` catches.
      if (step.kind === 'overflow' || step.kind === 'error') throw errorFor(id, step);
      return assistantFrom(step);
    },

    async listModels(): Promise<ModelInfo[]> {
      return [];
    },
  };
  return provider;
}
