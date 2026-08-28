/**
 * OpenAI Chat Completions adapter.
 *
 * Handles all OpenAI-compatible APIs: OpenAI, xAI, Groq, DeepSeek, Cerebras,
 * Mistral, and any custom endpoint that speaks the same wire format.
 *
 * Key challenges this adapter solves:
 * - Tool call argument chunks arrive incrementally — we accumulate and parse
 *   the full JSON only when the tool call finishes.
 * - Multiple tool calls can be in-flight in a single completion chunk.
 * - The `[DONE]` sentinel terminates the SSE stream.
 */

import type {
  AssistantMessage,
  ContentBlock,
  ContentPart,
  Message,
  ModelInfo,
  StreamEvent,
  TextBlock,
  ToolCallBlock,
  TokenUsage,
  ToolDefinition,
  StopReason,
} from '../types.js';
import type { LLMProvider, LLMRequest } from '../provider.js';
import { LLMError, classifyHttpError, wrapFetchError } from '../provider.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  estimatePromptTokens,
  normalizeModelId,
  resolveOutputTokens,
  staticCeilingFor,
} from '../output-limits.js';
import { getLearnedTokenField, sendWithOutputLimitRecovery } from '../output-limit-recovery.js';
import { parseSSEStream } from '../stream-utils.js';
import { consumeStream } from '../stream-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** Reasoning-family models reject `max_tokens` in favour of `max_completion_tokens`. */
const REASONING_MODEL_PATTERN = /^(o1|o3|o4|gpt-5)/;

// Model ID patterns to filter out non-chat models
const NON_CHAT_PATTERNS = [
  /^text-embedding/i,
  /^text-moderation/i,
  /^text-search/i,
  /^text-similarity/i,
  /^code-search/i,
  /^whisper/i,
  /^tts/i,
  /^dall-e/i,
  /^davinci/i,
  /^curie/i,
  /^babbage/i,
  /^ada(?![-])/i,
  /embedding/i,
  /moderation/i,
];

function isChatModel(id: string): boolean {
  return !NON_CHAT_PATTERNS.some((pat) => pat.test(id));
}

/**
 * Which parameter name carries the cap for this model.
 *
 * A HEURISTIC, and only the first guess: a proxy fronting an o-series model
 * under a `gpt-` alias disagrees with it. `unsupported_field` recovery renames
 * the parameter after one round trip and memoizes the answer, which is why the
 * learned dialect is consulted first.
 */
export function openAiTokenField(modelId: string): 'max_tokens' | 'max_completion_tokens' {
  const learned = getLearnedTokenField('openai', modelId);
  if (learned) return learned;
  return REASONING_MODEL_PATTERN.test(normalizeModelId(modelId))
    ? 'max_completion_tokens'
    : 'max_tokens';
}

// ---------------------------------------------------------------------------
// Tool call accumulator
// ---------------------------------------------------------------------------

interface ToolCallAccumulator {
  index: number;
  toolCallId: string;
  toolName: string;
  argsJson: string;
  started: boolean;
}

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai';
  readonly displayName = 'OpenAI';
  readonly defaultBaseUrl = DEFAULT_BASE_URL;

  // -----------------------------------------------------------------------
  // stream
  // -----------------------------------------------------------------------

  async *stream(request: LLMRequest): AsyncIterableIterator<StreamEvent> {
    const baseUrl = (request.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;

    const body = buildRequestBody(request);

    let response: Response;
    let errorBody = '';
    try {
      const attempt = await sendWithOutputLimitRecovery({
        providerId: this.id,
        modelId: request.model,
        body,
        tokenField: openAiTokenField(request.model),
        send: (payload) =>
          fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${request.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: request.signal,
          }),
      });
      response = attempt.response;
      errorBody = attempt.bodyText;
    } catch (err) {
      yield { type: 'error', error: wrapFetchError(err, this.id) };
      return;
    }

    if (!response.ok) {
      // `errorBody` is the ALREADY-CONSUMED body; re-reading it would throw.
      // `response.headers` carries `Retry-After` / `x-ratelimit-reset-after` out
      // on `LLMError.retryAfterMs` so a 429 waits as long as the server asked.
      yield {
        type: 'error',
        error: classifyHttpError(response.status, errorBody, this.id, response.headers),
      };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: new LLMError('Response body is null', this.id, 'network_error', true) };
      return;
    }

    // -- Parse SSE events --

    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const contentBlocks: ContentBlock[] = [];
    let textAccumulator = '';
    let stopReason: StopReason | undefined;

    // Accumulate tool calls by index
    const toolAccumulators = new Map<number, ToolCallAccumulator>();

    /**
     * Whether this stream reached a terminal frame (§4.5a). Unlike Anthropic's
     * `message_stop`, neither of OpenAI's terminal signals `return`s, so the
     * absence of a return cannot stand in for the flag.
     *
     * TWO SIGNALS, NOT ONE, and the second is not optional. The `[DONE]`
     * sentinel is the documented terminator, but it is a convention of OpenAI's
     * own server rather than a property of the wire format: several
     * OpenAI-compatible endpoints (the ones `--base-url` exists for) close the
     * connection after the last chunk without sending it. Keying truncation on
     * `[DONE]` alone would make every request against such a server a retryable
     * error, i.e. ten retries and then a failure, for a stream that completed
     * perfectly. A `finish_reason` on any choice is the model's own statement
     * that it stopped, and a stream cut mid-answer carries neither.
     */
    let sawTerminal = false;

    try {
      for await (const sse of parseSSEStream(response.body, request.signal)) {
        const raw = sse.data.trim();

        // [DONE] sentinel
        if (raw === '[DONE]') {
          sawTerminal = true;
          break;
        }

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw);
        } catch {
          continue;
        }

        // Extract usage if present (some providers include it in the final chunk)
        const usageData = data.usage as Record<string, number> | undefined;
        if (usageData) {
          usage.inputTokens = usageData.prompt_tokens ?? usage.inputTokens;
          usage.outputTokens = usageData.completion_tokens ?? usage.outputTokens;
        }

        const choices = data.choices as Array<Record<string, unknown>> | undefined;
        if (!choices || choices.length === 0) continue;

        const choice = choices[0];
        const delta = choice.delta as Record<string, unknown> | undefined;
        const finishReason = choice.finish_reason as string | null;

        if (delta) {
          // Text content
          const content = delta.content as string | null;
          if (content) {
            textAccumulator += content;
            yield { type: 'text_delta', delta: content };
          }

          // Tool calls
          const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
          if (toolCalls) {
            for (const tc of toolCalls) {
              const idx = (tc.index as number) ?? 0;
              const fn = tc.function as Record<string, unknown> | undefined;

              let acc = toolAccumulators.get(idx);
              if (!acc) {
                acc = {
                  index: idx,
                  toolCallId: (tc.id as string) || `call_${idx}`,
                  toolName: fn?.name as string || '',
                  argsJson: '',
                  started: false,
                };
                toolAccumulators.set(idx, acc);
              }

              // Update name if present in this chunk
              if (fn?.name) {
                acc.toolName = fn.name as string;
              }

              // Emit tool_call_start on first encounter
              if (!acc.started && acc.toolName) {
                acc.started = true;
                yield { type: 'tool_call_start', toolCallId: acc.toolCallId, toolName: acc.toolName };
              }

              // Accumulate argument fragments
              if (fn?.arguments) {
                const argChunk = fn.arguments as string;
                acc.argsJson += argChunk;
                if (acc.started) {
                  yield { type: 'tool_call_delta', toolCallId: acc.toolCallId, argsDelta: argChunk };
                }
              }
            }
          }
        }

        // Finish reason handling
        if (finishReason) {
          sawTerminal = true;
          stopReason = mapFinishReason(finishReason);
        }
      }

      // ---- The terminal-sentinel contract (§4.5a) -------------------------
      //
      // An abort is NOT a truncation: `parseSSEStream` `break`s on
      // `signal.aborted`, which lands on exactly this path, and turning that into
      // a retryable `network_error` would re-create the trap `isRetryableError`
      // check 1 exists to close (constraint 1 / R-17). The signal is therefore
      // tested FIRST and that path keeps yielding `done`.
      if (!sawTerminal && !request.signal?.aborted) {
        yield {
          type: 'error',
          error: new LLMError(
            `${this.id} stream truncated before a terminal chunk`,
            this.id,
            'network_error',
            true,
          ),
        };
        return;
      }

      // Flush text block
      if (textAccumulator) {
        contentBlocks.push({ type: 'text', text: textAccumulator } satisfies TextBlock);
      }

      // Flush tool calls — parse accumulated args JSON
      for (const acc of toolAccumulators.values()) {
        let args: Record<string, unknown> = {};
        try {
          args = acc.argsJson ? JSON.parse(acc.argsJson) : {};
        } catch {
          args = { __raw: acc.argsJson };
        }
        contentBlocks.push({
          type: 'tool_call',
          toolCallId: acc.toolCallId,
          toolName: acc.toolName,
          args,
        } satisfies ToolCallBlock);
        yield { type: 'tool_call_end', toolCallId: acc.toolCallId, toolName: acc.toolName, args };
      }

      const message: AssistantMessage = {
        role: 'assistant',
        content: contentBlocks,
        usage,
        stopReason,
      };
      yield { type: 'done', message, usage };
    } catch (err) {
      yield { type: 'error', error: wrapFetchError(err, this.id) };
    }
  }

  // -----------------------------------------------------------------------
  // complete
  // -----------------------------------------------------------------------

  async complete(request: LLMRequest): Promise<AssistantMessage> {
    return consumeStream(this.stream(request));
  }

  // -----------------------------------------------------------------------
  // listModels
  // -----------------------------------------------------------------------

  async listModels(apiKey: string, baseUrl?: string): Promise<ModelInfo[]> {
    const base = (baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const url = `${base}/models`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) return [];

      const data = await res.json() as { data?: Array<Record<string, unknown>> };
      // The OpenAI models endpoint does NOT report an output ceiling, so this
      // maps through the static table and deliberately does NOT call
      // `learnModelCeiling` — claiming knowledge we do not have would outrank
      // the (correct) table entry for every small model.
      return (data.data || [])
        .filter((m) => isChatModel(String(m.id || '')))
        .map((m) => ({
          id: String(m.id || ''),
          name: String(m.id || ''),
          provider: this.id,
          contextWindow: 128_000,
          maxOutputTokens: staticCeilingFor(this.id, String(m.id || '')) ?? DEFAULT_MAX_OUTPUT_TOKENS,
          supportsThinking: false,
          supportsTools: true,
          supportsImages: /gpt-4|o1|o3/i.test(String(m.id)),
          cost: { input: 0, output: 0 },
        }));
    } catch {
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: request body builder
// ---------------------------------------------------------------------------

function buildRequestBody(request: LLMRequest): Record<string, unknown> {
  const messages = convertMessages(request.messages, request.systemPrompt);

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  const tokenField = openAiTokenField(request.model);

  // The prompt estimate is only ever consumed when the caller told us the
  // context window, so it is computed only then — walking every message on a
  // hot path that cannot use the result would be pure waste.
  const contextWindow = request.modelLimits?.contextWindow;
  const resolution = resolveOutputTokens({
    providerId: 'openai',
    modelId: request.model,
    ...(request.maxTokens !== undefined ? { requested: request.maxTokens } : {}),
    ...(request.modelLimits ? { modelLimits: request.modelLimits } : {}),
    ...(contextWindow !== undefined
      ? { estimatedPromptTokens: estimatePromptTokens(request.messages, request.systemPrompt) }
      : {}),
  });
  body[tokenField] = resolution.value;

  // The reasoning family rejects `temperature` alongside `max_tokens`; sending
  // it would just buy a second 400 on a different key.
  if (request.temperature !== undefined && tokenField === 'max_tokens') {
    body.temperature = request.temperature;
  }

  if (request.stopSequences && request.stopSequences.length > 0) {
    body.stop = request.stopSequences;
  }

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(convertToolDefinition);
  }

  return body;
}

// ---------------------------------------------------------------------------
// Internal: message format conversion
// ---------------------------------------------------------------------------

function convertMessages(messages: Message[], systemPrompt?: string): unknown[] {
  const result: unknown[] = [];

  // System prompt as the first message
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    switch (msg.role) {
      case 'user':
        result.push({
          role: 'user',
          content: typeof msg.content === 'string'
            ? msg.content
            : convertContentParts(msg.content),
        });
        break;

      case 'assistant':
        result.push(convertAssistantMessage(msg));
        break;

      case 'tool_result':
        result.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content: typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content),
        });
        break;
    }
  }

  return result;
}

function convertContentParts(parts: ContentPart[]): unknown[] {
  return parts.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    return {
      type: 'image_url',
      image_url: {
        url: `data:${part.mediaType};base64,${part.data}`,
      },
    };
  });
}

function convertAssistantMessage(msg: AssistantMessage): unknown {
  const result: Record<string, unknown> = { role: 'assistant' };

  // Extract text content
  const textParts = msg.content.filter((b) => b.type === 'text');
  if (textParts.length > 0) {
    result.content = textParts.map((b) => (b as { text: string }).text).join('');
  } else {
    result.content = null;
  }

  // Extract tool calls
  const toolCalls = msg.content.filter((b) => b.type === 'tool_call') as ToolCallBlock[];
  if (toolCalls.length > 0) {
    result.tool_calls = toolCalls.map((tc) => ({
      id: tc.toolCallId,
      type: 'function',
      function: {
        name: tc.toolName,
        arguments: JSON.stringify(tc.args),
      },
    }));
  }

  return result;
}

function convertToolDefinition(tool: ToolDefinition): unknown {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal: helpers
// ---------------------------------------------------------------------------

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    default: return 'end_turn';
  }
}
