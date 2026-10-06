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

import process from 'node:process';
import type {
  AgentEvent,
  ModelCost,
  StreamEvent,
  ToolResult,
  TokenUsage,
} from '@aragon-agent/core';
import type { AgentMode } from './agent-mode.js';
import type { DispatchOutcome, SubagentRun, SubagentSpec, TeamSnapshot } from '../team/types.js';
import type { FastReview, FastSnapshot } from '../fast/types.js';
import type {
  CompactionMode,
  CompactionRecord,
  CompactionSnapshot,
  CompactionUiTrigger,
  ContextUsageSnapshot,
} from '../compaction/types.js';
import { emptyContextUsage } from '../compaction/meter.js';
import type { TodoItem, TodoSnapshot } from '../todo/types.js';
// TYPE-ONLY: `proc/types.ts` is a pure leaf and the erased import keeps this
// module free of a runtime edge into the supervisor.
import type { ServiceSnapshot, ServiceStatus } from '../proc/types.js';
import type { RetryPhase } from './retry-view.js';
// TYPE-ONLY, and deliberately so: `tools/patch.ts` is a pure leaf and the erased
// import keeps this module free of a runtime edge into the tool layer.
import type { FilePatch } from '../tools/patch.js';
import { addUsage, computeCost } from './usage.js';
import { ENTRY_LIMITS, appendBounded, entryRetain, trimEntries } from './entry-limits.js';

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type NoticeLevel = 'info' | 'warn' | 'error';
export type ToastLevel = NoticeLevel | 'success';
export type Overlay =
  | null
  | 'settings'
  | 'model'
  | 'help'
  | 'confirm'
  | 'question'
  | 'plan';
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
      /**
       * Epoch ms the turn started reasoning (agent-activity-presentation §3.1.2).
       * Set by `thinkingStart`, cleared by `streamRestart`.
       */
      thinkingStartedAt?: number;
      /**
       * Wall-clock reasoning time, SEALED ONCE — at the first text delta, or at
       * turn/run end for a turn that thought and then called a tool without
       * emitting any text.
       *
       * With thinking hidden this is the only thing the collapsed marker can say
       * that the user could not otherwise know, which is the whole argument for
       * having a marker at all (§1.2).
       */
      thinkingMs?: number;
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
      /**
       * The structured file diff (agent-activity-presentation §3.3), or absent.
       *
       * IMMUTABLE AND WRITTEN ONCE, by `toolExecEnd`. `ToolCard` is `React.memo`'d
       * with the DEFAULT comparator, so this object is only free while its
       * reference is stable — which it is, because the reducer never rebuilds it
       * and `mapEntry` preserves identity for untouched entries. A future action
       * that recomputed or normalized a patch would turn that memo boundary into
       * a no-op WITH NOTHING FAILING (P2-9).
       *
       * Needs no clause in `normalizeLoadedEntries` (D-9): the four that exist
       * are all about a LIVE flag that would never settle, and a patch is settled
       * by construction.
       */
      patch?: FilePatch;
      /**
       * The sanitised live tail while the tool runs
       * (agent-activity-presentation-live §3.3.1). Cleared at settle (D-23), and
       * cleared again by EVERY path that reaches `status: 'idle'` (D-35).
       *
       * REDUCER STATE RATHER THAN A STORE READ DURING RENDER, and that is the
       * load-bearing decision of the round (D-22): `entryRevision` is what tells
       * the height cache an entry's rendered output changed, and an entry mutated
       * outside `ViewState` keeps its revision and freezes at a stale height AND
       * a stale subtree with nothing anywhere reporting it (I-L3-1).
       */
      live?: readonly string[];
      /**
       * Monotonic counter -- the revision term for a NON-APPEND mutation (D-22).
       *
       * A COUNTER AND NOT `live.length`: a fixed-size tail evicting its oldest
       * row while appending a new one of the same width leaves the joined length
       * unchanged, which is exactly the lossy case `virtual-window.ts` says the
       * reducer cannot produce today and that this round introduces.
       */
      liveSeq?: number;
      /** Epoch ms of the last output row, for the stall row (§3.3.4). */
      lastOutputAt?: number;
    }
  | { id: string; kind: 'notice'; level: NoticeLevel; text: string }

  | {
      id: string;
      kind: 'team';
      dispatchId: string;
      requested: number;
      runs: SubagentRun[];
      aborted: boolean;
      durationMs?: number;
      active: boolean;
    }

  | {
      id: string;
      kind: 'todo';
      items: TodoItem[];
      doneCount: number;
      total: number;
      /** The turn that owns this card is still running, so it may be rewritten. */
      live: boolean;
      /**
       * Set by `normalizeLoadedEntries` on a card saved while its run was live
       * (P2-6). The todo analogue of the team entry's `aborted`, and true for the
       * same reason: the run behind it died with the process. Absent on every
       * card this session produced.
       */
      interrupted?: boolean;
    }

  | {
      id: string;
      kind: 'retry';
      /** 1-based retry index of the LATEST attempt this card has seen. */
      attempt: number;
      maxRetries: number;
      errorType: string;
      message: string;
      delayMs: number;
      /** Epoch ms the next attempt fires; the UI ticks against this. */
      resumeAt?: number;
      phase: RetryPhase;
      startedAt: number;
      /** Filled on settle. */
      totalRetries?: number;
      elapsedMs?: number;
    }

  | {
      id: string;
      kind: 'fast';
      /** 1-based within the session, so the card can name itself. */
      reviewIndex: number;
      model: string;
      status: 'running' | 'ok' | 'advice' | 'empty' | 'failed' | 'dropped';
      /** Present only for `advice`. */
      text?: string;
      /** Failure / drop reason, shown as one muted line. */
      detail?: string;
      turn: number;
      durationMs?: number;
      live: boolean;
    }

  | {
      id: string;
      kind: 'compaction';
      /** 1-based within the session, so the card can name itself. */
      index: number;
      trigger: CompactionUiTrigger;
      mode: CompactionMode;
      applied: boolean;
      reason?: string;
      messagesBefore: number;
      messagesAfter: number;
      tokensBefore: number;
      tokensAfter: number;
      summary?: string;
      model: string;
      durationMs?: number;
      /**
       * When the live card opened, so the elapsed counter has an origin
       * (context-auto-compaction-hardening §3.6 / W5).
       *
       * JSON-SERIALIZABLE like every other field here, and harmless on reload:
       * `session/persist.ts` normalizes `live` to false, and a settled card
       * renders `durationMs` rather than an elapsed figure.
       */
      startedAt?: number;
      /** Set when tail relief clipped the retained turns (W2). */
      tailRelief?: { messages: number; charsRemoved: number };
      live: boolean;
    }

  | {
      id: string;
      kind: 'service';
      /** `s1`, `s2`, ... — the id the model quotes back. */
      serviceId: string;
      command: string;
      status: ServiceStatus;
      url?: string;
      port?: number;
      exitCode: number | null;
      startedAt: number;
      readyAt?: number;
      endedAt?: number;
      rows: readonly string[];
      /**
       * MONOTONIC row cursor — the revision term, NEVER `rows.length` (P0-3).
       *
       * The tail is a FIXED-SIZE RING: it evicts its oldest row while appending
       * a new one, so the joined length is unchanged while the content is not.
       * That is verbatim the non-append mutation the `tool` branch's `liveSeq`
       * comment was written for, and a length term would go on matching while
       * the card changed underneath it.
       */
      rowsSeen: number;
      /** The one-row entry a terminal transition appends (D-11). */
      terminal?: boolean;
      /** The stop reported the pid still alive afterwards (R-2 / P2-6). */
      killIncomplete?: boolean;
    };

export interface UsageTotal {
  inputTokens: number;
  outputTokens: number;
  /**
   * Cache read hits (context-usage-gauge-accuracy §3.6 / P1-3).
   *
   * `occupiedTokens` counts them and `computeCost` PRICES them, so a session
   * total that omits them makes the status bar's `^` read lower than the `$`
   * next to it - on the same row, from the same turns. That was three units on
   * one line, and this field plus its sibling are what collapse them to one.
   */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/**
 * The ephemeral retry projection held in `ViewState.retry` (§9).
 *
 * Only the two IN-FLIGHT phases exist here: once a card settles the projection is
 * `null`, because the settled card IS the history and a chip that reported a
 * finished retry would never go away.
 */
export interface RetrySnapshot {
  attempt: number;
  maxRetries: number;
  resumeAt?: number;
  phase: 'waiting' | 'retrying';
  errorType: string;
}

export interface ViewState {
  entries: Entry[];
  status: 'idle' | 'running';
  usageTotal: UsageTotal;
  /**
   * Context occupancy, as published by `AgentController`'s `ContextMeter`.
   *
   * ITS ONLY WRITER IS `case 'contextUsage'` (I-1), and that is the structural
   * half of the P0-1 fix. It replaced `contextTokens` + `contextTokensEstimated`,
   * which between them had THREE writing branches (`turnEnd`,
   * `contextTokensEstimated`, `resetConversation`) fed by two competing
   * upstreams. Two writers in one synchronous fan-out means the later one wins,
   * and the later one was the stale `snapshot` carrying the PRE-compaction
   * figure - so the bar fell and bounced straight back, every time, with nothing
   * logging a fault. `context-one-writer.test.ts` scans this file to keep it
   * that way.
   */
  context: ContextUsageSnapshot;
  overlay: Overlay;
  thinkingVisible: boolean;
  /** Ephemeral acks; auto-dismissed by App (spec §3.9). */
  toasts: Toast[];
  /** Which tool cards are expanded to their full stored preview (spec §3.7). */
  expandedToolIds: Record<string, true>;
  /**
   * MIRROR of the controller's effective mode, for rendering only (plan-mode
   * §3.1). Written exclusively from what `controller.setAgentMode()` reports it
   * adopted — never from what the UI asked for.
   */
  agentMode: AgentMode;
  /** Set only by a DEFERRED `plan -> build`; drives the `PLAN -> BUILD` readout. */
  pendingAgentMode: AgentMode | null;
  /**
   * The live team roster, or `null` when no dispatch is running.
   *
   * NEVER PERSISTED. `/save` writes `entries`, and the settled `team` entry is
   * the history; this field is the ephemeral panel, and a resumed session has no
   * live dispatch to show (§6.4).
   */
  team: TeamSnapshot | null;
  /**
   * The live todo list, or `null` when there is none.
   *
   * NEVER PERSISTED HERE — `entries` is the history and `SavedSession.todos` is
   * the list (§3.13). `null` is what leaves the rail unmounted entirely, which
   * is why a session that never plans has byte-identical layout to a pre-feature
   * build (AC-24).
   */
  todos: TodoSnapshot | null;
  /**
   * The live retry projection, or `null` when nothing is retrying.
   *
   * NEVER PERSISTED — `entries` is the history and the settled card is the
   * record. It drives the status-bar chip and the 1 Hz tick, and it is nulled on
   * every settle path. Same contract as `team`.
   */
  retry: RetrySnapshot | null;
  /**
   * The live fast-tier projection, or `null` when the tier is off for this
   * session (fast-model-tier §5.2).
   *
   * NEVER PERSISTED — `entries` is the history and the settled cards are the
   * record. It drives the status chip and `/fast status`'s totals. `null` is
   * what leaves an ordinary session's status bar byte-identical (AC-4).
   */
  fast: FastSnapshot | null;
  /**
   * The live compaction projection, or `null` when the feature is off for this
   * session (context-auto-compaction §5.5).
   *
   * NEVER PERSISTED — `entries` is the history and the settled cards are the
   * record. It drives the status chip, the gauge's marks and `/compact status`'s
   * totals. `null` is what leaves an ordinary session's status bar unchanged.
   */
  compaction: CompactionSnapshot | null;
  /*
   * `contextTokensEstimated` IS GONE. "Part of this number is a guess" now
   * travels ON the reading itself - `context.source` and `context.deltaTokens` -
   * so it cannot get out of step with the figure it describes, which a separate
   * boolean written by a different branch could and did.
   */

  // Internal bookkeeping (not rendered directly).
  seq: number;
  /** The `kind: 'team'` entry the live dispatch is writing into. */
  teamEntryId?: string;
  /** The `kind: 'todo'` entry this turn is writing into. */
  todoEntryId?: string;
  /** The `kind: 'retry'` entry this turn is writing into. */
  retryEntryId?: string;
  /** The `kind: 'fast'` entry the in-flight review is writing into. */
  fastEntryId?: string;
  /** The `kind: 'compaction'` entry the in-flight compaction is writing into. */
  compactionEntryId?: string;
  streamingId?: string;
  turnProduced: boolean;
  errorNoticed: boolean;
  /** The current run was aborted by the user (suppresses the failure guard). */
  aborted: boolean;
  /**
   * Entries removed by `transcriptRetain` (tui-render-performance L1).
   *
   * Rendered by `transcript-text` and reported by `/perf`; NEVER PERSISTED —
   * `SavedSession` keeps `{ model, messages, entries, todos }` exactly as it is,
   * so `/save` and `/resume` need no format change and old files load unchanged.
   */
  droppedEntries: number;
}

/**
 * The zero session total.
 *
 * ONE LITERAL FOR TWO SITES (`initialViewState` and `resetConversation`). They
 * used to spell the object out twice, which is how `cacheReadTokens` would have
 * been added to one of them and not the other.
 */
const EMPTY_USAGE_TOTAL: UsageTotal = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

export interface ViewStateSeed {
  /** Start with thinking blocks expanded. Defaults to FALSE, the product default. */
  thinkingVisible?: boolean;
}

/**
 * The initial view state, optionally seeded from config.
 *
 * THE DEFAULT IS `false`, NOT `true`, AND THAT IS THE WHOLE SAFETY ARGUMENT
 * (D-2). There is exactly one production call site — `App`'s `useReducer`, which
 * passes `cfg.showThinking`. Every other caller is a test. A future call site
 * that forgets the seed fails CLOSED, toward the product default, rather than
 * silently restoring the reasoning firehose for one code path with nothing
 * reporting it.
 *
 * The seed is a PARAMETER rather than a post-mount dispatch so that `/resume`
 * cannot flash a restored thinking block on frame 1.
 */
export function initialViewState(seed: ViewStateSeed = {}): ViewState {
  return {
    entries: [],
    status: 'idle',
    usageTotal: EMPTY_USAGE_TOTAL,
    context: emptyContextUsage(),
    overlay: null,
    thinkingVisible: seed.thinkingVisible ?? false,
    toasts: [],
    expandedToolIds: {},
    // Seeded to the default posture; the App overrides it once on mount from
    // `controller.getAgentMode()` so `--plan` renders on the first frame.
    agentMode: 'build',
    pendingAgentMode: null,
    team: null,
    todos: null,
    retry: null,
    fast: null,
    compaction: null,
    seq: 0,
    teamEntryId: undefined,
    todoEntryId: undefined,
    retryEntryId: undefined,
    fastEntryId: undefined,
    compactionEntryId: undefined,
    streamingId: undefined,
    turnProduced: false,
    errorNoticed: false,
    aborted: false,
    droppedEntries: 0,
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
      /** A fully-built, immutable diff, so the reducer stays pure (§3.3.7). */
      patch?: FilePatch;
    }
  /**
   * A running tool's live tail (agent-activity-presentation-live §3.3.1).
   *
   * `rows` IS THE WHOLE TAIL, not an increment: the store replaces it on every
   * chunk, which is what lets `mergeDeltas` keep only the last action per
   * `toolCallId` (D-30). `at` is read in `App`'s listener rather than here, so
   * this reducer stays pure.
   */
  | { type: 'toolOutputDelta'; toolCallId: string; rows: readonly string[]; at: number }
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
  | { type: 'restoreEntries'; entries: Entry[] }
  | { type: 'setAgentMode'; mode: AgentMode; pending: AgentMode | null }
  | { type: 'teamStart'; dispatchId: string; requested: number; specs: SubagentSpec[] }
  | { type: 'teamUpdate'; snapshot: TeamSnapshot }
  | { type: 'teamUsage'; usage: TokenUsage; costDelta: number }
  | { type: 'teamEnd'; outcome: DispatchOutcome }
  | { type: 'todoUpdate'; snapshot: TodoSnapshot }
  | { type: 'todoCleared' }
  // --- API retry (llm-api-retry-backoff §6.4) ---------------------------
  | {
      type: 'retryScheduled';
      attempt: number;
      maxRetries: number;
      delayMs: number;
      resumeAt: number;
      errorType: string;
      message: string;
    }
  | { type: 'retryAttempt'; attempt: number; maxRetries: number }
  | { type: 'streamRestart'; discardedToolCallIds: string[] }
  /**
   * The 1 Hz countdown tick. NO STATE OF ITS OWN — it bumps `seq` so the frame
   * re-renders and the card recomputes `resumeAt - Date.now()`. `App` runs the
   * interval ONLY while `state.retry?.phase === 'waiting'`, so an idle session has
   * no timer at all.
   */
  | { type: 'retryTick' }
  // --- Fast model tier (fast-model-tier §5.3) ---------------------------
  | { type: 'fastStart'; index: number; turn: number; model: string }
  | { type: 'fastEnd'; review: FastReview }
  /**
   * Review spend.
   *
   * `costDelta` IS PRECOMPUTED BY THE CALLER, exactly as `teamUsage`'s is: the
   * reducer stays pure and cost-table-free, which is the property that makes it
   * testable — and the fast tier has a DIFFERENT cost table from the lead, so a
   * reducer that computed its own would have to know about both (§3.6 / R-7).
   */
  | { type: 'fastUsage'; usage: TokenUsage; costDelta: number }
  | { type: 'fastTier'; snapshot: FastSnapshot }
  // --- Context compaction (context-auto-compaction §5.5) -----------------
  //
  // ALL FIVE ARE DISPATCHED FROM EXACTLY ONE PLACE — `App.tsx`'s
  // `subscribeCompaction` effect over the CLI-LOCAL stream (D-20 / P1-6).
  // `reduceEvent` deliberately gains NO cases for core's `compaction_start` /
  // `compaction_end`; its `default: return []` is already correct for them.
  // One compaction arriving through two channels would be two transcript cards
  // and a doubled `tokensReclaimed`, with nothing naming the authority.
  | { type: 'compactionStart'; index: number; trigger: CompactionUiTrigger; model: string }
  | { type: 'compactionEnd'; record: CompactionRecord }
  /**
   * Compaction spend.
   *
   * `costDelta` IS PRECOMPUTED BY THE CALLER, exactly as `teamUsage`'s and
   * `fastUsage`'s are: the reducer stays pure and cost-table-free. It matters
   * MORE here than for either of those, because the summarizer may be a
   * different model from the lead AND from the fast tier, so a reducer that
   * computed its own would have to know about three price tables.
   */
  | { type: 'compactionUsage'; usage: TokenUsage; costDelta: number }
  | { type: 'compactionSnapshot'; snapshot: CompactionSnapshot }
  /**
   * The occupancy reading, from `AgentController.subscribeContextUsage`.
   *
   * THE ONLY ACTION THAT WRITES `state.context`, AND IT IS DISPATCHED FROM
   * EXACTLY ONE PLACE (I-1 / T11). It replaced `contextTokensEstimated`, which
   * `App` fired from two branches of the compaction stream while `turnEnd` wrote
   * the same field from the agent stream - three writers, two upstreams, one
   * number, and the P0-1 bounce as the result.
   */
  | { type: 'contextUsage'; snapshot: ContextUsageSnapshot }
  // --- Background services (background-service-supervision §3.10) ---------
  //
  // ALL THREE ARE DISPATCHED FROM EXACTLY ONE PLACE — `App.tsx`'s
  // `subscribeProc` effect over the CLI-LOCAL stream. `reduceEvent` deliberately
  // gains NO cases: `ProcEvent` is not a member of core's `AgentEvent` union, and
  // one service arriving through two channels would be two cards.
  | { type: 'serviceStart'; service: ServiceSnapshot }
  | { type: 'serviceUpdate'; service: ServiceSnapshot }

  | { type: 'serviceEnd'; service: ServiceSnapshot };

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

/** The first line of a stored preview, without its trailing newline. */
function firstLine(text: string): string {
  const at = text.indexOf('\n');
  return at === -1 ? text : text.slice(0, at);
}

/**
 * Where a `FilePatch` is collected from on `tool_execution_end`.
 *
 * Supplying one makes `reduceEvent` CONSUME-ONCE rather than pure, which is safe
 * because `App.tsx` calls it exactly once per event and `mergeDeltas` only ever
 * merges `textDelta` / `thinkingDelta`, never `toolExecEnd`.
 */
export interface PatchSource {
  take(toolCallId: string): FilePatch | undefined;
}

/**
 * Map one core `AgentEvent` to view actions. `cost` (the active model's cost
 * table) lets `turn_end` accumulate USD cost; omit it in tests that only assert
 * token totals. `patches` is the CLI-local diff side channel (§3.3.7); omitting
 * it — every existing test, and headless mode — produces byte-identical actions.
 */
export function reduceEvent(
  event: AgentEvent,
  cost?: ModelCost,
  patches?: PatchSource,
): ViewAction[] {
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
    case 'tool_execution_end': {
      const patch = patches?.take(event.toolCallId);
      const preview = buildToolPreview(event.result);
      return [
        {
          type: 'toolExecEnd',
          toolCallId: event.toolCallId,
          isError: event.isError,
          duration: event.duration,
          // AN ENTRY CARRIES A PATCH OR A FULL PREVIEW, NEVER BOTH (D-19). This
          // is not a budget compromise, it is deleting a duplicate: `ToolCard`
          // renders `DiffView` INSTEAD of `ToolPreview` when a patch exists, so
          // the stored preview is never drawn on that card — and for `edit_file`
          // it is literally the same diff, as text. Keeping the first line
          // preserves the one thing outside `DiffView` that still reads it,
          // `entryRevision`'s `preview?.length` term.
          preview: patch ? firstLine(preview) : preview,
          ...(patch ? { patch } : {}),
        },
      ];
    }
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

/**
 * Tools that render their own transcript entry, so the generic tool card would
 * be a duplicate. EXACTLY ONE MEMBER; read todo-plan-execution §3.8 before
 * adding a second.
 *
 * SUPPRESSING ONLY `tool_call_start` IS SUFFICIENT, AND THAT IS THE WHOLE REASON
 * THIS IS SAFE (D-10). Every later handler — `toolCallDelta` / `toolCallEnd` /
 * `toolExecStart` / `toolExecEnd` — resolves its target through
 * `findToolEntryId`, which returns `undefined` when no entry was created, and
 * every one of them already early-returns on that. There is no fifth handler. A
 * second suppression rule would be four more places to get the id matching
 * wrong, for nothing.
 */
const SELF_RENDERING_TOOLS: ReadonlySet<string> = new Set(['todo_write']);

function reduceStreamEvent(se: StreamEvent): ViewAction[] {
  switch (se.type) {
    case 'thinking_start':
      return [{ type: 'thinkingStart' }];
    case 'thinking_delta':
      return [{ type: 'thinkingDelta', delta: se.delta }];
    case 'text_delta':
      return [{ type: 'textDelta', delta: se.delta }];
    case 'tool_call_start':
      if (SELF_RENDERING_TOOLS.has(se.toolName)) return [];
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
    // --- API retry (llm-api-retry-backoff §6.4) ---------------------------
    case 'retry_scheduled':
      return [
        {
          type: 'retryScheduled',
          attempt: se.attempt,
          maxRetries: se.maxRetries,
          delayMs: se.delayMs,
          resumeAt: se.resumeAt,
          errorType: se.errorType,
          message: se.message,
        },
      ];
    case 'retry_attempt':
      return [{ type: 'retryAttempt', attempt: se.attempt, maxRetries: se.maxRetries }];
    case 'stream_restart':
      return [{ type: 'streamRestart', discardedToolCallIds: se.discardedToolCallIds }];
    default:
      return [];
  }
}

/**
 * The opening words of the `context_overflow` banner.
 *
 * A SHARED CONSTANT RATHER THAN TWO LITERALS, because `compactionStart` matches
 * on it to rewrite the notice a successful reactive recovery would otherwise
 * leave behind (P1-4). Two spellings that must agree, with nothing checking that
 * they do, is how that rewrite silently stops matching — at which point the red
 * "start over" banner comes back and only on the recovery path, which is the one
 * place nobody re-tests.
 */
export const CONTEXT_OVERFLOW_NOTICE_PREFIX = 'Context length exceeded';

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
      // `/compact` IS NAMED FIRST, and adding it is the second half of P1-4's
      // fix. This remedy list predates context compaction and was, until it
      // existed, complete: throwing the conversation away really was the only
      // exit. It is not any more, and a banner that offers only `/reset` now
      // tells the user to discard a session the very next line of code may be
      // about to save.
      return `${CONTEXT_OVERFLOW_NOTICE_PREFIX} - try /compact, or start over with /reset. (${base})`;
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

/**
 * Seal `thinkingMs`, once, as a spreadable patch (§3.1.2).
 *
 * Returns an EMPTY object when there is nothing to seal — no reasoning happened,
 * or the clock has already stopped — so the three call sites can spread it
 * unconditionally and none of them can re-seal a settled duration.
 */
function sealThinkingMs(
  entry: Extract<Entry, { kind: 'assistant' }>,
): { thinkingMs?: number } {
  if (entry.thinkingStartedAt === undefined || entry.thinkingMs !== undefined) return {};
  return { thinkingMs: Math.max(0, Date.now() - entry.thinkingStartedAt) };
}

/**
 * Append one entry and ring-trim the result (tui-render-performance L1).
 *
 * TRIMMING HAPPENS ONLY AT APPEND POINTS, and that is the whole reason this is a
 * helper rather than a line in `viewReducer`. A mid-turn trim triggered by an
 * UPDATE action could drop the entry `streamingId` / `teamEntryId` /
 * `todoEntryId` points at while it is still being written to; appending is the
 * only moment at which the tail is by definition the newest thing.
 *
 * I-L1-1 — the trim must never drop a live target. With `retain >= 200` and a
 * trim that only ever removes from the head this is structurally true, but a
 * future clamp change would break it SILENTLY (the `mapEntry` calls would simply
 * stop matching), so development builds assert it.
 */
function appendEntry(
  state: ViewState,
  entries: Entry[],
  entry: Entry,
): { entries: Entry[]; droppedEntries: number } {
  const trimmed = trimEntries([...entries, entry], entryRetain());
  if (trimmed.dropped > 0 && process.env.NODE_ENV !== 'production') {
    // `retryEntryId` IS PART OF THIS LIST. A fourth live card that is not in it is
    // a fourth card I-L1-1 does not cover — the trim would silently turn its
    // `mapEntry` into a no-op instead of failing loudly.
    const live = [
      state.streamingId,
      state.teamEntryId,
      state.todoEntryId,
      state.retryEntryId,
      // `fastEntryId` IS PART OF THIS LIST for the reason the note above gives:
      // a fifth live card left out of it is a card I-L1-1 does not cover.
      state.fastEntryId,
      // And `compactionEntryId` is the sixth. Same reason, and it is the one
      // whose absence would be hardest to notice: a compaction card is rare, so
      // a `mapEntry` that silently stopped matching would be found by a user
      // rather than by a test.
      state.compactionEntryId,
    ].filter((id): id is string => typeof id === 'string');
    for (const id of live) {
      if (!trimmed.entries.some((e) => e.id === id)) {
        throw new Error(`trimEntries dropped a live entry (${id}) - see I-L1-1`);
      }
    }
  }
  return {
    entries: trimmed.entries,
    droppedEntries: state.droppedEntries + trimmed.dropped,
  };
}

/**
 * Settle the turn's retry card, if it has one (llm-api-retry-backoff §6.4).
 *
 * SETTLING IS DERIVED HERE, NOT SENT BY CORE. Core knows it scheduled a retry; it
 * does not know whether the turn eventually succeeded, was interrupted, or ran out
 * of budget — that is the consumer's own timeline.
 *
 * FOUR PATHS REACH THIS, and the fourth is what makes the set exhaustive rather
 * than enumerated: `turnEnd` (recovered), an error `notice` (exhausted),
 * `abortMark` (interrupted) and `runEnd` (interrupted). The rule is "every path
 * that reaches `status: 'idle'` settles the card", because a card left at
 * `phase: 'waiting'` pins `Transcript`'s MONOTONIC settled boundary and re-renders
 * the tail every frame for the rest of the session (R-10).
 *
 * Returning `retry: null` / `retryEntryId: undefined` unconditionally is
 * deliberate: both are already that when there is no card, so every caller can
 * spread the result without a branch of its own.
 */
function settleRetryCard(
  state: ViewState,
  entries: Entry[],
  phase: Extract<RetryPhase, 'recovered' | 'exhausted' | 'interrupted'>,
): { entries: Entry[]; retry: null; retryEntryId: undefined } {
  if (!state.retryEntryId) return { entries, retry: null, retryEntryId: undefined };
  const now = Date.now();
  return {
    entries: mapEntry(entries, state.retryEntryId, (e) =>
      e.kind === 'retry'
        ? {
            ...e,
            phase,
            totalRetries: e.attempt,
            elapsedMs: Math.max(0, now - e.startedAt),
            resumeAt: undefined,
          }
        : e,
    ),
    retry: null,
    retryEntryId: undefined,
  };
}

function releaseLiveTails(entries: Entry[]): Entry[] {
  let touched = false;
  const next = entries.map((e) => {
    if (e.kind !== 'tool' || !e.live) return e;
    if (e.status !== 'running' && e.status !== 'pending') return e;
    touched = true;
    return { ...e, live: undefined, lastOutputAt: undefined, liveSeq: (e.liveSeq ?? 0) + 1 };
  });
  return touched ? next : entries;
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
        ...appendEntry(state, state.entries, entry),
        streamingId: undefined,
        // A new turn gets its own card, in that turn's position in the
        // transcript. The PREVIOUS card stays exactly where it is — it is
        // history, and history is not retracted.
        todoEntryId: undefined,
        // Same rule for the retry card. `runStart` clears NONE of the three (it
        // never has), and `runEnd`'s settle rule below is what makes that safe
        // rather than merely lucky.
        retryEntryId: undefined,
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
      return { ...state, seq, ...appendEntry(state, state.entries, entry), streamingId: id };
    }

    case 'thinkingStart': {
      if (!state.streamingId) return state;
      return {
        ...state,
        entries: mapEntry(state.entries, state.streamingId, (e) =>
          e.kind === 'assistant'
            ? {
                ...e,
                thinking: e.thinking ?? '',
                thinkingOpen: true,
                // `Date.now()` in the reducer is not a new impurity class: the
                // retry card's `startedAt` already reads the clock here.
                thinkingStartedAt: e.thinkingStartedAt ?? Date.now(),
              }
            : e,
        ),
      };
    }

    case 'thinkingDelta': {
      if (!state.streamingId) return state;
      return {
        ...state,
        entries: mapEntry(state.entries, state.streamingId, (e) =>
          e.kind === 'assistant'
            ? { ...e, thinking: appendBounded(e.thinking ?? '', action.delta, ENTRY_LIMITS.thinking) }
            : e,
        ),
      };
    }

    case 'textDelta': {
      if (!state.streamingId) return state;
      return {
        ...state,
        entries: mapEntry(state.entries, state.streamingId, (e) =>
          e.kind === 'assistant'
            ? {
                ...e,
                text: appendBounded(e.text, action.delta, ENTRY_LIMITS.text),
                // FIRST TEXT DELTA ONLY. Thinking is over the moment the answer
                // starts; re-sealing on every delta would make the number climb
                // with the answer's length.
                ...sealThinkingMs(e),
              }
            : e,
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
      return { ...state, seq, ...appendEntry(state, state.entries, entry) };
    }

    case 'toolCallDelta': {
      const id = findToolEntryId(state, action.toolCallId);
      if (!id) return state;
      return {
        ...state,
        entries: mapEntry(state.entries, id, (e) =>
          e.kind === 'tool'
            ? { ...e, argsRaw: appendBounded(e.argsRaw, action.argsDelta, ENTRY_LIMITS.argsRaw) }
            : e,
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

    /**
     * THE STATUS GUARD IS WHAT KEEPS A LATE CHUNK FROM RESURRECTING A SETTLED
     * CARD. The child's last write and its `close` event race, so a chunk can
     * legitimately arrive after `tool_execution_end`; without the guard it would
     * reattach a tail to a card whose authoritative preview is already drawn.
     */
    case 'toolOutputDelta': {
      const id = findToolEntryId(state, action.toolCallId);
      if (!id) return state;
      return {
        ...state,
        entries: mapEntry(state.entries, id, (e) =>
          e.kind === 'tool' && (e.status === 'running' || e.status === 'pending')
            ? {
                ...e,
                live: action.rows,
                liveSeq: (e.liveSeq ?? 0) + 1,
                lastOutputAt: action.at,
              }
            : e,
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
                ...(action.patch ? { patch: action.patch } : {}),
                // THE TAIL IS NEVER MERGED INTO `preview` (D-23): the
                // authoritative result already contains everything it held, in
                // full, and concatenating them would double the output and break
                // `bashBadge`'s last-line parse (`ToolPreview.tsx:35-54`).
                live: undefined,
                lastOutputAt: undefined,
              }
            : e,
        ),
      };
    }

    case 'turnEnd': {
      const entries = state.streamingId
        ? mapEntry(state.entries, state.streamingId, (e) =>
            e.kind === 'assistant'
              ? {
                  ...e,
                  streaming: false,
                  thinkingOpen: false,
                  usage: action.usage,
                  // The turn that thought and then called a tool without emitting
                  // any text never saw a `textDelta`, so this is where its clock
                  // is sealed.
                  ...sealThinkingMs(e),
                }
              : e,
          )
        : state.entries;
      return {
        ...state,
        streamingId: undefined,
        turnProduced: true,
        // `contextTokens` IS NOT WRITTEN HERE ANY MORE (I-1). The occupancy this
        // turn produced reaches the view through `ContextMeter`, which subscribes
        // to the same `turn_end` and publishes the measured pressure - window,
        // percentage and approximation markers included, none of which this
        // branch ever had. Two branches writing one number is what P0-1 was.
        usageTotal: addUsage(state.usageTotal, action.usage, action.costDelta),
        // The turn produced an answer, so whatever it had to retry, it recovered.
        ...settleRetryCard(state, entries, 'recovered'),
      };
    }

    case 'runEnd': {
      // Finalize any still-streaming entry.
      let entries = state.streamingId
        ? mapEntry(state.entries, state.streamingId, (e) =>
            e.kind === 'assistant' ? { ...e, streaming: false, ...sealThinkingMs(e) } : e,
          )
        : state.entries;
      let seq = state.seq;
      let droppedEntries = state.droppedEntries;

      // Silent-failure guard (R2): a swallowed throw shows nothing otherwise.
      // A user abort is an expected empty run, not a failure — skip the guard.
      if (!state.turnProduced && !state.errorNoticed && !state.aborted) {
        const next = nextId({ ...state, seq });
        seq = next.seq;
        const appended = appendEntry(state, entries, {
          id: next.id,
          kind: 'notice',
          level: 'error',
          text: GENERIC_RUN_FAILURE,
        });
        entries = appended.entries;
        droppedEntries = appended.droppedEntries;
      }

      // The card may now reach `<Static>` (C-5 / I-6): the turn that owns it is
      // over, so nothing will rewrite it.
      if (state.todoEntryId) {
        entries = mapEntry(entries, state.todoEntryId, (e) =>
          e.kind === 'todo' ? { ...e, live: false } : e,
        );
      }

      return {
        ...state,
        seq,
        droppedEntries,
        status: 'idle',
        streamingId: undefined,
        // THE TERMINAL BACKSTOP, and it is not redundant with `abortMark`
        // (llm-api-retry-backoff P1-8 / AC-25b). `abortMark` is dispatched only
        // from the Esc handler, but the ENGINE also aborts itself: the idle
        // watchdog calls `Agent.abort()` directly, the run unwinds, and the UI
        // sees `agent_end` -> `runEnd` with no `abortMark`, no `turn_end` and no
        // error notice. A card left at `phase: 'waiting'` then pins
        // `Transcript`'s monotonic boundary and re-renders the tail every frame
        // for the rest of the session. By the time this runs the three other
        // settle paths have already cleared `retryEntryId`, so this only fires on
        // a genuinely unsettled card.
        //
        // `releaseLiveTails` rides the same argument one entry kind over (D-35):
        // a tool card stranded at `running` by this very path would otherwise
        // keep a tail and a frozen stall clock for the rest of the session.
        ...settleRetryCard(state, releaseLiveTails(entries), 'interrupted'),
      };
    }

    case 'notice': {
      const { id, seq } = nextId(state);
      const entry: Entry = { id, kind: 'notice', level: action.level, text: action.text };
      const appended = appendEntry(state, state.entries, entry);
      // A terminal error notice is what an EXHAUSTED ladder looks like from here:
      // the retry wrapper forwards the provider's own error once it stops
      // retrying, and that error always precedes any `turn_end` because a failed
      // turn has none. A non-error notice leaves the card alone.
      const settled =
        action.level === 'error'
          ? settleRetryCard(state, appended.entries, 'exhausted')
          : { entries: appended.entries };
      return {
        ...state,
        seq,
        droppedEntries: appended.droppedEntries,
        errorNoticed: action.level === 'error' ? true : state.errorNoticed,
        ...settled,
      };
    }

    case 'abortMark': {
      // Mark the run aborted even when no assistant entry is streaming (e.g. an
      // abort during a tool call) so the runEnd failure guard stays suppressed.
      const marked = state.streamingId
        ? mapEntry(state.entries, state.streamingId, (e) =>
            e.kind === 'assistant' ? { ...e, streaming: false, aborted: true } : e,
          )
        : state.entries;
      return {
        ...state,
        aborted: true,
        // An abort during a tool call is the COMMON way a tail is stranded --
        // `Esc` while `npm test` runs -- so this is the clause manual row 9
        // exercises (D-35 / AC-40).
        ...settleRetryCard(state, releaseLiveTails(marked), 'interrupted'),
      };
    }

    // `teamEntryId` is dropped with the entries it pointed at. Keeping it would
    // leave `teamUpdate` mapping an id that no longer exists — harmless today,
    // and a dangling reference the next reader has to reason about.
    case 'clearTranscript':
      return {
        ...state,
        entries: [],
        // The count describes what the RETAIN RING removed from the visible
        // transcript. `/clear` empties it by intent, so carrying the number
        // over would make the exported transcript claim a loss that did not
        // happen.
        droppedEntries: 0,
        streamingId: undefined,
        expandedToolIds: {},
        teamEntryId: undefined,
        // The list goes with the screen it was on. `/clear` is an explicit user
        // instruction, which is I-2's standing exception (`TodoClearReason`
        // `'user'`, the same door `/todo clear` uses) — so the command clears the
        // STORE via `controller.clearTodos()` and this clears the MIRROR, exactly
        // the pairing `resetConversation` below has always had.
        //
        // The mirror write is same-valued with the store's own `todoCleared`
        // dispatch rather than redundant with it: it is what makes this action
        // stand on its own. `builtins.ts` is the only dispatcher of it TODAY, and
        // a second one — a real clear-screen key, a session-restore path — would
        // otherwise bring the bug back in identical form and in silence.
        //
        // The entry id is dropped because the entry it pointed at is gone.
        todos: null,
        todoEntryId: undefined,
        // Same reasoning for the retry card: the entry is gone, so the id must go
        // with it or `retryScheduled` would `mapEntry` an id that no longer
        // exists. `retry` goes too — unlike `todos` it is not a belief the model
        // holds, it is a projection of an entry that has just been erased.
        retryEntryId: undefined,
        retry: null,
        // Same reasoning again for the compaction card: the entry is gone, so the
        // id must go with it or `compactionEnd` would `mapEntry` an id that no
        // longer exists. `compaction` STAYS — unlike `retry` it is not a
        // projection of an entry, it is the live state of a subsystem that is
        // still running, and `/clear` clears the screen rather than the session.
        compactionEntryId: undefined,
      };

    case 'resetConversation':
      return {
        ...state,
        entries: [],
        droppedEntries: 0,
        streamingId: undefined,
        expandedToolIds: {},
        // `context` IS DELIBERATELY UNTOUCHED (I-1). `builtins.ts` calls
        // `controller.clearMessages()` BEFORE dispatching this, and that marks
        // the meter dirty and schedules a publication; zeroing here would make
        // the final state `0` rather than the meter's real answer - which for an
        // emptied conversation is the system prompt's own couple of percent, not
        // nothing. `usageTotal` DOES reset: that is session spend, not occupancy.
        usageTotal: EMPTY_USAGE_TOTAL,
        teamEntryId: undefined,
        // `/reset` clears `messages`, so the belief is gone and the list goes
        // with it — the other half of I-2. `controller.clearMessages()` clears
        // the STORE; this clears the mirror.
        todos: null,
        todoEntryId: undefined,
        retryEntryId: undefined,
        retry: null,
        compactionEntryId: undefined,
      };

    case 'setOverlay':
      return { ...state, overlay: action.overlay };

    // Pure mirror write. The App only ever dispatches what
    // `controller.setAgentMode()` reported it ADOPTED, so this reducer has no
    // deferral logic of its own to get out of step with (§3.1 / R-P7).
    case 'setAgentMode':
      return { ...state, agentMode: action.mode, pendingAgentMode: action.pending };

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

    // --- Team mode (team-subagents §5.3) ---------------------------------

    case 'teamStart': {
      const { id, seq } = nextId(state);
      const runs: SubagentRun[] = action.specs.map((spec) => ({
        label: spec.label,
        description: spec.description,
        // Already downgraded by the normalizer when the tier was unavailable, so
        // the card and the report agree from the first frame (fast-model-tier
        // §3.4).
        tier: spec.tier,
        phase: 'queued',
        turns: 0,
        toolCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        filesTouched: [],
        messagesSent: 0,
      }));
      const entry: Entry = {
        id,
        kind: 'team',
        dispatchId: action.dispatchId,
        requested: action.requested,
        runs,
        aborted: false,
        active: true,
      };
      return {
        ...state,
        seq,
        ...appendEntry(state, state.entries, entry),
        teamEntryId: id,
        team: {
          dispatchId: action.dispatchId,
          active: true,
          runs,
          requested: action.requested,
          startedAt: Date.now(),
          messageCount: 0,
        },
      };
    }

    case 'teamUpdate': {
      // One `mapEntry` on the KNOWN id, never a scan: this action arrives at up
      // to `maxConcurrent` x 8/s and a reverse search over a long transcript on
      // every one of them is exactly the cost the coalescer exists to avoid.
      const entries = state.teamEntryId
        ? mapEntry(state.entries, state.teamEntryId, (e) =>
            e.kind === 'team' ? { ...e, runs: action.snapshot.runs } : e,
          )
        : state.entries;
      return { ...state, entries, team: action.snapshot };
    }

    case 'teamUsage':
      // `usageTotal` AND NOTHING ELSE (§3.9 / AC-15). In particular NOT
      // `context`: that gauge shows the LEAD's context occupancy against
      // the model's window, and folding five children into it would read 180%
      // on a perfectly healthy session. Child spend is real money and has to
      // appear in the cost readout; it is not the lead's context.
      return { ...state, usageTotal: addUsage(state.usageTotal, action.usage, action.costDelta) };

    case 'teamEnd': {
      const { outcome } = action;
      const entries = state.teamEntryId
        ? mapEntry(state.entries, state.teamEntryId, (e) =>
            e.kind === 'team'
              ? {
                  ...e,
                  runs: outcome.runs,
                  aborted: outcome.aborted,
                  durationMs: Math.max(0, outcome.endedAt - outcome.startedAt),
                  active: false,
                }
              : e,
          )
        : state.entries;
      // `team: null` is what makes the panel disappear — the requirement's
      // "(dang you de shi hou)": it renders only while a dispatch is running.
      return { ...state, entries, team: null, teamEntryId: undefined };
    }

    // --- Todo planning (todo-plan-execution §5.2) -------------------------

    case 'todoUpdate': {
      // TYPED AS THE TODO MEMBER, NOT AS `Entry`. The rewrite below spreads this
      // and overrides `live: boolean`; while the return type was the whole union
      // that spread also produced a TOOL entry carrying `live: boolean`, which
      // stopped type-checking the moment the tool member gained its own `live`
      // (agent-activity-presentation-live). Narrowing here is what keeps the
      // override honest rather than accidentally legal.
      const entry = (id: string): Extract<Entry, { kind: 'todo' }> => ({
        id,
        kind: 'todo',
        items: action.snapshot.items,
        doneCount: action.snapshot.doneCount,
        total: action.snapshot.total,
        live: true,
      });

      // Rewrite the turn's card when there is one; otherwise append and record
      // its id. One `mapEntry` on the KNOWN id, never a scan.
      if (state.todoEntryId) {
        const known = state.todoEntryId;
        return {
          ...state,
          todos: action.snapshot,
          entries: mapEntry(state.entries, known, (e) =>
            e.kind === 'todo' ? { ...entry(known), live: e.live } : e,
          ),
        };
      }

      const { id, seq } = nextId(state);
      return {
        ...state,
        seq,
        todos: action.snapshot,
        ...appendEntry(state, state.entries, entry(id)),
        todoEntryId: id,
      };
    }

    // THE ENTRY STAYS. It is history, and history is not retracted — only the
    // live projection goes away, which is what unmounts the rail.
    case 'todoCleared':
      return { ...state, todos: null, todoEntryId: undefined };

    // --- Fast model tier (fast-model-tier §5.4) ---------------------------

    case 'fastStart': {
      const { id, seq } = nextId(state);
      const entry: Entry = {
        id,
        kind: 'fast',
        reviewIndex: action.index,
        model: action.model,
        status: 'running',
        turn: action.turn,
        live: true,
      };
      return {
        ...state,
        seq,
        ...appendEntry(state, state.entries, entry),
        fastEntryId: id,
      };
    }

    case 'fastEnd': {
      const { review } = action;
      const settle = (e: Entry): Entry =>
        e.kind === 'fast'
          ? {
              ...e,
              status: review.kind,
              ...(review.text !== undefined ? { text: review.text } : {}),
              ...(review.detail !== undefined ? { detail: review.detail } : {}),
              durationMs: review.durationMs,
              // SETTLED. `Transcript`'s boundary is monotonic, so a card that
              // never settles is re-rendered on every frame for the rest of the
              // session (C-5).
              live: false,
            }
          : e;

      // Rewrite the card this review opened when there is one; otherwise append
      // a settled card. THE SECOND BRANCH IS NOT DEFENSIVE PADDING: a review
      // that is dropped as `stranded` is emitted from `agent_end` and never had
      // a `review_start`, and a run restored from `/resume` has no live id at
      // all — "it did nothing" must never be the observable outcome (R-8).
      if (state.fastEntryId) {
        return {
          ...state,
          entries: mapEntry(state.entries, state.fastEntryId, settle),
          fastEntryId: undefined,
        };
      }
      const { id, seq } = nextId(state);
      const entry: Entry = {
        id,
        kind: 'fast',
        reviewIndex: review.index,
        model: review.model,
        status: review.kind,
        ...(review.text !== undefined ? { text: review.text } : {}),
        ...(review.detail !== undefined ? { detail: review.detail } : {}),
        turn: review.turn,
        durationMs: review.durationMs,
        live: false,
      };
      return { ...state, seq, ...appendEntry(state, state.entries, entry) };
    }

    case 'fastUsage':
      // `usageTotal` AND NOTHING ELSE, exactly as `teamUsage` (§3.6 / AC-18). In
      // particular NOT `context`: that gauge shows the LEAD's context
      // occupancy against the lead model's window, and a review is a separate
      // conversation with a different model entirely.
      return { ...state, usageTotal: addUsage(state.usageTotal, action.usage, action.costDelta) };

    case 'fastTier':
      return { ...state, fast: action.snapshot };

    // --- Context compaction (context-auto-compaction §5.5) ----------------

    // NOT A TOTAL FUNCTION OVER COMPACTION ATTEMPTS (quiet-noop §3.1). A
    // `pressure` compaction that declines before calling a model or changing the
    // history dispatches NOTHING - no `compactionStart`, no `compactionEnd`, no
    // entry - exactly as a checkpoint below the threshold dispatches nothing.
    // Counting cards here counts compactions that RAN, never checkpoints that
    // fired; `/compact status` and the diagnostic log are where the attempts are.
    case 'compactionStart': {
      const { id, seq } = nextId(state);
      let entries = state.entries;

      // RESPONSIBILITY 1 — SEAL ANY LIVE `streamingId` ENTRY, defensively.
      // C-8's failure mode, and reachable here: `provider.ts` records that
      // Anthropic can deliver an error IN-STREAM, after the connection is open
      // and therefore after text deltas have already been emitted. An entry that
      // never settles pins `Transcript`'s monotonic boundary and re-renders the
      // tail forever.
      if (state.streamingId) {
        entries = mapEntry(entries, state.streamingId, (e) =>
          e.kind === 'assistant' ? { ...e, streaming: false, ...sealThinkingMs(e) } : e,
        );
      }

      // RESPONSIBILITY 2 — REWRITE A TRAILING `context_overflow` ERROR NOTICE
      // (P1-4). `agent-loop.ts` emits `message_update` for EVERY stream event
      // before the `error` branch throws, and `reduceStreamEvent`'s `case 'error'`
      // turns that into a `level: 'error'` notice reading "Context length
      // exceeded". So the HAPPY PATH of the reactive recovery would otherwise end
      // with a red banner telling the user to throw away the session we are one
      // frame from saving.
      //
      // IT REWRITES RATHER THAN REMOVES, because `<Static>` cannot un-print an
      // entry it has already drawn — and it matches ONLY when that notice is the
      // TAIL entry, so it can never touch an older, genuine error. If the
      // recovery then fails, the ladder's own notice or the re-thrown 400 is what
      // the user is left with, so neither direction lies.
      if (action.trigger === 'overflow') {
        const tail = entries[entries.length - 1];
        if (
          tail &&
          tail.kind === 'notice' &&
          tail.level === 'error' &&
          tail.text.startsWith(CONTEXT_OVERFLOW_NOTICE_PREFIX)
        ) {
          entries = mapEntry(entries, tail.id, (e) =>
            e.kind === 'notice'
              ? { ...e, level: 'info', text: 'Context window exceeded - compacting and retrying.' }
              : e,
          );
        }
      }

      const entry: Entry = {
        id,
        kind: 'compaction',
        index: action.index,
        trigger: action.trigger,
        mode: 'none',
        applied: false,
        messagesBefore: 0,
        messagesAfter: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        model: action.model,
        startedAt: Date.now(),
        live: true,
      };
      return {
        ...state,
        seq,
        ...appendEntry(state, entries, entry),
        compactionEntryId: id,
        streamingId: undefined,
      };
    }

    case 'compactionEnd': {
      const { record } = action;
      const settle = (e: Entry): Entry =>
        e.kind === 'compaction'
          ? {
              ...e,
              index: record.index,
              trigger: record.trigger,
              mode: record.mode,
              applied: record.applied,
              ...(record.reason !== undefined ? { reason: record.reason } : {}),
              messagesBefore: record.messagesBefore,
              messagesAfter: record.messagesAfter,
              tokensBefore: record.tokensBefore,
              tokensAfter: record.tokensAfter,
              ...(record.summary !== undefined ? { summary: record.summary } : {}),
              ...(record.tailRelief ? { tailRelief: record.tailRelief } : {}),
              model: record.model,
              durationMs: record.durationMs,
              // SETTLED. `Transcript`'s boundary is monotonic, so a card that
              // never settles is re-rendered on every frame for the rest of the
              // session (C-8).
              live: false,
            }
          : e;

      // THE SECOND BRANCH IS NOT DEFENSIVE PADDING, exactly as `fastEnd`'s is
      // not: the IDLE `/compact` path settles a record for a card this session
      // may never have opened, and "it did nothing" must never be the observable
      // outcome (R-8 / §6.4).
      if (state.compactionEntryId) {
        return {
          ...state,
          entries: mapEntry(state.entries, state.compactionEntryId, settle),
          compactionEntryId: undefined,
        };
      }
      const { id, seq } = nextId(state);
      const entry: Entry = {
        id,
        kind: 'compaction',
        index: record.index,
        trigger: record.trigger,
        mode: record.mode,
        applied: record.applied,
        ...(record.reason !== undefined ? { reason: record.reason } : {}),
        messagesBefore: record.messagesBefore,
        messagesAfter: record.messagesAfter,
        tokensBefore: record.tokensBefore,
        tokensAfter: record.tokensAfter,
        ...(record.summary !== undefined ? { summary: record.summary } : {}),
        ...(record.tailRelief ? { tailRelief: record.tailRelief } : {}),
        model: record.model,
        durationMs: record.durationMs,
        live: false,
      };
      return { ...state, seq, ...appendEntry(state, state.entries, entry) };
    }

    case 'compactionUsage':
      // `usageTotal` AND NOTHING ELSE, exactly as `teamUsage` and `fastUsage`. In
      // particular NOT `context`: that gauge shows the LEAD's context
      // occupancy against the lead model's window, and a summarization is a
      // separate conversation with a possibly different model entirely.
      return { ...state, usageTotal: addUsage(state.usageTotal, action.usage, action.costDelta) };

    case 'compactionSnapshot':
      return { ...state, compaction: action.snapshot };

    /**
     * THE ONE WRITER OF `state.context` (I-1).
     *
     * THE IDENTITY SHORT-CIRCUIT BELOW IS LOAD-BEARING, NOT A MICRO-OPTIMISATION
     * (§5.2 / R-3). The meter publishes on a 400 ms tick throughout a turn and
     * most of those ticks measure the same number - the history did not change
     * between two tool calls of the same size, or the percentage rounded to the
     * same integer. Returning the SAME state object lets React skip the whole
     * subtree; returning a fresh one would make a permanently visible row into a
     * 2.5 Hz re-render source and walk the render governor up its ladder for no
     * visible change at all.
     *
     * `ContextUsageSnapshot` carries no timestamp for exactly this reason: a
     * field that moves every tick would make this comparison never hold.
     */
    case 'contextUsage': {
      const prev = state.context;
      const next = action.snapshot;
      if (
        prev.occupied === next.occupied &&
        prev.window === next.window &&
        prev.pct === next.pct &&
        prev.source === next.source &&
        prev.deltaTokens === next.deltaTokens &&
        prev.windowKnown === next.windowKnown &&
        prev.windowOverridden === next.windowOverridden
      ) {
        return state;
      }
      return { ...state, context: next };
    }

    // --- API retry (llm-api-retry-backoff §6.4) ---------------------------

    case 'retryScheduled': {
      const snapshot: RetrySnapshot = {
        attempt: action.attempt,
        maxRetries: action.maxRetries,
        resumeAt: action.resumeAt,
        phase: 'waiting',
        errorType: action.errorType,
      };

      // ONE CARD PER TURN, REWRITTEN IN PLACE. One `mapEntry` on the KNOWN id,
      // never a scan — the same discipline `todoUpdate` follows.
      if (state.retryEntryId) {
        const known = state.retryEntryId;
        return {
          ...state,
          retry: snapshot,
          entries: mapEntry(state.entries, known, (e) =>
            e.kind === 'retry'
              ? {
                  ...e,
                  attempt: action.attempt,
                  maxRetries: action.maxRetries,
                  errorType: action.errorType,
                  message: action.message,
                  delayMs: action.delayMs,
                  resumeAt: action.resumeAt,
                  phase: 'waiting',
                }
              : e,
          ),
        };
      }

      const { id, seq } = nextId(state);
      const entry: Entry = {
        id,
        kind: 'retry',
        attempt: action.attempt,
        maxRetries: action.maxRetries,
        errorType: action.errorType,
        message: action.message,
        delayMs: action.delayMs,
        resumeAt: action.resumeAt,
        phase: 'waiting',
        // The clock the settled card's `elapsedMs` is measured from: the FIRST
        // retry of the turn, not the last.
        startedAt: Date.now(),
      };
      return {
        ...state,
        seq,
        retry: snapshot,
        ...appendEntry(state, state.entries, entry),
        retryEntryId: id,
      };
    }

    case 'retryAttempt': {
      if (!state.retryEntryId) return state;
      const known = state.retryEntryId;
      return {
        ...state,
        // `resumeAt` is CLEARED: the wait is over, so a countdown would tick
        // downward past zero while the request is already in flight.
        retry: state.retry ? { ...state.retry, phase: 'retrying', resumeAt: undefined } : null,
        entries: mapEntry(state.entries, known, (e) =>
          e.kind === 'retry' ? { ...e, phase: 'retrying', resumeAt: undefined } : e,
        ),
      };
    }

    case 'streamRestart': {
      const discarded = new Set(action.discardedToolCallIds);
      const entries = state.entries.filter(
        (e) => !(e.kind === 'tool' && discarded.has(e.toolCallId)),
      );
      return {
        ...state,
        entries: state.streamingId
          ? mapEntry(entries, state.streamingId, (e) =>
              e.kind === 'assistant'
                ? {
                    ...e,
                    text: '',
                    thinking: undefined,
                    thinkingOpen: false,
                    // A restarted stream re-thinks from scratch. Carrying the old
                    // clock forward would report a duration for reasoning that
                    // was discarded.
                    thinkingStartedAt: undefined,
                    thinkingMs: undefined,
                  }
                : e,
            )
          : entries,
      };
    }

    /**
     * The 1 Hz countdown tick. NO VALUE CHANGES — the card is refreshed by
     * IDENTITY so that React re-renders exactly one entry.
     *
     * A FLAT NONCE ON `ViewState` WOULD NOT WORK, and this is the trap worth
     * naming: `EntryView` is `React.memo`'d with an explicit comparator whose
     * first clause is `a.entry === b.entry`, so a state field the card does not
     * receive as a prop changes nothing at all — the countdown would freeze at
     * whatever second it was first drawn on, and the transcript would keep
     * re-rendering around it for no benefit. Rewriting the entry is what breaks
     * that boundary, and `EntryView` reads the clock for this kind only.
     *
     * `entryRevision` is deliberately NOT extended: the card is one row in every
     * phase, so the cached height stays correct and no re-measure is wanted.
     *
     * Returning `state` unchanged when nothing is waiting is what keeps a stray
     * tick from costing a render at all.
     */
    case 'retryTick': {
      if (state.retry?.phase !== 'waiting' || !state.retryEntryId) return state;
      const known = state.retryEntryId;
      return {
        ...state,
        entries: mapEntry(state.entries, known, (e) => (e.kind === 'retry' ? { ...e } : e)),
      };
    }

    case 'restoreEntries': {
      // Adopt a seq beyond any restored id to keep future ids unique.
      const maxSeq = action.entries.reduce((acc, e) => {
        const n = Number.parseInt(e.id.replace(/^e/, ''), 10);
        return Number.isFinite(n) ? Math.max(acc, n) : acc;
      }, state.seq);
      // A session file can be longer than the retain ring; trimming it here is
      // the one append-free place the bound still has to hold, and the count
      // starts from this restore rather than inheriting the previous session's.
      const restored = trimEntries([...action.entries], entryRetain());
      return {
        ...state,
        entries: restored.entries,
        droppedEntries: restored.dropped,
        seq: maxSeq,
        teamEntryId: undefined,
        // As for `team`: the restored cards are history and no turn owns them.
        // The LIST itself arrives separately, through `controller.restoreTodos`
        // and the store's own event (§3.13).
        todoEntryId: undefined,
        // Same for the retry card. `normalizeLoadedEntries` has already forced any
        // in-flight phase to `interrupted`, so nothing restored is live.
        retryEntryId: undefined,
        retry: null,
        // Same again for the fast card: `normalizeLoadedEntries` has already
        // forced `live: false`, so nothing restored is live. `state.fast` is
        // NOT cleared — it is the session's own tier projection, which a
        // `/resume` does not change.
        fastEntryId: undefined,
      };
    }

    // --- Background services (§3.10 / D-11) -----------------------------

    case 'serviceStart': {
      const { id, seq } = nextId(state);
      const entry: Entry = { id, ...serviceFields(action.service) };
      const appended = appendEntry(state, state.entries, entry);
      return {
        ...state,
        seq,
        entries: appended.entries,
        droppedEntries: appended.droppedEntries,
      };
    }

    case 'serviceUpdate': {
      const target = findServiceEntryId(state, action.service.id);
      if (!target) return state;
      return {
        ...state,
        entries: mapEntry(state.entries, target, (e) =>
          e.kind === 'service' ? { ...e, ...serviceFields(action.service) } : e,
        ),
      };
    }

    case 'serviceEnd': {
      const target = findServiceEntryId(state, action.service.id);
      const settled = target
        ? mapEntry(state.entries, target, (e) =>
            e.kind === 'service' ? { ...e, ...serviceFields(action.service) } : e,
          )
        : state.entries;
      const { id, seq } = nextId(state);
      const appended = appendEntry(state, settled, {
        id,
        ...serviceFields(action.service),
        terminal: true,
      });
      return {
        ...state,
        seq,
        entries: appended.entries,
        droppedEntries: appended.droppedEntries,
      };
    }

    default:
      return state;
  }
}

/**
 * Project a supervisor snapshot onto the entry's own fields.
 *
 * ONE PROJECTION FOR ALL THREE ACTIONS, so a field that reaches the card through
 * `serviceStart` can never fail to reach it through `serviceUpdate` — the kind of
 * asymmetry that produces a card frozen at its first values with nothing
 * reporting it.
 */
function serviceFields(service: ServiceSnapshot): Omit<Extract<Entry, { kind: 'service' }>, 'id'> {
  return {
    kind: 'service',
    serviceId: service.id,
    command: service.command,
    status: service.status,
    ...(service.url !== undefined ? { url: service.url } : {}),
    ...(service.port !== undefined ? { port: service.port } : {}),
    exitCode: service.exitCode,
    startedAt: service.startedAt,
    ...(service.readyAt !== undefined ? { readyAt: service.readyAt } : {}),
    ...(service.endedAt !== undefined ? { endedAt: service.endedAt } : {}),
    rows: service.rows,
    rowsSeen: service.rowsSeen,
    ...(service.killIncomplete ? { killIncomplete: true } : {}),
  };
}

/** The LIVE card for a service id, newest first; terminal records are skipped. */
function findServiceEntryId(state: ViewState, serviceId: string): string | undefined {
  for (let i = state.entries.length - 1; i >= 0; i -= 1) {
    const e = state.entries[i];
    if (e && e.kind === 'service' && e.serviceId === serviceId && !e.terminal) return e.id;
  }
  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
