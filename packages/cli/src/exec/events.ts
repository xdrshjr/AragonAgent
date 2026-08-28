/**
 * THE CONTRACT (cli-integration-surface section 5.1).
 *
 * ASCII ONLY - `src/exec/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts::inScope`, R-3 / AC-25). Every string here can reach a
 * consumer's terminal through `--output-format text` fallbacks or a stderr
 * warning, and the whole point of the scanner is that a legacy `cmd.exe` shows
 * mojibake for anything else.
 *
 * PURE TYPES AND BUILDERS. No I/O, no process access, no imports outside
 * `node:`-free type space, so a consumer of this module cannot accidentally
 * evaluate the runner.
 *
 * `EXEC_SCHEMA_VERSION` appears on `system` and on `result` and NOWHERE ELSE.
 * ADDING A FIELD OR AN EVENT TYPE NEVER BUMPS IT; renaming or removing one does.
 * That rule only holds if consumers keep their side of it, so the README states
 * it in the same words: ignore event types you do not know, ignore fields you do
 * not know. Without that contract the version would have to move for every
 * additive change and every wrapper would pin an exact number forever.
 */

export const EXEC_SCHEMA_VERSION = 1;

/** The three baselines of section 4.2. `plan` is a MODE, never a filter. */
export type ExecPermissionMode = 'auto' | 'plan' | 'strict';

export type ExecOutputFormat = 'text' | 'json' | 'stream-json';
export type ExecInputFormat = 'text' | 'stream-json';

/**
 * Why the run ended.
 *
 * `interrupted` covers ALL THREE signals (section 3.6): which one arrived is an
 * operating-system fact, not an agent outcome, and a wrapper that wants to know
 * reads `exitCode` - which follows the CLI's existing `128 + signo` convention.
 */
export type ExecStopReason = 'end_turn' | 'max_turns' | 'timeout' | 'interrupted' | 'error';

export interface ExecUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ExecCost {
  amount: number;
  currency: 'USD';
  /**
   * `controller.isPricedModel(...)` (P2-3) - the method the CLI already uses for
   * this question, not a second price table. When it is `false`, `amount` is `0`:
   * a feature that looks free while it is spending money is worse than one that
   * admits it does not know.
   */
  known: boolean;
}

export interface ExecTodoCounts {
  total: number;
  done: number;
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
}

export interface ExecUserEvent {
  type: 'user';
  sessionId: string;
  turn: number;
  text: string;
  /**
   * `todo_continue` marks a message the CLI generated on the caller's behalf
   * through the follow-through loop. A wrapper replaying a transcript has to be
   * able to tell those apart from what it actually sent.
   */
  source: 'caller' | 'todo_continue';
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
  /**
   * NOT TRUNCATED A SECOND TIME (AC-26). The core executor already clips at
   * roughly 100 KB, and this event carries what the MODEL saw - the only
   * faithful choice. A consumer therefore needs a line reader without a small
   * buffer cap, and the README says so.
   */
  output: string;
}

export interface ExecTodoEvent {
  type: 'todo';
  sessionId: string;
  total: number;
  done: number;
  activeIndex: number;
  items: { content: string; status: 'pending' | 'in_progress' | 'completed' }[];
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

/**
 * Context compaction (context-auto-compaction §4.6).
 *
 * ONE ADDITIVE EVENT TYPE, AND `EXEC_SCHEMA_VERSION` DOES NOT MOVE — the rule
 * this file's header states in the same words: adding a field or an event type
 * never bumps it; renaming or removing one does. A consumer that ignores event
 * types it does not know is unaffected.
 *
 * THE SUMMARY TEXT IS DELIBERATELY ABSENT (D-18). It can be tens of thousands of
 * characters, no wrapper needs it, and the transcript card and the log both have
 * it. What a wrapper does need is the SHAPE of what happened, which is here.
 */
export interface ExecCompactionEvent {
  type: 'compaction';
  sessionId: string;
  turn: number;
  subtype: 'start' | 'end';
  trigger: 'pressure' | 'overflow' | 'manual';
  /** `end` only. */
  applied?: boolean;
  /**
   * `relieved` means the RETAINED turns were clipped and nothing was dropped
   * (context-auto-compaction-hardening §3.3 / W2).
   *
   * A NEW MEMBER OF AN EXISTING UNION, WHICH DOES NOT MOVE `EXEC_SCHEMA_VERSION`
   * either - the rule this file's header states covers adding, not renaming or
   * removing. A consumer switching on this field already has to handle a value it
   * does not know, because `none` and `truncated` were both already possible.
   */
  mode?: 'summarized' | 'truncated' | 'relieved' | 'none';
  reason?: string;
  messagesBefore?: number;
  messagesAfter?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  /**
   * Present only when tail relief fired (§4.5).
   *
   * A BOUNDED, ANNOUNCED DATA LOSS INSIDE THE TURNS THE RUN CONTINUES FROM, and
   * therefore something a wrapper is entitled to see. The clipped bodies
   * themselves are not on the stream, for the same reason `summary` is not
   * (D-18).
   */
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
  /** `false` for a line the run recovered from (a malformed stdin line, say). */
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
  /**
   * `0` success | `1` agent error | `2` usage/config | `3` budget |
   * `128 + signo` for a signal (130 SIGINT, 143 SIGTERM, 129 SIGHUP).
   *
   * DELIBERATELY `number`, NOT A UNION (P1-11): `logging/install.ts` holds
   * `SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }` and exits
   * `128 + signo`, so the signal values are open-ended and a union that omitted
   * 143 would make the honest value unrepresentable.
   */
  exitCode: number;
  /** The final assistant text; `''` when there was none. */
  result: string;
  turns: number;
  durationMs: number;
  usage: ExecUsage;
  cost: ExecCost;
  model: { provider: string; id: string };
  todos: ExecTodoCounts | null;
  error: ExecErrorInfo | null;
}

export type ExecEvent =
  | ExecSystemInitEvent
  | ExecUserEvent
  | ExecTextDeltaEvent
  | ExecThinkingEvent
  | ExecAssistantEvent
  | ExecToolCallEvent
  | ExecToolResultEvent
  | ExecTodoEvent
  | ExecTeamEvent
  | ExecFastReviewEvent
  | ExecCompactionEvent
  | ExecRetryEvent
  | ExecErrorEvent
  | ExecResultEvent;

/** Everything `system/init` needs that the runner cannot derive for itself. */
export interface ExecInitParams {
  sessionId: string;
  cli: string;
  cwd: string;
  startedAt: number;
  model: { provider: string; id: string; baseUrl: string | null };
  permissionMode: ExecPermissionMode;
  tools: string[];
  resumed: boolean;
}

export function buildInitEvent(params: ExecInitParams): ExecSystemInitEvent {
  return {
    type: 'system',
    subtype: 'init',
    schemaVersion: EXEC_SCHEMA_VERSION,
    sessionId: params.sessionId,
    cli: params.cli,
    cwd: params.cwd,
    startedAt: params.startedAt,
    model: params.model,
    permissionMode: params.permissionMode,
    tools: params.tools,
    resumed: params.resumed,
  };
}

/** Everything `result` needs. `schemaVersion` is stamped here, never by a caller. */
export type ExecResultParams = Omit<ExecResultEvent, 'type' | 'schemaVersion'>;

export function buildResultEvent(params: ExecResultParams): ExecResultEvent {
  return { type: 'result', schemaVersion: EXEC_SCHEMA_VERSION, ...params };
}

/** Serialize one event as an NDJSON line, terminator included. */
export function toNdjsonLine(event: ExecEvent): string {
  return `${JSON.stringify(event)}\n`;
}
