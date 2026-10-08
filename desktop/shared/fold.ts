/**
 * Incremental fold of an `aragon exec` event stream into transcript entries.
 *
 * PURE AND INCREMENTAL BY CONSTRUCTION. The same reducer runs twice - once in
 * the renderer for live streaming, once when replaying a journal after a
 * restart - so both paths are guaranteed to produce identical output.
 *
 * Structural rules (mirroring how the CLI emits):
 * - `text_delta` appends to the open assistant entry of its turn.
 * - `assistant` carries the COMPLETE final text for the turn; it closes any
 *   open streaming entry (deltas already shown are replaced, never duplicated).
 * - `thinking` carries the complete thinking block; the latest one per turn
 *   replaces the previous, matching the CLI's own transcript behaviour.
 * - `tool_call` / `tool_result` pair by `id`; calls without a result yet stay
 *   `running`.
 * - `todo` is ONE evolving entry (key `todo`), updated in place where it first
 *   appeared - the plan is state, not history.
 * - Notices (retry, compaction, error, team, fast tier) are append-only rows.
 * - `result` ends the turn chain; the next `user` starts a new one.
 */

import type {
  ExecAssistantEvent,
  ExecCompactionEvent,
  ExecEvent,
  ExecErrorEvent,
  ExecFastReviewEvent,
  ExecFastTierEvent,
  ExecRetryEvent,
  ExecTeamEvent,
  ExecThinkingEvent,
  ExecTodoEvent,
  ExecToolCallEvent,
  ExecToolResultEvent,
  ExecUserEvent,
} from './exec-events.js';

export interface ToolEntry {
  kind: 'tool';
  key: string;
  turn: number;
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: string | null;
  isError: boolean;
  durationMs: number | null;
  status: 'running' | 'done';
}

export type TranscriptEntry =
  | { kind: 'user'; key: string; turn: number; text: string; source: 'caller' | 'todo_continue' }
  | { kind: 'assistant'; key: string; turn: number; text: string; streaming: boolean }
  | { kind: 'thinking'; key: string; turn: number; text: string; done: boolean }
  | ToolEntry
  | {
      kind: 'todo';
      key: string;
      items: { content: string; status: 'pending' | 'in_progress' | 'completed' }[];
      activeIndex: number;
    }
  | { kind: 'notice'; key: string; tone: 'info' | 'warn' | 'error'; title: string; detail: string }
  | {
      kind: 'review';
      key: string;
      model: string;
      text: string;
    }
  | {
      kind: 'result';
      key: string;
      isError: boolean;
      stopReason: string;
      durationMs: number;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      cost: { amount: number; known: boolean };
      text: string;
    };

export interface SessionUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costAmount: number;
  costKnown: boolean;
  turns: number;
}

export interface FoldState {
  entries: TranscriptEntry[];
  /** Session id from the init event, once seen. */
  sessionId: string | null;
  /** Model line from the init event. */
  model: { provider: string; id: string; baseUrl: string | null } | null;
  usage: SessionUsageTotals;
  turnBusy: boolean;
}

export function createFoldState(): FoldState {
  return {
    entries: [],
    sessionId: null,
    model: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costAmount: 0, costKnown: false, turns: 0 },
    turnBusy: false,
  };
}

/** Fold one event into the state, mutating it. Returns the same state for chaining. */
export function foldEvent(state: FoldState, event: ExecEvent): FoldState {
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        state.sessionId = event.sessionId;
        state.model = event.model;
      }
      return state;
    case 'user':
      foldUser(state, event);
      return state;
    case 'turn_state':
      // `started` opens a request; completed/failed/cancelled close it. The
      // run-level `result` event arrives only when the whole run ends.
      state.turnBusy = event.phase === 'started';
      return state;
    case 'text_delta':
      appendAssistantDelta(state, event.turn, event.delta);
      return state;
    case 'thinking':
      foldThinking(state, event);
      return state;
    case 'assistant':
      foldAssistant(state, event);
      return state;
    case 'tool_call':
      foldToolCall(state, event);
      return state;
    case 'tool_result':
      foldToolResult(state, event);
      return state;
    case 'todo':
      foldTodo(state, event);
      return state;
    case 'retry':
      foldRetry(state, event);
      return state;
    case 'compaction':
      foldCompaction(state, event);
      return state;
    case 'error':
      foldError(state, event);
      return state;
    case 'team':
      foldTeam(state, event);
      return state;
    case 'fast_review':
      foldFastReview(state, event);
      return state;
    case 'fast_tier':
      foldFastTier(state, event);
      return state;
    case 'result':
      foldResult(state, event);
      return state;
    case 'execution_progress':
      return state;
    default:
      // Forward-compatibility: unknown event types are ignored.
      return state;
  }
}

/** Fold a whole journal in order. */
export function foldAll(events: Iterable<ExecEvent>): FoldState {
  const state = createFoldState();
  for (const event of events) foldEvent(state, event);
  return state;
}

function foldUser(state: FoldState, event: ExecUserEvent): void {
  // A new user frame closes any dangling streaming text from the previous
  // turn FIRST - after the push, "last entry" would be this user entry.
  closeOpenAssistant(state);
  state.entries.push({
    kind: 'user',
    key: `user-${event.turn}`,
    turn: event.turn,
    text: event.text,
    source: event.source,
  });
}

function appendAssistantDelta(state: FoldState, turn: number, delta: string): void {
  const last = state.entries[state.entries.length - 1];
  if (last && last.kind === 'assistant' && last.turn === turn && last.streaming) {
    last.text += delta;
    return;
  }
  closeOpenAssistant(state);
  state.entries.push({
    kind: 'assistant',
    key: `assistant-${turn}-${state.entries.length}`,
    turn,
    text: delta,
    streaming: true,
  });
}

function closeOpenAssistant(state: FoldState): void {
  const last = state.entries[state.entries.length - 1];
  if (last && last.kind === 'assistant' && last.streaming) last.streaming = false;
}

function foldAssistant(state: FoldState, event: ExecAssistantEvent): void {
  const last = state.entries[state.entries.length - 1];
  if (last && last.kind === 'assistant' && last.turn === event.turn) {
    last.text = event.text;
    last.streaming = false;
    return;
  }
  state.entries.push({
    kind: 'assistant',
    key: `assistant-${event.turn}-${state.entries.length}`,
    turn: event.turn,
    text: event.text,
    streaming: false,
  });
}

function foldThinking(state: FoldState, event: ExecThinkingEvent): void {
  // The latest thinking block for the turn replaces the previous one; the
  // CLI re-emits with the full accumulated text as it grows.
  for (let i = state.entries.length - 1; i >= 0; i -= 1) {
    const entry = state.entries[i];
    if (entry.kind === 'user') break;
    if (entry.kind === 'thinking' && entry.turn === event.turn) {
      entry.text = event.text;
      entry.done = true;
      return;
    }
  }
  state.entries.push({
    kind: 'thinking',
    key: `thinking-${event.turn}-${state.entries.length}`,
    turn: event.turn,
    text: event.text,
    done: true,
  });
}

function foldToolCall(state: FoldState, event: ExecToolCallEvent): void {
  closeOpenAssistant(state);
  state.entries.push({
    kind: 'tool',
    key: `tool-${event.id}`,
    turn: event.turn,
    id: event.id,
    name: event.name,
    input: event.input,
    output: null,
    isError: false,
    durationMs: null,
    status: 'running',
  });
}

function foldToolResult(state: FoldState, event: ExecToolResultEvent): void {
  const open = state.entries.find(
    (entry): entry is ToolEntry => entry.kind === 'tool' && entry.id === event.id && entry.status === 'running',
  );
  if (open) {
    open.output = event.output;
    open.isError = event.isError;
    open.durationMs = event.durationMs;
    open.status = 'done';
    return;
  }
  // A result with no matching open call (journal replay starting mid-tool):
  // synthesize a completed entry so the output is never lost.
  state.entries.push({
    kind: 'tool',
    key: `tool-${event.id}-${state.entries.length}`,
    turn: event.turn,
    id: event.id,
    name: event.name,
    input: {},
    output: event.output,
    isError: event.isError,
    durationMs: event.durationMs,
    status: 'done',
  });
}

function foldTodo(state: FoldState, event: ExecTodoEvent): void {
  const existing = state.entries.find((entry) => entry.kind === 'todo');
  const items = event.items.map((item) => ({ content: item.content, status: item.status }));
  if (existing && existing.kind === 'todo') {
    existing.items = items;
    existing.activeIndex = event.activeIndex;
    return;
  }
  state.entries.push({ kind: 'todo', key: 'todo', items, activeIndex: event.activeIndex });
}

function foldRetry(state: FoldState, event: ExecRetryEvent): void {
  state.entries.push({
    kind: 'notice',
    key: `retry-${state.entries.length}`,
    tone: 'warn',
    title: `Retrying (${event.attempt}/${event.maxRetries}): ${event.errorType}`,
    detail: event.delayMs > 0 ? `next attempt in ${Math.round(event.delayMs / 1000)}s` : '',
  });
}

function foldCompaction(state: FoldState, event: ExecCompactionEvent): void {
  if (event.subtype === 'start') {
    state.entries.push({
      kind: 'notice',
      key: `compaction-${state.entries.length}`,
      tone: 'info',
      title: `Compacting context (${event.trigger})`,
      detail: '',
    });
    return;
  }
  if (event.applied === false) return;
  const detail =
    event.tokensBefore !== undefined && event.tokensAfter !== undefined
      ? `${event.tokensBefore} -> ${event.tokensAfter} tokens`
      : '';
  state.entries.push({
    kind: 'notice',
    key: `compaction-end-${state.entries.length}`,
    tone: 'info',
    title: `Context compacted${event.mode ? ` (${event.mode})` : ''}`,
    detail,
  });
}

function foldError(state: FoldState, event: ExecErrorEvent): void {
  state.entries.push({
    kind: 'notice',
    key: `error-${state.entries.length}`,
    tone: event.fatal ? 'error' : 'warn',
    title: event.code,
    detail: event.message,
  });
}

function foldTeam(state: FoldState, event: ExecTeamEvent): void {
  if (event.subtype === 'dispatch_start') {
    state.entries.push({
      kind: 'notice',
      key: `team-${state.entries.length}`,
      tone: 'info',
      title: `Delegating to subagents${event.total !== undefined ? ` (${event.total})` : ''}`,
      detail: event.label ?? '',
    });
    return;
  }
  if (event.subtype === 'dispatch_end') {
    state.entries.push({
      kind: 'notice',
      key: `team-end-${state.entries.length}`,
      tone: event.aborted ? 'warn' : 'info',
      title: `Subagents ${event.aborted ? 'aborted' : 'finished'}${
        event.ok !== undefined && event.total !== undefined ? ` (${event.ok}/${event.total} ok)` : ''
      }`,
      detail: event.durationMs !== undefined ? `${Math.round(event.durationMs / 1000)}s` : '',
    });
  }
}

function foldFastReview(state: FoldState, event: ExecFastReviewEvent): void {
  state.entries.push({
    kind: 'review',
    key: `review-${state.entries.length}`,
    model: event.model,
    text: event.text,
  });
}

function foldFastTier(state: FoldState, event: ExecFastTierEvent): void {
  if (event.live && !event.selfDisabled) return;
  const reason = event.selfDisabled
    ? 'fast tier switched itself off after repeated failures'
    : event.budgetReached
      ? 'fast tier review budget reached'
      : 'fast tier off';
  state.entries.push({
    kind: 'notice',
    key: `fast-tier-${state.entries.length}`,
    tone: 'warn',
    title: 'Fast tier update',
    detail: reason,
  });
}

function foldResult(state: FoldState, event: ExecEvent & { type: 'result' }): void {
  closeOpenAssistant(state);
  state.usage.inputTokens += event.usage.inputTokens;
  state.usage.outputTokens += event.usage.outputTokens;
  state.usage.totalTokens += event.usage.totalTokens;
  state.usage.costAmount += event.usage.totalTokens > 0 ? event.cost.amount : 0;
  state.usage.costKnown = state.usage.costKnown || event.cost.known;
  state.usage.turns += 1;
  state.turnBusy = false;
  state.entries.push({
    kind: 'result',
    key: `result-${state.entries.length}`,
    isError: event.isError,
    stopReason: event.stopReason,
    durationMs: event.durationMs,
    usage: event.usage,
    cost: { amount: event.cost.amount, known: event.cost.known },
    text: event.result,
  });
}
