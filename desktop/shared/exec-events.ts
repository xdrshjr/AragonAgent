/**
 * Mirror of the `aragon exec` stream-json event contract (EXEC_SCHEMA_VERSION 1).
 *
 * The CLI package is a bin-only package with no programmatic exports, so a
 * wrapper maintains its own type mirror - the README's forward-compatibility
 * rule ("ignore event types you do not know, ignore fields you do not know")
 * is what makes a mirror safe: additive changes on the CLI side never break it.
 *
 * Keep field names and semantics byte-compatible with
 * `packages/cli/src/exec/events.ts`. When that file renames or removes
 * something, EXEC_SCHEMA_VERSION moves there and this mirror follows.
 */

export const EXEC_SCHEMA_VERSION = 1;

export type ExecPermissionMode = 'auto' | 'plan' | 'strict';
export type ExecStopReason = 'end_turn' | 'max_turns' | 'timeout' | 'interrupted' | 'error';

export interface ExecUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ExecCost {
  amount: number;
  currency: 'USD';
  known: boolean;
}

export interface ExecErrorInfo {
  code: string;
  message: string;
}

export interface ExecSystemInitEvent {
  type: 'system';
  subtype: 'init';
  schemaVersion: number;
  sessionId: string;
  cli: string;
  cwd: string;
  startedAt: number;
  model: { provider: string; id: string; baseUrl: string | null };
  permissionMode: ExecPermissionMode;
  tools: string[];
  resumed: boolean;
  capabilities?: string[];
  sessionFile?: string | null;
}

export interface ExecUserEvent {
  type: 'user';
  sessionId: string;
  turn: number;
  text: string;
  source: 'caller' | 'todo_continue';
}

export interface ExecTurnStateEvent {
  type: 'turn_state';
  sessionId: string;
  requestSeq: number;
  phase: 'started' | 'completed' | 'failed' | 'cancelled';
}

export interface ExecProgressEvent {
  type: 'execution_progress';
  sessionId: string;
  requestSeq: number;
  progressSeq: number;
  phase: 'model' | 'thinking' | 'tool_arguments' | 'tool' | 'compaction' | 'retry';
  retryDelayMs?: number;
}

export interface ExecTextDeltaEvent {
  type: 'text_delta';
  sessionId: string;
  turn: number;
  delta: string;
}

export interface ExecThinkingEvent {
  type: 'thinking';
  sessionId: string;
  turn: number;
  text: string;
}

export interface ExecAssistantEvent {
  type: 'assistant';
  sessionId: string;
  turn: number;
  text: string;
}

export interface ExecToolCallEvent {
  type: 'tool_call';
  sessionId: string;
  turn: number;
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ExecToolResultEvent {
  type: 'tool_result';
  sessionId: string;
  turn: number;
  id: string;
  name: string;
  isError: boolean;
  durationMs: number;
  output: string;
}

export interface ExecTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ExecTodoEvent {
  type: 'todo';
  sessionId: string;
  total: number;
  done: number;
  activeIndex: number;
  items: ExecTodoItem[];
}

export interface ExecTeamEvent {
  type: 'team';
  sessionId: string;
  subtype: 'dispatch_start' | 'agent_update' | 'dispatch_end';
  label?: string;
  phase?: string;
  description?: string;
  durationMs?: number;
  toolCalls?: number;
  ok?: number;
  total?: number;
  aborted?: boolean;
}

export interface ExecFastReviewEvent {
  type: 'fast_review';
  sessionId: string;
  turn: number;
  model: string;
  text: string;
}

export interface ExecFastTierEvent {
  type: 'fast_tier';
  sessionId: string;
  turn: number;
  live: boolean;
  selfDisabled: boolean;
  model: string;
  sameAsMain: boolean;
  reviews: number;
  reviewBudget: number;
  budgetReached: boolean;
  delegated: number;
  inFlight: boolean;
  review?: {
    index: number;
    kind: 'ok' | 'advice' | 'empty' | 'failed' | 'dropped';
    detail?: string;
    durationMs: number;
    injected: boolean;
  };
}

export interface ExecCompactionEvent {
  type: 'compaction';
  sessionId: string;
  turn: number;
  subtype: 'start' | 'end';
  trigger: 'pressure' | 'overflow' | 'manual';
  applied?: boolean;
  mode?: 'summarized' | 'truncated' | 'relieved' | 'none';
  reason?: string;
  messagesBefore?: number;
  messagesAfter?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  tailRelief?: { messages: number; charsRemoved: number };
  durationMs?: number;
}

export interface ExecRetryEvent {
  type: 'retry';
  sessionId: string;
  attempt: number;
  maxRetries: number;
  errorType: string;
  delayMs: number;
}

export interface ExecErrorEvent {
  type: 'error';
  sessionId: string;
  fatal: boolean;
  code: string;
  message: string;
}

export interface ExecResultEvent {
  type: 'result';
  schemaVersion: number;
  sessionId: string;
  isError: boolean;
  stopReason: ExecStopReason;
  exitCode: number;
  result: string;
  turns: number;
  durationMs: number;
  usage: ExecUsage;
  cost: ExecCost;
  model: { provider: string; id: string };
  todos: { total: number; done: number } | null;
  error: ExecErrorInfo | null;
}

export type ExecEvent =
  | ExecSystemInitEvent
  | ExecUserEvent
  | ExecTurnStateEvent
  | ExecProgressEvent
  | ExecTextDeltaEvent
  | ExecThinkingEvent
  | ExecAssistantEvent
  | ExecToolCallEvent
  | ExecToolResultEvent
  | ExecTodoEvent
  | ExecTeamEvent
  | ExecFastReviewEvent
  | ExecFastTierEvent
  | ExecCompactionEvent
  | ExecRetryEvent
  | ExecErrorEvent
  | ExecResultEvent;

/** Frames a wrapper may write to the exec stdin stream (input-format stream-json). */
export type ExecInputFrame =
  | { type: 'user'; text: string }
  | { type: 'interrupt' }
  | { type: 'end' };

export function isExecEvent(value: unknown): value is ExecEvent {
  if (value === null || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && type.length > 0;
}
