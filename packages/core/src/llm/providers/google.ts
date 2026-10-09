/**
 * Google Gemini (Generative AI) adapter.
 *
 * Uses `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` for
 * streaming and maps the chunked response into unified StreamEvents.
 *
 * Key differences from Anthropic/OpenAI:
 * - Tool calls (functionCall) arrive as complete objects in a single chunk,
 *   not incrementally — so we emit tool_call_start + tool_call_end together.
 * - System instructions use a dedicated `system_instruction` field.
 * - The API key is passed as a query parameter, not a header.
 */

import { randomUUID } from 'node:crypto';
import { reportedContextWindow } from '../context-window.js';
import { createModelDiscoverySignal } from '../model-discovery.js';

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
  learnModelCeiling,
  resolveOutputTokens,
} from '../output-limits.js';
import { sendWithOutputLimitRecovery } from '../output-limit-recovery.js';
import { parseSSEStream } from '../stream-utils.js';
import { consumeStream } from '../stream-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

// ---------------------------------------------------------------------------
// Google provider
// ---------------------------------------------------------------------------

export class GoogleProvider implements LLMProvider {
  readonly id = 'google';
  readonly displayName = 'Google';
  readonly defaultBaseUrl = DEFAULT_BASE_URL;

  // -----------------------------------------------------------------------
  // stream
  // -----------------------------------------------------------------------

  async *stream(request: LLMRequest): AsyncIterableIterator<StreamEvent> {
    if (request.signal?.aborted) return;
    const baseUrl = (request.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const url =
      `${baseUrl}/v1beta/models/${request.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(request.apiKey)}`;

    const body = buildRequestBody(request);

    let response: Response;
    let errorBody = '';
    try {
      const attempt = await sendWithOutputLimitRecovery({
        providerId: this.id,
        modelId: request.model,
        body,
        tokenField: 'generationConfig.maxOutputTokens',
        send: (payload) =>
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: request.signal,
          }),
      });
      response = attempt.response;
      errorBody = attempt.bodyText;
    } catch (err) {
      if (request.signal?.aborted) return;
      yield { type: 'error', error: wrapFetchError(err, this.id) };
      return;
    }

    if (request.signal?.aborted) return;
    if (!response.ok) {
      // `errorBody` is the ALREADY-CONSUMED body; re-reading it would throw.
      // `response.headers` carries `Retry-After` out on `LLMError.retryAfterMs`
      // so a 429 waits as long as the server asked rather than only the ladder.
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

    /**
     * Whether a terminal chunk arrived (§4.5a). Google's terminator is a
     * candidate carrying `finishReason`; unlike Anthropic's `message_stop` it
     * does not `return`, so the flag is what tells a completed stream from a
     * truncated one. Set AT THE FRAME, never inferred from
     * `contentBlocks.length` — a model that legitimately produces nothing and
     * stops is a success, not a truncation (constraint 2).
     */
    let sawTerminal = false;

    try {
      for await (const sse of parseSSEStream(response.body, request.signal)) {
        if (request.signal?.aborted) return;
        const raw = sse.data.trim();
        if (!raw) continue;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw);
        } catch {
          continue;
        }

        // Usage metadata
        const usageMeta = data.usageMetadata as Record<string, number> | undefined;
        if (usageMeta) {
          usage.inputTokens = usageMeta.promptTokenCount ?? usage.inputTokens;
          usage.outputTokens = usageMeta.candidatesTokenCount ?? usage.outputTokens;
        }

        // Candidates
        const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
        if (!candidates || candidates.length === 0) continue;

        const candidate = candidates[0];

        // Finish reason
        const finishReason = candidate.finishReason as string | undefined;
        if (finishReason) {
          sawTerminal = true;
          stopReason = mapFinishReason(finishReason);
        }

        const content = candidate.content as Record<string, unknown> | undefined;
        if (!content) continue;

        const parts = content.parts as Array<Record<string, unknown>> | undefined;
        if (!parts) continue;

        for (const part of parts) {
          if (request.signal?.aborted) return;
          // Text part
          if (typeof part.text === 'string') {
            textAccumulator += part.text;
            yield { type: 'text_delta', delta: part.text };
          }

          if (request.signal?.aborted) return;
          // Function call — arrives complete in a single chunk
          const functionCall = part.functionCall as Record<string, unknown> | undefined;
          if (functionCall) {
            const toolName = (functionCall.name as string) || '';
            const args = (functionCall.args as Record<string, unknown>) || {};
            const toolCallId = `call_${randomUUID().slice(0, 8)}`;

            if (request.signal?.aborted) return;
            yield { type: 'tool_call_start', toolCallId, toolName };
            if (request.signal?.aborted) return;
            yield { type: 'tool_call_end', toolCallId, toolName, args };
            if (request.signal?.aborted) return;

            contentBlocks.push({
              type: 'tool_call',
              toolCallId,
              toolName,
              args,
            } satisfies ToolCallBlock);
          }
        }
      }

      // A caller abort is silent; only an incomplete transport EOF is retried.
      if (request.signal?.aborted) return;
      if (!sawTerminal) {
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

      // Flush text
      if (textAccumulator) {
        contentBlocks.push({ type: 'text', text: textAccumulator } satisfies TextBlock);
      }

      if (request.signal?.aborted) return;
      const message: AssistantMessage = {
        role: 'assistant',
        content: contentBlocks,
        usage,
        stopReason,
      };
      yield { type: 'done', message, usage };
    } catch (err) {
      if (request.signal?.aborted) return;
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

  async listModels(apiKey: string, baseUrl?: string, signal?: AbortSignal): Promise<ModelInfo[]> {
    const base = (baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const url = `${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
    const scope = createModelDiscoverySignal(signal);

    try {
      const models: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 20 && !scope.signal.aborted; page++) {
        try {
          const pageUrl = cursor === undefined ? url : `${url}&pageToken=${encodeURIComponent(cursor)}`;
          const res = await fetch(pageUrl, { method: 'GET', signal: scope.signal });
          if (!res.ok) break;
          const data = await res.json() as { models?: Array<Record<string, unknown>>; nextPageToken?: unknown };
          if (!Array.isArray(data.models)) break;
          models.push(...data.models);
          const next = data.nextPageToken;
          if (typeof next !== 'string' || next.length === 0 || seen.has(next)) break;
          seen.add(next);
          cursor = next;
        } catch {
          break; // Preserve metadata from earlier pages when continuation fails.
        }
      }
      // Explicit session cancellation must not publish partial results or learn ceilings.
      // The internal timeout still permits useful metadata from completed pages.
      if (signal?.aborted) return [];
      return models
        .filter((m) => {
          const methods = (m.supportedGenerationMethods || []) as string[];
          return methods.includes('generateContent') || methods.includes('streamGenerateContent');
        })
        .map((m) => {
          const id = String(m.name || '').replace(/^models\//, '');
          // Google is the ONE provider of the three that reports a real
          // per-model output ceiling, so its answer is worth remembering: it
          // outranks the static table for every later request in this process.
          const reported = m.outputTokenLimit as number | undefined;
          if (typeof reported === 'number' && reported > 0) {
            learnModelCeiling(this.id, id, reported, 'discovery');
          }
          return {
            id,
            name: String(m.displayName || id),
            provider: this.id,
            ...reportedContextWindow(m),
            maxOutputTokens: reported || DEFAULT_MAX_OUTPUT_TOKENS,
            supportsThinking: false,
            supportsTools: true,
            supportsImages: true,
            cost: { input: 0, output: 0 },
          };
        });
    } catch {
      return [];
    } finally {
      scope.dispose();
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: request body builder
// ---------------------------------------------------------------------------

function buildRequestBody(request: LLMRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: convertMessages(request.messages),
  };

  if (request.systemPrompt) {
    body.system_instruction = {
      parts: [{ text: request.systemPrompt }],
    };
  }

  if (request.tools && request.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: request.tools.map(convertToolDefinition),
      },
    ];
  }

  // Generation config
  const resolution = resolveOutputTokens({
    providerId: 'google',
    modelId: request.model,
    ...(request.maxTokens !== undefined ? { requested: request.maxTokens } : {}),
    ...(request.modelLimits ? { modelLimits: request.modelLimits } : {}),
  });
  const genConfig: Record<string, unknown> = {
    maxOutputTokens: resolution.value,
  };
  if (request.temperature !== undefined) {
    genConfig.temperature = request.temperature;
  }
  if (request.stopSequences && request.stopSequences.length > 0) {
    genConfig.stopSequences = request.stopSequences;
  }
  if (Object.keys(genConfig).length > 0) {
    body.generationConfig = genConfig;
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
          parts: typeof msg.content === 'string'
            ? [{ text: msg.content }]
            : convertContentParts(msg.content),
        });
        break;

      case 'assistant':
        result.push({
          role: 'model',
          parts: convertAssistantParts(msg.content),
        });
        break;

      case 'tool_result': {
        const textContent = typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((p) => p.type === 'text' ? p.text : '').join('');

        // Gemini requires the function *name* here, not the call ID.
        // Look backwards through the conversation for the matching
        // tool_call block so we can resolve the actual name.
        const toolName = resolveToolName(messages, msg.toolCallId);

        result.push({
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: toolName,
                response: {
                  content: textContent,
                },
              },
            },
          ],
        });
        break;
      }
    }
  }

  return result;
}

function convertContentParts(parts: ContentPart[]): unknown[] {
  return parts.map((part) => {
    if (part.type === 'text') {
      return { text: part.text };
    }
    return {
      inlineData: {
        mimeType: part.mediaType,
        data: part.data,
      },
    };
  });
}

function convertAssistantParts(blocks: ContentBlock[]): unknown[] {
  const parts: unknown[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push({ text: block.text });
        break;
      case 'thinking':
        // Gemini doesn't have thinking blocks — emit as text
        parts.push({ text: block.text });
        break;
      case 'tool_call':
        parts.push({
          functionCall: {
            name: block.toolName,
            args: block.args,
          },
        });
        break;
    }
  }

  return parts;
}

function convertToolDefinition(tool: ToolDefinition): unknown {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

// ---------------------------------------------------------------------------
// Internal: helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a toolCallId back to the function name by scanning the conversation
 * history for a matching tool_call block in an assistant message.
 *
 * Falls back to the toolCallId itself if no match is found (best-effort).
 */
function resolveToolName(messages: Message[], toolCallId: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') {
      for (const block of m.content) {
        if (block.type === 'tool_call' && block.toolCallId === toolCallId) {
          return block.toolName;
        }
      }
    }
  }
  return toolCallId;
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case 'STOP': return 'end_turn';
    case 'MAX_TOKENS': return 'max_tokens';
    case 'SAFETY': return 'end_turn';
    case 'RECITATION': return 'end_turn';
    default: return 'end_turn';
  }
}
