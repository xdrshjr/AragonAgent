/**
 * Core LLM types — provider-agnostic message, content, and streaming types.
 *
 * These types form the universal contract between the provider adapters and
 * the agent engine.  Every provider adapter converts its native wire format
 * into these types so the rest of the system never touches provider-specific
 * structures.
 */

// ---------------------------------------------------------------------------
// Content parts (for multimodal user messages)
// ---------------------------------------------------------------------------

export interface TextContentPart {
  type: 'text';
  text: string;
}

export interface ImageContentPart {
  type: 'image';
  mediaType: string;   // e.g. 'image/png'
  data: string;        // base64-encoded
}

export type ContentPart = TextContentPart | ImageContentPart;

// ---------------------------------------------------------------------------
// Content blocks (assistant message body)
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
  /** Anthropic thinking block signature — required when sending back in conversation history. */
  signature?: string;
}

export interface ToolCallBlock {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface UserMessage {
  role: 'user';
  content: string | ContentPart[];
  timestamp?: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: ContentBlock[];
  usage?: TokenUsage;
  stopReason?: StopReason;
}

export interface ToolResultMessage {
  role: 'tool_result';
  toolCallId: string;
  content: string | ContentPart[];
  isError?: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

// ---------------------------------------------------------------------------
// Thinking level (Anthropic extended thinking)
// ---------------------------------------------------------------------------

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Map ThinkingLevel to Anthropic budget_tokens values. */
export const THINKING_BUDGET: Record<ThinkingLevel, number> = {
  off: 0,
  minimal: 1024,
  low: 4096,
  medium: 10240,
  high: 32768,
  xhigh: 65536,
};

// ---------------------------------------------------------------------------
// Stream events — unified across all providers
// ---------------------------------------------------------------------------

export interface TextDeltaEvent {
  type: 'text_delta';
  delta: string;
}

export interface ThinkingStartEvent {
  type: 'thinking_start';
}

export interface ThinkingDeltaEvent {
  type: 'thinking_delta';
  delta: string;
}

export interface ToolCallStartEvent {
  type: 'tool_call_start';
  toolCallId: string;
  toolName: string;
}

export interface ToolCallDeltaEvent {
  type: 'tool_call_delta';
  toolCallId: string;
  argsDelta: string;
}

export interface ToolCallEndEvent {
  type: 'tool_call_end';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface DoneEvent {
  type: 'done';
  message: AssistantMessage;
  usage: TokenUsage;
}

export interface ErrorEvent {
  type: 'error';
  error: Error;
}

export type StreamEvent =
  | TextDeltaEvent
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | DoneEvent
  | ErrorEvent;

// ---------------------------------------------------------------------------
// Tool definition (schema sent to the LLM)
// ---------------------------------------------------------------------------

/** JSON Schema object — kept deliberately loose to avoid coupling to a schema lib. */
export type JSONSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

// ---------------------------------------------------------------------------
// Model info
// ---------------------------------------------------------------------------

export interface ModelCost {
  /** Cost per 1M input tokens (USD). */
  input: number;
  /** Cost per 1M output tokens (USD). */
  output: number;
  /** Cost per 1M cache-read tokens (USD). */
  cacheRead?: number;
  /** Cost per 1M cache-write tokens (USD). */
  cacheWrite?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsTools: boolean;
  supportsImages: boolean;
  cost: ModelCost;
}
