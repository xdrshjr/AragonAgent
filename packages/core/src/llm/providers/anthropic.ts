/**
 * Anthropic Messages API adapter.
 *
 * Converts the universal LLM types to/from Anthropic's wire format and maps
 * SSE events to the unified StreamEvent protocol.
 *
 * Supports:
 * - Streaming via `POST /v1/messages` with `stream: true`
 * - Extended thinking (thinking_start / thinking_delta)
 * - Tool use (content_block_start type=tool_use → tool_call_*)
 * - Multimodal user messages (text + image)
 * - Model list via `GET /v1/models`
 */

import type {
  AssistantMessage,
  ContentBlock,
  ContentPart,
  Message,
  ModelInfo,
  StreamEvent,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  TokenUsage,
  ToolDefinition,
  StopReason,
} from '../types.js';
import { THINKING_BUDGET } from '../types.js';
import type { LLMProvider, LLMRequest } from '../provider.js';
import { LLMError, classifyHttpError, wrapFetchError } from '../provider.js';
import { parseSSEStream } from '../stream-utils.js';
import { consumeStream } from '../stream-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 16384;

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic';
  readonly defaultBaseUrl = DEFAULT_BASE_URL;

  // -----------------------------------------------------------------------
  // stream
  // -----------------------------------------------------------------------

  async *stream(request: LLMRequest): AsyncIterableIterator<StreamEvent> {
    const baseUrl = (request.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const url = `${baseUrl}/v1/messages`;

    const body = buildRequestBody(request);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': request.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (err) {
      yield { type: 'error', error: wrapFetchError(err, this.id) };
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      yield { type: 'error', error: classifyHttpError(response.status, text, this.id) };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: new LLMError('Response body is null', this.id, 'network_error', true) };
      return;
    }

    // -- Parse SSE events and map to StreamEvent --

    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const contentBlocks: ContentBlock[] = [];
    let stopReason: StopReason | undefined;

    // Accumulator state per content block index
    const blockAccumulators = new Map<number, BlockAccumulator>();
    let currentBlockIndex = -1;

    try {
      for await (const sse of parseSSEStream(response.body, request.signal)) {
        // Anthropic uses the `event` field to distinguish event types
        const eventType = sse.event;
        if (!eventType || !sse.data) continue;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(sse.data);
        } catch {
          continue; // skip malformed JSON
        }

        switch (eventType) {
          case 'message_start': {
            const msg = data.message as Record<string, unknown> | undefined;
            if (msg?.usage) {
              const u = msg.usage as Record<string, number>;
              usage.inputTokens = u.input_tokens ?? 0;
              usage.cacheReadTokens = u.cache_read_input_tokens;
              usage.cacheWriteTokens = u.cache_creation_input_tokens;
            }
            break;
          }

          case 'content_block_start': {
            currentBlockIndex = (data.index as number) ?? currentBlockIndex + 1;
            const block = data.content_block as Record<string, unknown> | undefined;
            if (!block) break;

            const blockType = block.type as string;

            if (blockType === 'thinking') {
              blockAccumulators.set(currentBlockIndex, { type: 'thinking', text: '' });
              yield { type: 'thinking_start' };
            } else if (blockType === 'tool_use') {
              const toolCallId = (block.id as string) || '';
              const toolName = (block.name as string) || '';
              blockAccumulators.set(currentBlockIndex, {
                type: 'tool_use',
                toolCallId,
                toolName,
                argsJson: '',
              });
              yield { type: 'tool_call_start', toolCallId, toolName };
            } else {
              // text or redacted_thinking — treat as text
              blockAccumulators.set(currentBlockIndex, { type: 'text', text: '' });
            }
            break;
          }

          case 'content_block_delta': {
            const idx = (data.index as number) ?? currentBlockIndex;
            const delta = data.delta as Record<string, unknown> | undefined;
            if (!delta) break;

            const deltaType = delta.type as string;
            const acc = blockAccumulators.get(idx);

            if (deltaType === 'text_delta') {
              const text = (delta.text as string) || '';
              if (acc && acc.type === 'text') acc.text += text;
              yield { type: 'text_delta', delta: text };
            } else if (deltaType === 'thinking_delta') {
              const thinking = (delta.thinking as string) || '';
              if (acc && acc.type === 'thinking') acc.text += thinking;
              yield { type: 'thinking_delta', delta: thinking };
            } else if (deltaType === 'input_json_delta') {
              const partial = (delta.partial_json as string) || '';
              if (acc && acc.type === 'tool_use') {
                acc.argsJson += partial;
                yield { type: 'tool_call_delta', toolCallId: acc.toolCallId, argsDelta: partial };
              }
            }
            break;
          }

          case 'content_block_stop': {
            const idx = (data.index as number) ?? currentBlockIndex;
            const acc = blockAccumulators.get(idx);
            if (!acc) break;

            // Extract signature from content_block_stop for thinking blocks
            const stopBlock = data.content_block as Record<string, unknown> | undefined;

            if (acc.type === 'text') {
              contentBlocks.push({ type: 'text', text: acc.text } satisfies TextBlock);
            } else if (acc.type === 'thinking') {
              const signature = (stopBlock?.signature as string) ?? acc.signature;
              contentBlocks.push({ type: 'thinking', text: acc.text, signature } satisfies ThinkingBlock);
            } else if (acc.type === 'tool_use') {
              let args: Record<string, unknown> = {};
              try {
                args = acc.argsJson ? JSON.parse(acc.argsJson) : {};
              } catch {
                // JSON is malformed — likely truncated due to max_tokens.
                // Mark with __parse_error so the executor returns a clear error
                // to the LLM instead of a confusing "missing required property" message.
                console.warn(
                  `[AnthropicProvider] Malformed tool call JSON for "${acc.toolName}" ` +
                  `(stopReason=${stopReason ?? 'unknown'}, ` +
                  `argsJson length=${acc.argsJson.length}): ` +
                  acc.argsJson.slice(0, 200),
                );
                args = { __parse_error: true, __raw: acc.argsJson };
              }
              contentBlocks.push({
                type: 'tool_call',
                toolCallId: acc.toolCallId,
                toolName: acc.toolName,
                args,
              } satisfies ToolCallBlock);
              yield {
                type: 'tool_call_end',
                toolCallId: acc.toolCallId,
                toolName: acc.toolName,
                args,
              };
            }
            blockAccumulators.delete(idx);
            break;
          }

          case 'message_delta': {
            const delta = data.delta as Record<string, unknown> | undefined;
            if (delta?.stop_reason) {
              stopReason = mapStopReason(delta.stop_reason as string);
            }
            const u = data.usage as Record<string, number> | undefined;
            if (u) {
              usage.outputTokens = u.output_tokens ?? usage.outputTokens;
            }
            break;
          }

          case 'message_stop': {
            const message: AssistantMessage = {
              role: 'assistant',
              content: contentBlocks,
              usage,
              stopReason,
            };
            yield { type: 'done', message, usage };
            return;
          }

          case 'error': {
            const errObj = data.error as Record<string, unknown> | undefined;
            const errMsg = (errObj?.message as string) || 'Unknown Anthropic error';
            const errType = (errObj?.type as string) || '';
            // Map Anthropic error types to our classification
            const llmErr = /overloaded/i.test(errType)
              ? new LLMError(errMsg, this.id, 'overloaded', true)
              : /rate/i.test(errType)
                ? new LLMError(errMsg, this.id, 'rate_limit', true)
                : /auth/i.test(errType)
                  ? new LLMError(errMsg, this.id, 'auth_error', false)
                  : new LLMError(errMsg, this.id, 'server_error', true);
            yield { type: 'error', error: llmErr };
            return;
          }

          default:
            // ping, etc. — ignored
            break;
        }
      }

      // Stream ended without message_stop — emit done with what we have
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
    const url = `${base}/v1/models`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) return [];

      const data = await res.json() as { data?: Array<Record<string, unknown>> };
      return (data.data || []).map((m) => ({
        id: String(m.id || ''),
        name: String(m.display_name || m.id || ''),
        provider: this.id,
        contextWindow: 200_000,
        maxOutputTokens: 8192,
        supportsThinking: /claude-(sonnet-4|opus-4)/i.test(String(m.id)),
        supportsTools: true,
        supportsImages: true,
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
  const body: Record<string, unknown> = {
    model: request.model,
    messages: convertMessages(request.messages),
    stream: true,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
  };

  if (request.systemPrompt) {
    body.system = request.systemPrompt;
  }

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(convertToolDefinition);
  }

  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  if (request.stopSequences && request.stopSequences.length > 0) {
    body.stop_sequences = request.stopSequences;
  }

  // Extended thinking
  const thinkingBudget = request.thinkingBudget
    ?? (request.thinkingLevel ? THINKING_BUDGET[request.thinkingLevel] : 0);

  if (thinkingBudget > 0) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: thinkingBudget,
    };
    // When thinking is enabled, temperature must not be set (Anthropic requirement)
    delete body.temperature;
  }

  return body;
}

// ---------------------------------------------------------------------------
// Internal: message format conversion
// ---------------------------------------------------------------------------

function convertMessages(messages: Message[]): unknown[] {
  const result: unknown[] = [];

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
        result.push({
          role: 'assistant',
          content: convertAssistantContent(msg.content),
        });
        break;

      case 'tool_result':
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId,
              content: typeof msg.content === 'string'
                ? msg.content
                : convertContentParts(msg.content),
              is_error: msg.isError || false,
            },
          ],
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
    // image
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: part.mediaType,
        data: part.data,
      },
    };
  });
}

function convertAssistantContent(blocks: ContentBlock[]): unknown[] {
  return blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'thinking':
        return {
          type: 'thinking',
          thinking: block.text,
          ...(block.signature ? { signature: block.signature } : {}),
        };
      case 'tool_call':
        return {
          type: 'tool_use',
          id: block.toolCallId,
          name: block.toolName,
          input: block.args,
        };
    }
  });
}

function convertToolDefinition(tool: ToolDefinition): unknown {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

// ---------------------------------------------------------------------------
// Internal: helpers
// ---------------------------------------------------------------------------

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case 'end_turn': return 'end_turn';
    case 'tool_use': return 'tool_use';
    case 'max_tokens': return 'max_tokens';
    case 'stop_sequence': return 'stop_sequence';
    default: return 'end_turn';
  }
}

// ---------------------------------------------------------------------------
// Internal: block accumulator types
// ---------------------------------------------------------------------------

type BlockAccumulator =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'tool_use'; toolCallId: string; toolName: string; argsJson: string };
