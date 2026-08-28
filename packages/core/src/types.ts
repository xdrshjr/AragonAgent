/**
 * Core Agent event types.
 *
 * These events are emitted by the Agent engine during execution and consumed
 * by subscribers (e.g. SelfAgentService) to drive UI updates and persistence.
 */

import type {
  AssistantMessage,
  Message,
  StreamEvent,
  TokenUsage,
} from './llm/types.js';
import type { ToolResult } from './tools/types.js';
import type { CompactionTrigger } from './engine/context-manager.js';

// ---------------------------------------------------------------------------
// Agent Events
// ---------------------------------------------------------------------------

export interface AgentStartEvent {
  type: 'agent_start';
}

export interface AgentEndEvent {
  type: 'agent_end';
  messages: Message[];
}

export interface TurnStartEvent {
  type: 'turn_start';
}

export interface TurnEndEvent {
  type: 'turn_end';
  message: AssistantMessage;
  usage: TokenUsage;
}

export interface MessageUpdateEvent {
  type: 'message_update';
  streamEvent: StreamEvent;
}

export interface ToolExecutionStartEvent {
  type: 'tool_execution_start';
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionEndEvent {
  type: 'tool_execution_end';
  toolCallId: string;
  toolName: string;
  result: ToolResult;
  isError: boolean;
  duration: number;
}

export interface CodeExecutionStartEvent {
  type: 'code_execution_start';
  code: string;
  language: string;
}

export interface CodeExecutionEndEvent {
  type: 'code_execution_end';
  output: string;
  error?: string;
  duration: number;
}

/**
 * Context compaction is about to run (context-auto-compaction §5.1).
 *
 * IT PAUSES THE IDLE WATCHDOG (`agent.ts::applyWatchdogPolicy`), because a
 * summarization is a normal LLM call and can exceed `DEFAULT_IDLE_TIMEOUT`.
 */
export interface CompactionStartEvent {
  type: 'compaction_start';
  trigger: CompactionTrigger;
  messageCount: number;
}

/**
 * Context compaction finished, applied or not (context-auto-compaction §5.1).
 *
 * EMITTED FROM A `finally`, ON EVERY EXIT PATH. It is what RESUMES the watchdog,
 * so a compaction that failed to emit its `end` would leave the run permanently
 * deaf (P1-3).
 */
export interface CompactionEndEvent {
  type: 'compaction_end';
  applied: boolean;
  mode: 'summarized' | 'truncated' | 'none';
  /** Set whenever `applied` is false, and on any degraded splice. */
  reason?: string;
  messagesBefore: number;
  messagesAfter: number;
  droppedMessages: number;
  /**
   * Core's own `estimatePromptTokens`, BOTH SIDES — comparable by construction.
   *
   * A "before" from provider usage and an "after" from an estimate are two
   * different units, and the card's headline claim ("118k -> 23k") would be
   * comparing a measurement to a guess (§5.1).
   */
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  /** The summary body, so the host needs no second channel to render its card. */
  summary?: string;
  /**
   * Set only when the host clipped oversized `tool_result` bodies inside the
   * RETAINED tail because the tail alone did not fit
   * (context-auto-compaction-hardening §3.3.4 / W2).
   *
   * OPTIONAL, SO NO EXISTING SUBSCRIBER CHANGES. It is here rather than on
   * `CompactionOutcome` because the engine has no use for the distinction — it
   * validates and adopts a history like any other — while `aragon exec`'s JSON
   * stream and the headless stderr line report a bounded, announced data loss
   * the user is entitled to know about.
   */
  tailRelief?: { messages: number; charsRemoved: number };
  durationMs: number;
}

/** Union of all events emitted by the Agent engine. */
export type AgentEvent =
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageUpdateEvent
  | ToolExecutionStartEvent
  | ToolExecutionEndEvent
  | CodeExecutionStartEvent
  | CodeExecutionEndEvent
  | CompactionStartEvent
  | CompactionEndEvent;

/** Callback signature for Agent event listeners. */
export type AgentEventListener = (event: AgentEvent) => void;
