/**
 * Pure event → view reducer (spec §3.4 / §6.2).
 *
 * `reduceEvent(event)` maps a raw core `AgentEvent` into zero or more view
 * actions; `viewReducer(state, action)` folds an action into the immutable
 * `ViewState`. Keeping this pure lets the whole UI be tested without a live LLM.
 *
 * Two load-bearing behaviors from R2 (silent-failure surfacing) live here:
 *   - the `error` StreamEvent is rendered as an error notice, and
 *   - `agent_end` after a turn that produced no `turn_end` and no error notice
 *     synthesizes a generic error notice (a swallowed throw is never a no-op).
 */

import type {
  AgentEvent,
  ModelCost,
  StreamEvent,
  ToolResult,
  TokenUsage,
} from '@argon-agent/core';
import { computeCost } from './usage.js';

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type NoticeLevel = 'info' | 'warn' | 'error';
export type ToastLevel = NoticeLevel | 'success';
export type Overlay = null | 'settings' | 'model' | 'help' | 'confirm';
export type ToolStatus = 'pending' | 'running' | 'done' | 'error';

/** Ephemeral, auto-dismissed acknowledgement (spec §3.9). */
export interface Toast {
  id: string;
  level: ToastLevel;
  text: string;
  ttlMs: number;
}

/** Default auto-dismiss window for a toast. */
export const DEFAULT_TOAST_TTL_MS = 2500;

export type Entry =
  | { id: string; kind: 'user'; text: string }
  | {
      id: string;
      kind: 'assistant';
      text: string;
      thinking?: string;
      thinkingOpen: boolean;
      streaming: boolean;
      aborted?: boolean;
      usage?: TokenUsage;
    }
  | {
      id: string;
      kind: 'tool';
      toolCallId: string;
      name: string;
      label: string;
      argsRaw: string;
      args?: Record<string, unknown>;
      status: ToolStatus;
      preview?: string;
      durationMs?: number;
      isError?: boolean;
    }
  | { id: string; kind: 'notice'; level: NoticeLevel; text: string };

export interface UsageTotal {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ViewState {
  entries: Entry[];
  status: 'idle' | 'running';
  usageTotal: UsageTotal;
  /** Running input size of the most recent turn vs. the model context window. */
  contextTokens: number;
  overlay: Overlay;
  thinkingVisible: boolean;
  /** Ephemeral acks; auto-dismissed by App (spec §3.9). */
  toasts: Toast[];
  /** Which tool cards are expanded to their full stored preview (spec §3.7). */
  expandedToolIds: Record<string, true>;

  // Internal bookkeeping (not rendered directly).
  seq: number;
  streamingId?: string;
  turnProduced: boolean;
  errorNoticed: boolean;
  /** The current run was aborted by the user (suppresses the failure guard). */
  aborted: boolean;
}

export function initialViewState(): ViewState {
  return {
    entries: [],
    status: 'idle',
    usageTotal: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    contextTokens: 0,
    overlay: null,
    thinkingVisible: true,
    toasts: [],
    expandedToolIds: {},
    seq: 0,
    streamingId: undefined,
    turnProduced: false,
    errorNoticed: false,
    aborted: false,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ViewAction =
  | { type: 'submit'; text: string }
  | { type: 'runStart' }
  | { type: 'turnStart' }
  | { type: 'thinkingStart' }
  | { type: 'thinkingDelta'; delta: string }
  | { type: 'textDelta'; delta: string }
  | { type: 'toolCallStart'; toolCallId: string; toolName: string; label?: string }
  | { type: 'toolCallDelta'; toolCallId: string; argsDelta: string }
  | { type: 'toolCallEnd'; toolCallId: string; args: Record<string, unknown> }
  | { type: 'toolExecStart'; toolCallId: string }
  | {
      type: 'toolExecEnd';
      toolCallId: string;
      isError: boolean;
      duration: number;
      preview: string;
    }
  | { type: 'turnEnd'; usage: TokenUsage; costDelta: number }
  | { type: 'runEnd' }
  | { type: 'notice'; level: NoticeLevel; text: string }
  | { type: 'abortMark' }
  | { type: 'clearTranscript' }
  | { type: 'resetConversation' }
  | { type: 'setOverlay'; overlay: Overlay }
  | { type: 'toggleThinking' }
  | { type: 'pushToast'; level: ToastLevel; text: string; ttlMs?: number }
  | { type: 'dismissToast'; id: string }
  | { type: 'toggleExpand'; id: string }
  | { type: 'restoreEntries'; entries: Entry[] };

// ---------------------------------------------------------------------------
// Event → actions
// ---------------------------------------------------------------------------

// Stored preview caps (spec §3.7 / P1-3). Raised from 16 / 800 so a `Ctrl+O`
// expansion can actually reveal lines 9…200 and the bash `[exit code N]` footer
// survives ≥16-line output. The *collapsed* view still shows only 8 lines
// (COLLAPSED_LINES in ToolCard).
export const STORED_PREVIEW_CHARS = 8000;
export const STORED_PREVIEW_LINES = 200;

/**
 * Marker appended to a truncated tool preview. ASCII on purpose: this string is
 * produced outside `src/ui/**`, where no terminal capabilities are available, so
 * it must be safe on a legacy `cmd.exe` (spec §4.1 tier A). `ToolPreview` dims
 * this line and imports the constant rather than re-spelling it — the two used
 * to be a matched pair of `…` literals, and splitting the spelling would break
 * the dimming silently.
 */
export const PREVIEW_TRUNCATION_MARK = '...';

/**
 * Flatten a ToolResult into a stored preview string. Truncation appends
 * `PREVIEW_TRUNCATION_MARK` (line- or char-based) so a card footer never
 * over-promises how much more is expandable.
 */
export function buildToolPreview(result: ToolResult): string {
  const text = result.content
    .map((c) => (c.type === 'text' ? c.text : `[image: ${c.mediaType}]`))
    .join('\n');
  const allLines = text.split('\n');
  const lines = allLines.slice(0, STORED_PREVIEW_LINES);
  let preview = lines.join('\n');
  const lineTruncated = allLines.length > STORED_PREVIEW_LINES;
  if (preview.length > STORED_PREVIEW_CHARS) {
    preview = `${preview.slice(0, STORED_PREVIEW_CHARS)}${PREVIEW_TRUNCATION_MARK}`;
  } else if (lineTruncated) {
    preview = `${preview}\n${PREVIEW_TRUNCATION_MARK}`;
  }
  return preview;
}

/**
 * Map one core `AgentEvent` to view actions. `cost` (the active model's cost
 * table) lets `turn_end` accumulate USD cost; omit it in tests that only assert
 * token totals.
 */
export function reduceEvent(event: AgentEvent, cost?: ModelCost): ViewAction[] {
  switch (event.type) {
    case 'agent_start':
      return [{ type: 'runStart' }];
    case 'turn_start':
      return [{ type: 'turnStart' }];
    case 'turn_end':
      return [
        {
          type: 'turnEnd',
          usage: event.usage,
          costDelta: computeCost(event.usage, cost),
        },
      ];
    case 'agent_end':
      return [{ type: 'runEnd' }];
    case 'tool_execution_start':
      return [{ type: 'toolExecStart', toolCallId: event.toolCallId }];
    case 'tool_execution_end':
      return [
        {
          type: 'toolExecEnd',
          toolCallId: event.toolCallId,
          isError: event.isError,
          duration: event.duration,
          preview: buildToolPreview(event.result),
        },
      ];
    case 'message_update':
      return reduceStreamEvent(event.streamEvent);
    case 'code_execution_start':
    case 'code_execution_end':
      // CodeAct sandbox is off by default; no dedicated view surface in v1.
      return [];
    default:
      return [];
  }
}

function reduceStreamEvent(se: StreamEvent): ViewAction[] {
  switch (se.type) {
    case 'thinking_start':
      return [{ type: 'thinkingStart' }];
    case 'thinking_delta':
      return [{ type: 'thinkingDelta', delta: se.delta }];
    case 'text_delta':
      return [{ type: 'textDelta', delta: se.delta }];
    case 'tool_call_start':
      return [
        { type: 'toolCallStart', toolCallId: se.toolCallId, toolName: se.toolName },
      ];
    case 'tool_call_delta':
      return [
        { type: 'toolCallDelta', toolCallId: se.toolCallId, argsDelta: se.argsDelta },
      ];
    case 'tool_call_end':
      return [{ type: 'toolCallEnd', toolCallId: se.toolCallId, args: se.args }];
    case 'error':
      return [
        {
          type: 'notice',
          level: 'error',
          text: formatStreamError(se.error),
        },
      ];
    case 'done':
      // Authoritative usage is redundant with `turn_end`; nothing to add.
      return [];
    default:
      return [];
  }
}

/** Turn a provider error into a friendly banner, mapping LLMError.errorType. */
export function formatStreamError(error: Error): string {
  const errorType = (error as { errorType?: string }).errorType;
  const base = error.message || 'Unknown error';
  switch (errorType) {
    case 'auth_error':
      return `Authentication failed - check your API key. (${base})`;
    case 'rate_limit':
      return `Rate limited by the provider - please retry shortly. (${base})`;
    case 'overloaded':
      return `Provider overloaded - please retry shortly. (${base})`;
    case 'context_overflow':
      return `Context length exceeded - start a new conversation with /reset. (${base})`;
    case 'network_error':
      return `Network error reaching the provider. (${base})`;
    case 'timeout':
      return `The request timed out. (${base})`;
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

const GENERIC_RUN_FAILURE =
  'The run ended without producing a response - check your API key, model, and network.';

function nextId(state: ViewState): { id: string; seq: number } {
  const seq = state.seq + 1;
  return { id: `e${seq}`, seq };
}

function mapEntry(entries: Entry[], id: string, fn: (e: Entry) => Entry): Entry[] {
  return entries.map((e) => (e.id === id ? fn(e) : e));
}

function findToolEntryId(state: ViewState, toolCallId: string): string | undefined {
  for (let i = state.entries.length - 1; i >= 0; i -= 1) {
    const e = state.entries[i];
    if (e && e.kind === 'tool' && e.toolCallId === toolCallId) return e.id;
  }
  return undefined;
}

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case 'submit': {
      const { id, seq } = nextId(state);
      const entry: Entry = { id, kind: 'user', text: action.text };
      return {
        ...state,
        seq,
        entries: [...state.entries, entry],
        streamingId: undefined,
        turnProduced: false,
        errorNoticed: false,
        aborted: false,
      };
    }

    case 'runStart':
      return {
        ...state,
        status: 'running',
        turnProduced: false,
        errorNoticed: false,
        aborted: false,
      };

    case 'turnStart': {
      const { id, seq } = nextId(state);
      const entry: Entry = {
        id,
        kind: 'assistant',
        text: '',
        thinking: undefined,
        thinkingOpen: false,
        streaming: true,
      };
      return { ...state, seq, entries: [...state.entries, entry], streamingId: id };
    }

    case 'thinkingStart': {
      if (!state.streamingId) return state;
      return {
        ...state,
        entries: mapEntry(state.entries, state.streamingId, (e) =>
          e.kind === 'assistant' ? { ...e, thinking: e.thinking ?? '', thinkingOpen: true } : e,
        ),
      };
    }

    case 'thinkingDelta': {
      if (!state.streamingId) return state;
      return {
        ...state,
        entries: mapEntry(state.entries, state.streamingId, (e) =>
          e.kind === 'assistant'
            ? { ...e, thinking: (e.thinking ?? '') + action.delta }
            : e,
        ),
      };
    }

    case 'textDelta': {
      if (!state.streamingId) return state;
      return {
        ...state,
        entries: mapEntry(state.entries, state.streamingId, (e) =>
          e.kind === 'assistant' ? { ...e, text: e.text + action.delta } : e,
        ),
      };
    }

    case 'toolCallStart': {
      const { id, seq } = nextId(state);
      const entry: Entry = {
        id,
        kind: 'tool',
        toolCallId: action.toolCallId,
        name: action.toolName,
        label: action.label ?? action.toolName,
        argsRaw: '',
        status: 'pending',
      };
      return { ...state, seq, entries: [...state.entries, entry] };
    }

    case 'toolCallDelta': {
      const id = findToolEntryId(state, action.toolCallId);
      if (!id) return state;
      return {
        ...state,
        entries: mapEntry(state.entries, id, (e) =>
          e.kind === 'tool' ? { ...e, argsRaw: e.argsRaw + action.argsDelta } : e,
        ),
      };
    }

    case 'toolCallEnd': {
      const id = findToolEntryId(state, action.toolCallId);
      if (!id) return state;
      return {
        ...state,
        entries: mapEntry(state.entries, id, (e) =>
          e.kind === 'tool'
            ? { ...e, args: action.args, argsRaw: safeStringify(action.args) }
            : e,
        ),
      };
    }

    case 'toolExecStart': {
      const id = findToolEntryId(state, action.toolCallId);
      if (!id) return state;
      return {
        ...state,
        entries: mapEntry(state.entries, id, (e) =>
          e.kind === 'tool' ? { ...e, status: 'running' } : e,
        ),
      };
    }

    case 'toolExecEnd': {
      const id = findToolEntryId(state, action.toolCallId);
      if (!id) return state;
      return {
        ...state,
        entries: mapEntry(state.entries, id, (e) =>
          e.kind === 'tool'
            ? {
                ...e,
                status: action.isError ? 'error' : 'done',
                isError: action.isError,
                durationMs: action.duration,
                preview: action.preview,
              }
            : e,
        ),
      };
    }

    case 'turnEnd': {
      const entries = state.streamingId
        ? mapEntry(state.entries, state.streamingId, (e) =>
            e.kind === 'assistant'
              ? { ...e, streaming: false, thinkingOpen: false, usage: action.usage }
              : e,
          )
        : state.entries;
      return {
        ...state,
        entries,
        streamingId: undefined,
        turnProduced: true,
        contextTokens: action.usage.inputTokens + action.usage.outputTokens,
        usageTotal: {
          inputTokens: state.usageTotal.inputTokens + action.usage.inputTokens,
          outputTokens: state.usageTotal.outputTokens + action.usage.outputTokens,
          costUsd: state.usageTotal.costUsd + action.costDelta,
        },
      };
    }

    case 'runEnd': {
      // Finalize any still-streaming entry.
      let entries = state.streamingId
        ? mapEntry(state.entries, state.streamingId, (e) =>
            e.kind === 'assistant' ? { ...e, streaming: false } : e,
          )
        : state.entries;
      let seq = state.seq;

      // Silent-failure guard (R2): a swallowed throw shows nothing otherwise.
      // A user abort is an expected empty run, not a failure — skip the guard.
      if (!state.turnProduced && !state.errorNoticed && !state.aborted) {
        const next = nextId({ ...state, seq });
        seq = next.seq;
        entries = [
          ...entries,
          { id: next.id, kind: 'notice', level: 'error', text: GENERIC_RUN_FAILURE },
        ];
      }

      return { ...state, entries, seq, status: 'idle', streamingId: undefined };
    }

    case 'notice': {
      const { id, seq } = nextId(state);
      const entry: Entry = { id, kind: 'notice', level: action.level, text: action.text };
      return {
        ...state,
        seq,
        entries: [...state.entries, entry],
        errorNoticed: action.level === 'error' ? true : state.errorNoticed,
      };
    }

    case 'abortMark': {
      // Mark the run aborted even when no assistant entry is streaming (e.g. an
      // abort during a tool call) so the runEnd failure guard stays suppressed.
      if (!state.streamingId) return { ...state, aborted: true };
      return {
        ...state,
        aborted: true,
        entries: mapEntry(state.entries, state.streamingId, (e) =>
          e.kind === 'assistant' ? { ...e, streaming: false, aborted: true } : e,
        ),
      };
    }

    case 'clearTranscript':
      return { ...state, entries: [], streamingId: undefined, expandedToolIds: {} };

    case 'resetConversation':
      return {
        ...state,
        entries: [],
        streamingId: undefined,
        expandedToolIds: {},
        contextTokens: 0,
        usageTotal: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };

    case 'setOverlay':
      return { ...state, overlay: action.overlay };

    case 'toggleThinking':
      return { ...state, thinkingVisible: !state.thinkingVisible };

    case 'pushToast': {
      const { seq } = nextId(state);
      const toast: Toast = {
        id: `t${seq}`,
        level: action.level,
        text: action.text,
        ttlMs: action.ttlMs ?? DEFAULT_TOAST_TTL_MS,
      };
      return { ...state, seq, toasts: [...state.toasts, toast] };
    }

    case 'dismissToast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };

    case 'toggleExpand': {
      const next = { ...state.expandedToolIds };
      if (next[action.id]) delete next[action.id];
      else next[action.id] = true;
      return { ...state, expandedToolIds: next };
    }

    case 'restoreEntries': {
      // Adopt a seq beyond any restored id to keep future ids unique.
      const maxSeq = action.entries.reduce((acc, e) => {
        const n = Number.parseInt(e.id.replace(/^e/, ''), 10);
        return Number.isFinite(n) ? Math.max(acc, n) : acc;
      }, state.seq);
      return { ...state, entries: [...action.entries], seq: maxSeq };
    }

    default:
      return state;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
