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
import type { FastTierName } from '../fast/types.js';
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
  /**
   * Which model runs this child (fast-model-tier §3.4).
   *
   * THE WIRE NAME IS `model` AND THE INTERNAL NAME IS `tier`, on purpose: a
   * model expects to see `model:"fast"`, while `SubagentSpec.model` would read
   * as a model ID at every call site in this package.
   *
   * DELEGATION IS A MODEL CHOICE, NEVER A PERMISSION BOUNDARY (D-15 / I-4). A
   * fast child gets the same tools, the same `--confirm` gate, the same
   * plan-mode gate and the same skills ceiling as any other; only the model
   * differs. Restricting a fast child's tools would look like security, would
   * not be, and would make the report's `[fast]` rows mean two different things.
   */
  tier: FastTierName;
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
  /**
   * The tier this child actually ran on (fast-model-tier §3.4).
   *
   * WHAT RAN, NOT WHAT WAS ASKED FOR. A spec the normalizer downgraded arrives
   * here as `'main'`, which is what makes the report's `[fast]` annotation and
   * its second cost table agree with the bill.
   */
  tier: FastTierName;
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
   * Summed across MAIN-TIER children. Real spend; it must reach the status bar
   * (§3.9).
   *
   * THE MEANING NARROWED WHEN THE FAST TIER LANDED, and the split is not a
   * rounding concern: a Haiku child under a Sonnet lead priced at the lead's
   * table over-reports by roughly an order of magnitude, and the entire
   * justification for delegating is a number in this report (R-7).
   */
  usage: TokenUsage;
  /** Summed across FAST-TIER children. Absent when none ran, which is what
   *  keeps a pre-feature dispatch's report byte-identical. */
  fastUsage?: TokenUsage;
  /**
   * Specs that asked for `model:"fast"` and ran on `main` anyway (§3.4 / R-6).
   *
   * REPORTED, NEVER SILENT. A silent downgrade means the model asked for a cheap
   * child, got an expensive one, and has no way to learn that its cost model is
   * wrong.
   */
  downgraded?: number;
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
  // `tier` is what lets `App.tsx` pick the RIGHT cost table per event instead of
  // always calling `controller.getModelInfo().cost` (§3.6 / RV-4). The reducer
  // stays cost-table-free and receives a precomputed `costDelta`, which is the
  // property that makes it testable.
  | { type: 'usage'; dispatchId: string; label: string; usage: TokenUsage; tier: FastTierName }
  | { type: 'message'; dispatchId: string; message: TeamMessage }
  | { type: 'dispatch_end'; dispatchId: string; outcome: DispatchOutcome };

export type TeamEventListener = (event: TeamEvent) => void;
