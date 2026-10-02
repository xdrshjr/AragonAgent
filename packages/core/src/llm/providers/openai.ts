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

export const OPENAI_TERMINAL_DRAIN_MS = 750;

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
    if (request.signal?.aborted) return;
    const scope = new OpenAIRequestScope(request.signal);
    try {
      if (request.signal?.aborted) return;
      const attempt = await sendOpenAIRequest(request, this.defaultBaseUrl, scope.signal);
      if (request.signal?.aborted) return;
      const response = attempt.response;
      if (!response.ok) {
        throw classifyHttpError(response.status, attempt.bodyText, this.id, response.headers);
      }
      if (!response.body) {
        throw new LLMError('Response body is null', this.id, 'network_error', true);
      }
      for await (const event of readOpenAIResponse(response.body, scope)) {
        if (request.signal?.aborted) return;
        yield event;
        if (request.signal?.aborted) return;
      }
    } catch (err) {
      if (request.signal?.aborted) return;
      yield { type: 'error', error: wrapFetchError(err, this.id) };
    } finally {
      scope.dispose();
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

/** Owns the request signal and the absolute, non-renewable terminal deadline. */
class OpenAIRequestScope {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cancelCause: 'caller' | 'terminal-drain' | null = null;
  private readonly onCallerAbort = (): void => {
    this.cancelCause = 'caller';
    this.controller.abort();
  };

  constructor(private readonly caller?: AbortSignal) {
    caller?.addEventListener('abort', this.onCallerAbort, { once: true });
    if (caller?.aborted) this.onCallerAbort();
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get callerAborted(): boolean { return this.caller?.aborted === true; }
  get terminalDrainExpired(): boolean { return this.cancelCause === 'terminal-drain'; }

  startDrain(): void {
    if (this.timer !== undefined || this.cancelCause !== null) return;
    this.timer = setTimeout(() => {
      if (this.callerAborted) { this.onCallerAbort(); return; }
      this.cancelCause = 'terminal-drain';
      this.controller.abort();
    }, OPENAI_TERMINAL_DRAIN_MS);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.caller?.removeEventListener('abort', this.onCallerAbort);
  }
}

function sendOpenAIRequest(request: LLMRequest, defaultBaseUrl: string, signal: AbortSignal) {
  const baseUrl = (request.baseUrl || defaultBaseUrl).replace(/\/+$/, '');
  return sendWithOutputLimitRecovery({
    providerId: 'openai',
    modelId: request.model,
    body: buildRequestBody(request),
    tokenField: openAiTokenField(request.model),
    send: (payload) => fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal,
    }),
  });
}

async function* readOpenAIResponse(
  body: ReadableStream<Uint8Array>,
  scope: OpenAIRequestScope,
): AsyncIterableIterator<StreamEvent> {
  const state = new OpenAIStreamState();
  try {
    for await (const sse of parseSSEStream(body, scope.signal)) {
      if (scope.callerAborted) return;
      const raw = sse.data.trim();
      if (raw === '[DONE]') { state.sawTerminal = true; break; }
      for (const event of state.consume(raw, scope)) {
        if (scope.callerAborted) return;
        yield event;
        if (scope.callerAborted) return;
      }
    }
  } catch (err) {
    if (scope.callerAborted) return;
    if (!scope.terminalDrainExpired || !state.sawTerminal) throw err;
  }
  if (scope.callerAborted) return;
  if (!state.sawTerminal) {
    throw new LLMError(
      'openai stream truncated before a terminal chunk', 'openai', 'network_error', true,
    );
  }
  for (const event of state.finish()) {
    if (scope.callerAborted) return;
    yield event;
    if (scope.callerAborted) return;
  }
}

class OpenAIStreamState {
  readonly usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  sawTerminal = false;
  private text = '';
  private thinking = '';
  private stopReason: StopReason | undefined;
  private readonly tools = new Map<number, ToolCallAccumulator>();

  *consume(raw: string, scope: OpenAIRequestScope): IterableIterator<StreamEvent> {
    let chunk: Record<string, unknown> | null;
    try { chunk = JSON.parse(raw); } catch { return; }
    if (!chunk || typeof chunk !== 'object') return;
    const usage = chunk.usage as Record<string, number> | undefined;
    if (usage) {
      this.usage.inputTokens = usage.prompt_tokens ?? this.usage.inputTokens;
      this.usage.outputTokens = usage.completion_tokens ?? this.usage.outputTokens;
    }
    if (this.sawTerminal) return;
    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(choices) || choices.length === 0) return;
    const choice = choices.find((candidate) => candidate.index === 0)
      ?? (choices[0].index === undefined ? choices[0] : undefined);
    if (!choice) return;
    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
      this.sawTerminal = true;
      this.stopReason = mapFinishReason(choice.finish_reason);
      // Start at receipt, including when a consumer pauses on this frame's delta.
      scope.startDrain();
    }
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta) yield* this.consumeDelta(delta);
  }

  private *consumeDelta(delta: Record<string, unknown>): IterableIterator<StreamEvent> {
    const reasoning = delta.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      if (this.thinking.length === 0) yield { type: 'thinking_start' };
      this.thinking += reasoning;
      yield { type: 'thinking_delta', delta: reasoning };
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      this.text += delta.content;
      yield { type: 'text_delta', delta: delta.content };
    }
    const tools = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(tools)) {
      for (const tool of tools) yield* this.consumeTool(tool);
    }
  }

  private *consumeTool(tool: Record<string, unknown>): IterableIterator<StreamEvent> {
    const index = (tool.index as number) ?? 0;
    const fn = tool.function as Record<string, unknown> | undefined;
    let acc = this.tools.get(index);
    if (!acc) {
      acc = {
        index, toolCallId: (tool.id as string) || `call_${index}`,
        toolName: (fn?.name as string) || '', argsJson: '', started: false,
      };
      this.tools.set(index, acc);
    }
    if (fn?.name) acc.toolName = fn.name as string;
    if (!acc.started && acc.toolName) {
      acc.started = true;
      yield { type: 'tool_call_start', toolCallId: acc.toolCallId, toolName: acc.toolName };
    }
    if (typeof fn?.arguments === 'string' && fn.arguments.length > 0) {
      acc.argsJson += fn.arguments;
      if (acc.started) {
        yield { type: 'tool_call_delta', toolCallId: acc.toolCallId, argsDelta: fn.arguments };
      }
    }
  }

  *finish(): IterableIterator<StreamEvent> {
    const content: ContentBlock[] = [];
    if (this.thinking) content.push({ type: 'thinking', text: this.thinking });
    if (this.text) content.push({ type: 'text', text: this.text });
    for (const acc of this.tools.values()) {
      let args: Record<string, unknown> = {};
      try { args = acc.argsJson ? JSON.parse(acc.argsJson) : {}; }
      catch { args = { __raw: acc.argsJson }; }
      content.push({
        type: 'tool_call', toolCallId: acc.toolCallId, toolName: acc.toolName, args,
      });
      yield { type: 'tool_call_end', toolCallId: acc.toolCallId, toolName: acc.toolName, args };
    }
    const message: AssistantMessage = {
      role: 'assistant', content, usage: this.usage, stopReason: this.stopReason,
    };
    yield { type: 'done', message, usage: this.usage };
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
