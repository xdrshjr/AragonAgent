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
    const baseUrl = (request.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '');
    const url =
      `${baseUrl}/v1beta/models/${request.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(request.apiKey)}`;

    const body = buildRequestBody(request);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

    // -- Parse SSE events --

    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const contentBlocks: ContentBlock[] = [];
    let textAccumulator = '';
    let stopReason: StopReason | undefined;

    try {
      for await (const sse of parseSSEStream(response.body, request.signal)) {
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
          stopReason = mapFinishReason(finishReason);
        }

        const content = candidate.content as Record<string, unknown> | undefined;
        if (!content) continue;

        const parts = content.parts as Array<Record<string, unknown>> | undefined;
        if (!parts) continue;

        for (const part of parts) {
          // Text part
          if (typeof part.text === 'string') {
            textAccumulator += part.text;
            yield { type: 'text_delta', delta: part.text };
          }

          // Function call — arrives complete in a single chunk
          const functionCall = part.functionCall as Record<string, unknown> | undefined;
          if (functionCall) {
            const toolName = (functionCall.name as string) || '';
            const args = (functionCall.args as Record<string, unknown>) || {};
            const toolCallId = `call_${randomUUID().slice(0, 8)}`;

            yield { type: 'tool_call_start', toolCallId, toolName };
            yield { type: 'tool_call_end', toolCallId, toolName, args };

            contentBlocks.push({
              type: 'tool_call',
              toolCallId,
              toolName,
              args,
            } satisfies ToolCallBlock);
          }
        }
      }

      // Flush text
      if (textAccumulator) {
        contentBlocks.push({ type: 'text', text: textAccumulator } satisfies TextBlock);
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
    const url = `${base}/v1beta/models?key=${encodeURIComponent(apiKey)}`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) return [];

      const data = await res.json() as { models?: Array<Record<string, unknown>> };
      return (data.models || [])
        .filter((m) => {
          const methods = (m.supportedGenerationMethods || []) as string[];
          return methods.includes('generateContent') || methods.includes('streamGenerateContent');
        })
        .map((m) => {
          const id = String(m.name || '').replace(/^models\//, '');
          return {
            id,
            name: String(m.displayName || id),
            provider: this.id,
            contextWindow: (m.inputTokenLimit as number) || 128_000,
            maxOutputTokens: (m.outputTokenLimit as number) || 8192,
            supportsThinking: false,
            supportsTools: true,
            supportsImages: true,
            cost: { input: 0, output: 0 },
          };
        });
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
  const genConfig: Record<string, unknown> = {};
  if (request.maxTokens) {
    genConfig.maxOutputTokens = request.maxTokens;
  }
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
