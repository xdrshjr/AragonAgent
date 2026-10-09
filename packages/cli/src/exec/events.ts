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
  /**
   * Capabilities of THIS build that a caller has to know about before using
   * them. Optional so older consumers are unaffected, and additive so
   * `EXEC_SCHEMA_VERSION` does not move (see the file header).
   *
   * `'interrupt'` means the stdin `{"type":"interrupt"}` frame really does run
   * the full settle -> persist -> `result` sequence ON EVERY PLATFORM. Builds
   * before that fix routed it through a self-directed SIGINT, which on Windows
   * terminates the process outright with exit code 1 - no persistence, no
   * `result`. A wrapper cannot tell the two apart by observation, and guessing
   * wrong costs the user their conversation, so this build states it.
   */
  capabilities?: string[];
  /**
   * Absolute path of the session file THIS run reads and writes; `null` under
   * `--no-save-session` (web-use-durable-control-and-tier-accountability W2).
   *
   * Optional and additive, so `EXEC_SCHEMA_VERSION` does not move (file header).
   * Stamped by `buildInitEvent`, never set by a caller - the same discipline
   * `capabilities` follows.
   *
   * ## Why a wrapper cannot work this out for itself
   *
   * Deriving it host-side means re-implementing `getSessionsDir()`
   * (`envPaths('aragon-agent')` plus its environment override) in a second
   * codebase that has no way to notice when this one changes. The failure mode
   * of a drifted copy is a path that does not exist, which a wrapper reads as
   * "that conversation is gone" - identical, on screen, to the session really
   * being gone. The run that is writing the file is the only party that can say
   * where it is without guessing.
   *
   * It is the id THIS RUN writes back under, not the string the caller typed:
   * `--resume` accepts `<id|path>`, and `resumedSessionId()` decides what the
   * file is actually called. A wrapper asking "can I reattach later" needs the
   * latter.
   */
  sessionFile?: string | null;
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

/** One caller input and its complete automatic follow-through chain. */
export interface ExecTurnStateEvent {
  type: 'turn_state';
  sessionId: string;
  requestSeq: number;
  phase: 'started' | 'completed' | 'failed' | 'cancelled';
}

/** Semantic source progress; never includes model or tool content. */
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
 * What the fast tier is ACTUALLY doing, as opposed to what it was configured to
 * do (web-use-tier-cooperation-and-control-closure W2).
 *
 * ONE ADDITIVE EVENT TYPE, AND `EXEC_SCHEMA_VERSION` DOES NOT MOVE — the same
 * rule `ExecCompactionEvent` states. A consumer that ignores event types it does
 * not know is unaffected.
 *
 * THE PROBLEM IT SOLVES. `fast_review` only fires when a review produced TEXT,
 * so every other outcome — a review that failed, a tier that switched itself off
 * after three failures, a budget that ran out, a delegation that did or did not
 * happen — was invisible to a wrapper. The single most likely and least
 * self-diagnosable failure ("it runs but not one review card ever arrives") had
 * no signal at all on this stream.
 *
 * IT IS A STATE EVENT, NOT A LOG LINE. It fires on `tier_changed` and on every
 * `review_end`, which in a session with reviews is a handful per hundred turns.
 */
export interface ExecFastTierEvent {
  type: 'fast_tier';
  sessionId: string;
  /** Taken from the runner's own turn counter — `tier_changed` carries none. */
  turn: number;
  /** The tier resolved AND the live switch is on. */
  live: boolean;
  /**
   * The CLI switched the fast REVIEWS off by itself after three consecutive
   * non-transient failures.
   *
   * ORTHOGONAL TO `live` AND NOT DERIVABLE FROM IT: the self-disable leaves
   * `live` at `true`. A consumer reporting "the reviews stopped" MUST read this
   * field; `live === false && reviews > 0` is a predicate that can never be true.
   */
  selfDisabled: boolean;
  model: string;
  sameAsMain: boolean;
  reviews: number;
  reviewBudget: number;
  budgetReached: boolean;
  /** Fast-tier children dispatched — the only evidence delegation is working. */
  delegated: number;
  inFlight: boolean;
  /** Present only on the `review_end` branch. */
  review?: {
    index: number;
    kind: 'ok' | 'advice' | 'empty' | 'failed' | 'dropped';
    detail?: string;
    durationMs: number;
    injected: boolean;
  };
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
  decision?: {
    occupied: number;
    contextWindow: number;
    threshold: number;
    source: 'usage' | 'estimate';
    deltaTokens: number;
  };
  memoryVersion?: 2;
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
  /**
   * Absolute path of the session file this run reads and writes; `null` under
   * `--no-save-session`. See `ExecSystemInitEvent.sessionFile`.
   */
  sessionFile?: string | null;
}

/**
 * What this build announces in `system/init`.
 *
 * Stamped by `buildInitEvent`, never by a caller - the same discipline as
 * `schemaVersion`. A caller that could set it could claim a capability the
 * binary does not have, which is precisely the mistake the field exists to
 * prevent.
 */
/**
 * APPEND ONLY, NEVER REORDER. Consumers use `includes()`, but the next one may
 * not; inserting ahead of `'interrupt'` costs nothing and makes a diff look
 * bigger than it is.
 *
 *  · `'interrupt'`         — `{"type":"interrupt"}` on stdin settles the turn
 *                            without killing the process.
 *  · `'fast-policy'`       — this build understands `--fast-delegate` and
 *                            `--fast-review`. FOR AFTER-THE-FACT DISPLAY ONLY:
 *                            argv is fixed before `system/init` arrives, so it
 *                            cannot gate whether the flags are passed.
 *  · `'fast-tier-events'`  — this build emits `fast_tier`. Its ABSENCE is what
 *                            lets a wrapper say "this CLI does not report" and
 *                            not "the fast tier did nothing" — two very
 *                            different sentences to a user.
 *  · `'session-file'`      — `system/init` carries `sessionFile`, so a wrapper
 *                            can check on disk whether a stopped conversation
 *                            is still resumable instead of guessing the path.
 */
export const EXEC_CAPABILITIES: readonly string[] = [
  'interrupt',
  'fast-policy',
  'fast-tier-events',
  'session-file',
  'turn-lifecycle',
  'execution-progress',
];

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
    capabilities: [...EXEC_CAPABILITIES],
    // `?? null` rather than a conditional spread: the field's contract is
    // three-valued for a CONSUMER (`undefined` = an old build that cannot say,
    // `null` = this run saves nothing, a string = here it is), and omitting it
    // when a caller passed nothing would make this build indistinguishable from
    // one that predates the field.
    sessionFile: params.sessionFile ?? null,
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
