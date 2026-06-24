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
  | CodeExecutionEndEvent;

/** Callback signature for Agent event listeners. */
export type AgentEventListener = (event: AgentEvent) => void;
