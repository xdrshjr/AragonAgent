/**
 * Runtime shapes for team mode (team-subagents §5.1 / §5.2).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope.
 *
 * `TeamEvent` is a CLI-LOCAL stream and must stay that way (D-10 / I-5).
 * `packages/core` freezes its runtime export list (`public-api.test.ts`) and
 * forbids host coupling (`no-host-coupling.test.ts`); adding a member to core's
 * `AgentEvent` union would break the first and teach core about a host shape
 * (`SubagentRun`) it has no business defining. The whole feature therefore
 * changes ZERO files under `packages/core/` (AC-12).
 */

import type { TokenUsage } from '@aragon-agent/core';
import type { ActivityArgs } from './activity.js';

/** One normalized delegation request. Produced only by `normalizeSubagentSpecs`. */
export interface SubagentSpec {
  /** Slug, unique within the dispatch. Shown in the panel, the report and logs. */
  label: string;
  /** <= TEAM_LIMITS.descriptionChars. What this subagent is for. */
  description: string;
  /** <= TEAM_LIMITS.promptChars. Self-contained: the child sees no history. */
  prompt: string;
  /**
   * Force the plan-mode gate on for this child regardless of session mode.
   * TIGHTENING ONLY (D-13): there is no field anywhere that gives a child more
   * permission than the session it was spawned from.
   */
  readOnly: boolean;
}

export type SubagentPhase =
  | 'queued'
  | 'starting'
  | 'thinking'
  | 'tool'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'aborted';

/** Live, mutable record of one child. Projected into the UI and the report. */
export interface SubagentRun {
  label: string;
  description: string;
  phase: SubagentPhase;
  startedAt?: number;
  endedAt?: number;
  turns: number;
  toolCalls: number;
  lastTool?: string;
  usage: TokenUsage;
  /**
   * Paths seen going through `write_file` / `edit_file`, deduped and capped at
   * `TEAM_LIMITS.filesTouchedMax`.
   *
   * BEST-EFFORT BY CONSTRUCTION: a child that writes through `bash` is invisible
   * here. The conflict warning in the report says "review before trusting
   * either" rather than claiming completeness, and that wording is load-bearing
   * (R-2).
   */
  filesTouched: string[];
  messagesSent: number;
  /** The child's final assistant text. The only thing the lead sees of its work. */
  summary?: string;
  error?: string;
  /** Hit `team.maxTurnsPerSubagent` and was stopped mid-work. */
  truncated?: boolean;
  /**
   * Compactions this child performed on its OWN history
   * (context-auto-compaction-hardening §3.4.4 / W3).
   *
   * OPTIONAL, so every existing construction site and fixture compiles
   * unchanged. Absent and `0` mean the same thing to every reader.
   */
  compactions?: number;

  /**
   * Prose the child is writing right now, sanitized and clamped to
   * `TEAM_LIMITS.activityChars`. Set only between tool calls; cleared on
   * `turn_start`, on `tool_execution_start` and on `tool_execution_end` so it
   * can never describe work the child has already finished.
   *
   * THE CLAMP HERE IS A STORAGE CEILING, NOT A COLUMN WIDTH (P0-1). The panel
   * re-clamps to `activityBudget(cols)` at render. Do not "simplify" by clamping
   * to the display budget here: this value has no terminal.
   *
   * NEVER LOGGED and never persisted: it is ephemeral by construction and a
   * resumed session has no live dispatch.
   */
  activity?: string;

  /**
   * The five argument fields any of the nine known tools might want to show,
   * picked at capture time by `pickActivityArgs` and elided to
   * `TEAM_LIMITS.activityArgChars` each.
   *
   * A PICKED SUBSET, NOT `event.args` (P1-4). The run is shallow-copied into the
   * live snapshot and into every `agent_update` event by `publish()`, and again
   * into `DispatchOutcome.runs` by `dispatch()`, which `TeamCard` holds in the
   * transcript for the session. Holding `event.args` would mean holding
   * `write_file`'s `content` - a whole file, unbounded - along all of those
   * paths, and would put a file body one `JSON.stringify` from a log.
   *
   * Stored unformatted because the PANEL owns the wide/narrow decision and it is
   * the only object that knows the terminal width. A formatted string here would
   * bake one terminal's width into a value the report and the headless writer
   * also read.
   *
   * Cleared on `turn_start` and `tool_execution_end` (P1-5).
   */
  activityArgs?: ActivityArgs;

  /** `team_wait` calls refused as unanswerable (F-3). Pulled from the bus on
   *  `tool_execution_end`, the same way `messagesSent` is. */
  blockedWaits?: number;

  /** Cold-start retries spent (F-4). 0 or absent for the overwhelming majority
   *  of runs; `1` at most under `TEAM_LIMITS.maxColdStartRetries`. */
  retries?: number;

  /**
   * Whether the error that ended this attempt was transport-level and
   * retryable, read structurally off `LLMError.retryable`.
   *
   * NOT RENDERED ANYWHERE. It exists so `TeamRuntime` can decide without
   * re-parsing `run.error`, which is a human-facing sentence produced by
   * `formatStreamError` and must never become a machine-readable contract.
   */
  retryable?: boolean;

  /**
   * The child's LIVE API-retry state (llm-api-retry-backoff §6.10), or absent when
   * it is not in a backoff.
   *
   * THIS EXISTS BECAUSE A CHILD'S RETRY IS OTHERWISE INVISIBLE (R-14). Subagents
   * inherit the lead's retry policy for free — `TeamRuntime` reuses the lead's
   * registry instance — but a child's `retry_scheduled` goes to that CHILD's own
   * `Agent` listeners and never reaches the lead's `ViewState`. Without this field
   * a subagent spending three minutes in backoff shows no card, no chip and no
   * countdown: the dispatch simply appears hung, which is the single worst reading
   * of a mechanism whose whole claim is that waiting is now legible.
   *
   * The fix uses the channel that already exists rather than inventing a second
   * card: `TeamCard` and `transcript-text` already render one row per child, and
   * this rides on it. `ViewState.retry` stays LEAD-ONLY, and the lead's status-bar
   * chip is deliberately NOT driven by children — `agents 3/5` already reports the
   * dispatch, and a second aggregate would put two numbers on the bar that
   * disagree about what "3" means.
   *
   * EPHEMERAL, exactly like `activity` and `activityArgs`: cleared on the child's
   * next `turn_end` or terminal error, never persisted, and a settled team entry
   * keeps only what the run finally did.
   *
   * NO `resumeAt`, DELIBERATELY, and this is the one place §6.10's sketch is not
   * followed. A countdown needs something to re-render it, and nothing does: the
   * team row is drawn from `agent_update`, a child in backoff emits exactly ONE
   * event for the whole wait, and the lead's 1 Hz `retryTick` is gated on the
   * LEAD's own `state.retry`. A `7s` that never changed for thirty seconds is a
   * worse readout than no number at all — it reads as a hung countdown, which is
   * precisely the impression this row exists to remove. The counter alone is
   * honest and is what AC-34 asserts.
   */
  retry?: { attempt: number; maxRetries: number };

  /**
   * Supervisor inspections this child received (team-overseer). Optional so
   * every existing fixture compiles; absent and `0` read the same.
   */
  interventions?: number;
  /**
   * Supervisor-driven rebuilds this child went through (team-overseer). The
   * run object survives a rebuild with the same label, so this is where the
   * report reads "this row is the Nth body of the same brief".
   */
  replacements?: number;

  /**
   * The most recent supervisor decision applied to this child
   * (subagent-overseer-v2 section 6). TRANSIENT, never persisted - the
   * same rule as `activity` / `activityArgs`; a resumed session has no
   * live dispatch.
   *
   * `at` is ABSOLUTE epoch ms, the same units as `startedAt` / `endedAt`
   * (R-P2-3), so the panel renders `nudged 2m` with one subtraction and
   * no second clock convention. `reasonHead` <= 60 chars, for the UI
   * badge line only.
   */
  lastIntervention?: {
    action: OverseerAction;
    at: number;
    reasonHead: string;
  };
}

// ---------------------------------------------------------------------------
// The dispatch supervisor (team-overseer)
// ---------------------------------------------------------------------------

/** What the supervisor may do with one inspected child. */
export type OverseerAction = 'wait' | 'nudge' | 'replace' | 'abandon';

/**
 * One supervisor decision, already normalized and clamped.
 *
 * Produced ONLY by `normalizeOverseerDecision` (repair, never reject): an
 * unparseable or out-of-budget model answer becomes `wait` with the default
 * interval, because supervision must not kill a healthy child.
 */
export interface OverseerDecision {
  action: OverseerAction;
  /** <= TEAM_LIMITS.overseerReasonChars. Why, for the report and the log. */
  reason: string;
  /** `nudge` only: <= TEAM_LIMITS.overseerGuidanceChars. Steered into the child. */
  guidance?: string;
  /** Model-chosen next check, clamped to the structural range. */
  nextCheckMs?: number;
}

/** One supervisor intervention, as recorded on the outcome and rendered. */
export interface OverseerIntervention {
  label: string;
  at: number;
  action: OverseerAction;
  reason: string;
  /**
   * What the trigger was: event stall, wall-clock check, post-mortem, or
   * the supervisor going QUIET (subagent-overseer-v2 D-10) - the look
   * budget ran out and supervision stopped waking this child. A VALUE OF
   * THE UNION, never a reason prefix: a human-readable sentence is not a
   * machine contract (the `run.error` rule).
   */
  trigger: 'silence' | 'clock' | 'postmortem' | 'quiet';
}

/**
 * A terminal supervisor decision handed to the WORKER LOOP, which is the only
 * place a child's `prompt()` is awaited and therefore the only place a
 * lifecycle change can be applied without orphaning the replacement (I-OV1).
 *
 * Set by `TeamRuntime` on the handle, then `handle.abort()`; consumed and
 * left in place (never cleared) by `runOne` after the await resolves.
 */
export interface OverseerVerdict {
  action: 'replace' | 'abandon';
  reason: string;
  guidance?: string;
}

/** One message on the team bus. */
export interface TeamMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  at: number;
}

/** Everything one dispatch produced. The sole input to `buildDispatchReport`. */
export interface DispatchOutcome {
  dispatchId: string;
  runs: SubagentRun[];
  /** Specs the model asked for, BEFORE the cap — the "n of m requested" line. */
  requested: number;
  startedAt: number;
  endedAt: number;
  aborted: boolean;
  /** Messages addressed to `lead`; surfaced in their own report section. */
  leadMail: TeamMessage[];
  /**
   * Every supervisor decision that was applied (team-overseer), in order.
   * Bounded by the per-child inspection budget; rendered as the report's
   * Overseer section so the lead can see WHO was nudged or replaced and why.
   */
  interventions?: OverseerIntervention[];
  /**
   * Summed across all children. Real spend; it must reach the status bar
   * (§3.9). Every child runs the LEAD's model (main-agent parity), so one
   * total priced at the lead's table is the honest accounting.
   */
  usage: TokenUsage;
  /**
   * The supervisor's own fast-tier spend for this dispatch
   * (subagent-overseer-v2 D-7). Absent when nothing supervised the
   * dispatch; read straight off the provider at dispatch end so there is
   * exactly one accounting of it.
   */
  overseerUsage?: TokenUsage;
  /** Inspection calls made, including ones that failed softly. */
  overseerCalls?: number;
  /**
   * EDGE-LATCHED, once per dispatch (D-10): the fast tier was missing at
   * least one cadence tick and the children waited UNASSISTED - announced,
   * never killed. The per-child wait events of a degraded tick
   * deliberately do NOT enter `interventions`; this flag plus the tick
   * count below are the report's aggregate note.
   */
  overseerDegraded?: boolean;
  /** How many cadence ticks ran unassisted (the aggregate note's number). */
  overseerDegradedTicks?: number;
}

/**
 * What the UI renders: a cheap immutable projection, rebuilt per event.
 *
 * Held in `ViewState.team` and NEVER persisted — a resumed session has no live
 * dispatch, and pretending otherwise is what P1-5 is about.
 */
export interface TeamSnapshot {
  dispatchId: string;
  active: boolean;
  runs: SubagentRun[];
  requested: number;
  startedAt: number;
  messageCount: number;
  lastMessage?: TeamMessage;
}

/**
 * The CLI-local event stream. `TeamRuntime` emits; `AgentController.subscribeTeam`
 * forwards; `App`, `runHeadless` and `attachTeamEvents` consume.
 */
export type TeamEvent =
  | { type: 'dispatch_start'; dispatchId: string; requested: number; specs: SubagentSpec[] }
  | { type: 'agent_update'; dispatchId: string; run: SubagentRun }
  | { type: 'usage'; dispatchId: string; label: string; usage: TokenUsage }
  | { type: 'message'; dispatchId: string; message: TeamMessage }
  | {
      type: 'overseer';
      dispatchId: string;
      label: string;
      decision: OverseerDecision;
      trigger: OverseerIntervention['trigger'];
    }
  | { type: 'dispatch_end'; dispatchId: string; outcome: DispatchOutcome };

export type TeamEventListener = (event: TeamEvent) => void;
