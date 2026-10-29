/**
 * Shared shapes for the governance subsystem (governance-mode sections 5, 8, 12, 14).
 *
 * ASCII ONLY (`governance/` is glyph-scanned). Pure types plus a handful of tiny
 * constants: no I/O, no React, no `node:*`.
 *
 * THE CONTRACT BETWEEN MODULES. `rules/` (ledger, settlement, rca, elimination),
 * `store/` (run store), `engine/` (planner, state machine, visibility, spec builder,
 * engine), `tools/` (what the model calls), `agent/governance-wiring.ts` and the UI all
 * import from here and nowhere else for shapes, so a field added here is seen by every
 * layer at compile time. `GovernanceEvent` is a CLI-LOCAL stream (D-19): it must never
 * be folded into core's `AgentEvent` (`public-api.test.ts` freezes that union).
 */

import type { TokenUsage } from '@aragon-agent/core';
import type { EventCode, Settlement } from './rules/events-table.js';
import type { ActivityArgs } from '../team/activity.js';
import type { SubagentPhase } from '../team/types.js';

export type { EventCode, Settlement } from './rules/events-table.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** All four powers. INSP is the fourth power and is never scored (I-G5). */
export type GovRole = 'DEV' | 'REV' | 'TEST' | 'INSP';
/** The three scored roles. */
export type ScoredRole = 'DEV' | 'REV' | 'TEST';

export type StageKind = 'dev' | 'review' | 'test' | 'settle' | 'integrate' | 'fix';
export const STAGE_KINDS: readonly StageKind[] = [
  'dev',
  'review',
  'test',
  'settle',
  'integrate',
  'fix',
] as const;

export type ProfileId = 'general' | 'ml' | 'product' | 'api-security';
export const PROFILE_IDS: readonly ProfileId[] = [
  'general',
  'ml',
  'product',
  'api-security',
] as const;

export type RunStatus = 'executing' | 'escalated' | 'paused' | 'closed' | 'abandoned';

export type WpStatus =
  | 'pending'
  | 'dev_running'
  | 'awaiting_review'
  | 'review_running'
  | 'awaiting_test'
  | 'test_running'
  | 'rework'
  | 'tested_ok'
  | 'integrated'
  | 'blocked'
  | 'dropped';

/** A tool-bound identity. The factories close over this; submissions never carry their own. */
export interface Identity {
  /** Roster id and subagent label: `dev1`, `rev2`, `tst1`, `insp`, `dev2-r1`. */
  id: string;
  role: GovRole;
  generation: number;
}

/** Every `gov_*` / `ledger_*` entry point returns plain text; the tool layer wraps it. */
export type ToolText = string;

// ---------------------------------------------------------------------------
// Run structure
// ---------------------------------------------------------------------------

export interface WorkPackage {
  id: string;
  title: string;
  goal: string;
  /** Owned files, INCLUDING the WP's test paths (RV-12). */
  files: string[];
  acceptance: string[];
  dependsOn: string[];
  /** 0-based phase index assigned by the planner. */
  phase: number;
  /** The DEV identity currently holding the WP; null until first dispatch. */
  assignee: string | null;
  /** REV / TEST identities assigned to the WP (sticky across rework, 5.2). */
  reviewer: string | null;
  tester: string | null;
  status: WpStatus;
  reworkCount: number;
  /** Finding fingerprints from rejected reviews (D8 detection, 5.6). */
  rejections: string[];
  appealUsed: boolean;
  /** Artifact ids per stage, oldest first. */
  submissions: Record<StageKind, string[]>;
  /** L3 `retry` grants consumed (<= GOV_LIMITS.maxReworkGrantsPerWp). */
  reworkGrants: number;
  acceptedWithIssues: boolean;
  blockedAt?: StageKind;
}

export interface Contract {
  id: string;
  name: string;
  producer: string;
  consumers: string[];
  definition: string;
  /** Set when the producer or all consumers were dropped (resolve.disposition=drop). */
  voided?: boolean;
}

export interface Claim {
  id: string;
  kind: 'missed_by_review' | 'security' | 'false_positive' | 'same_issue' | 'incomplete_impl';
  raisedBy: string;
  against: string;
  wpId: string;
  justification: string;
  status: 'open' | 'upheld' | 'rejected';
  rulingText?: string;
  /** Phase the claim belongs to (settle rules only on its own phase's claims). */
  phase: number;
}

export interface EscalationPosition {
  by: string;
  text: string;
}

export interface Escalation {
  id: string;
  level: 'L3';
  kind: 'wp_rework_cap' | 'integration_exhausted' | 'dispute';
  wpId?: string;
  phase?: number;
  topic: string;
  positions: EscalationPosition[];
  status: 'open' | 'resolved';
  ruling?: string;
}

export interface PhaseState {
  index: number;
  wpIds: string[];
  settled: boolean;
  integrated: boolean;
  integrationAttempts: number;
  fixCycles: number;
  /** resolve.disposition=retry on integration_exhausted (<= 1). */
  extraFixGrants: number;
  /** False when the user accepted a failing integration (disposition accept_failing). */
  integrationAccepted: boolean;
  /** True after the last integrate attempt failed and before a successful one. */
  lastIntegrationFailed: boolean;
}

export interface StageState {
  kind: StageKind;
  phase: number;
  wpIds: string[];
  startedAt: number;
  status: 'running' | 'done' | 'aborted' | 'interrupted';
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Prompt-cache tokens are real spend (`inputTokens` EXCLUDES them), so the team-token
   * budget counts them. Optional and written only when non-zero: an older checkpoint
   * without them reads as 0, and no schema bump is needed.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number | null;
}

/**
 * One run reduced to eight scalars for the `/gov runs` listing (governance-mode-v1-1 7.1).
 * Rides `index.jsonl`; built by `engine/run-digest.ts::buildRunDigest`.
 */
export interface RunDigest {
  /** 1-based phase being worked on (the last one once every phase is integrated). */
  phase: number;
  phaseCount: number;
  /** Scored agents that ever existed in this run, respawned ones included. */
  agents: number;
  /** Mean confirmed GT over the active scored agents; `null` before any agent exists. */
  health: number | null;
  /** Team tokens, input + output (the budget's unit). */
  tokens: number;
  /** `null` = pricing unknown. NEVER written as 0 on behalf of an unpriced run. */
  costUsd: number | null;
  /** `gov_dispatch` calls the engine accepted. */
  dispatches: number;
  eliminations: number;
}

export interface RunState {
  schemaVersion: number;
  runId: string;
  cwd: string;
  sessionId?: string;
  goal: string;
  profile: ProfileId;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  phases: PhaseState[];
  workPackages: Record<string, WorkPackage>;
  /** Stable WP order as given at `start`. */
  wpOrder: string[];
  contracts: Contract[];
  integrationCommands: string[];
  claims: Claim[];
  escalations: Escalation[];
  stage: StageState | null;
  usage: RunUsage;
  /** Dispatches issued (cap: GOV_LIMITS.hardMaxDispatches). */
  dispatches: number;
  /** Monotone event sequence; mirrors the last events.jsonl line. */
  seq: number;
  /** Plan snapshot adopted from PLAN+GOVERN, if any. */
  planSnapshot?: string;
  /** Limits resolved at start (policy keys frozen into the run for reproducibility). */
  limits: { maxRework: number; maxFixCycles: number; budgetTokens: number };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  seq: number;
  at: number;
  code: EventCode | 'RESPAWN' | 'ESCROW_RELEASE' | 'CLAWBACK';
  delta: number;
  settlement: Settlement | 'escrow_release' | 'clawback';
  phase: number;
  wpId?: string;
  incidentId?: string;
  by: 'engine' | `inspector:${string}`;
  reason: string;
  evidence?: string;
  /** Set when the single-incident cap clipped the delta. */
  capped?: { requested: number; applied: number };
  confirmedAfter: number;
  provisionalAfter: number;
}

export interface EscrowEntry {
  seq: number;
  at: number;
  phase: number;
  /** `held` when booked, `released` on confirm, `clawed_back` on clawback. */
  action: 'held' | 'released' | 'clawed_back';
  amount: number;
  code?: EventCode;
  reason: string;
}

export interface AgentRecord {
  id: string;
  role: ScoredRole;
  generation: number;
  /** KILL uses ONLY this; clamped to >= 0 (I-G3). */
  confirmed: number;
  /** Escrow; counted in the total, never in survival. */
  provisional: number;
  status: 'active' | 'eliminated';
  replacedBy: string | null;
  eliminatedReason?: 'depleted' | 'tail' | 'clawback';
  /** Consecutive phase ends spent as the lowest-ranked member under the tail threshold. */
  tailStrikes: number;
  history: LedgerEntry[];
  escrowHistory: EscrowEntry[];
}

export interface LedgerState {
  schemaVersion: number;
  /** Highest event seq folded into this state. */
  seq: number;
  agents: Record<string, AgentRecord>;
  /** Cumulative negative applied per `${agentId}|${incidentId}` (I-G4). */
  incidentNegatives: Record<string, number>;
  /** Failure analyses keyed by eliminated agent id, handed to the successor. */
  failureAnalyses: Record<string, FailureAnalysis>;
}

export interface FailureAnalysis {
  agentId: string;
  reason: 'depleted' | 'tail' | 'clawback';
  topPenalties: Array<{ code: EventCode; delta: number; reason: string }>;
  /** From a fixed code -> advice table; English, ASCII. */
  avoid: string[];
}

export type StandingLabel = 'NORMAL' | 'WARNING' | 'DANGER' | 'KILLED';

export interface StandingRow {
  id: string;
  role: ScoredRole;
  generation: number;
  confirmed: number;
  provisional: number;
  total: number;
  label: StandingLabel;
  status: 'active' | 'eliminated';
  replacedBy: string | null;
}

// ---------------------------------------------------------------------------
// Submissions (what gov_submit_* store; machine form)
// ---------------------------------------------------------------------------

export interface InterfaceContractCheck {
  interface: string;
  role: 'PRODUCER' | 'CONSUMER';
  verified: 'YES' | 'NOT_APPLICABLE';
  method: string;
  peer: string;
}

export interface WorkSubmission {
  kind: 'work';
  id: string;
  identity: string;
  wpId: string;
  phase: number;
  stage: 'dev' | 'fix';
  /** 1-based count of work submissions for this WP. */
  attempt: number;
  at: number;
  summary: string;
  filesChanged: string[];
  interfaceContracts: InterfaceContractCheck[];
  verification: { commands: Array<{ cmd: string; result: string; note?: string }> };
  appeal?: { findingIds: string[]; argument: string };
  escalate?: boolean;
}

export type ReviewVerdict = 'PASS' | 'PASS_WITH_FIXES' | 'NEEDS_REWORK';
export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'nit';

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  file: string;
  line?: number;
  issue: string;
  requiredChange: string;
  mustFix?: boolean;
}

export interface ReviewChecklistItem {
  status: 'pass' | 'fail' | 'na';
  evidence: string;
}

export interface ReviewSubmission {
  kind: 'review';
  id: string;
  identity: string;
  wpId: string;
  phase: number;
  attempt: number;
  at: number;
  verdict: ReviewVerdict;
  checklist: {
    correctness: ReviewChecklistItem;
    quality: ReviewChecklistItem;
    security: ReviewChecklistItem;
    integration: ReviewChecklistItem;
    compliance: ReviewChecklistItem;
  };
  findings: ReviewFinding[];
  fixesApplied: Array<{ file: string; rationale: string }>;
  integrationAssessment: string;
  appealResponses: Array<{ findingId: string; decision: 'uphold' | 'withdraw'; note?: string }>;
  excellence?: { claim: string; evidence: string };
  securityFinding?: { description: string; evidence: string };
  /** Derived by the engine from `findings`; the ONLY feedback surface a DEV sees (D-7). */
  requiredChanges: Array<{ file: string; issue: string; change: string }>;
}

export type TestVerdict = 'ALL_PASS' | 'ISSUES_FOUND' | 'SPEC_MISMATCH' | 'INCOMPLETE_IMPL';
export type TraceStatus = 'covered' | 'gap' | 'unverified';

export interface TestSubmission {
  kind: 'test';
  id: string;
  identity: string;
  wpId: string;
  phase: number;
  attempt: number;
  at: number;
  verdict: TestVerdict;
  traceability: Array<{ requirement: string; evidence: string; status: TraceStatus }>;
  commands: Array<{ cmd: string; exit: number; summary: string }>;
  issues: Array<{
    severity: FindingSeverity;
    description: string;
    missedByReview?: boolean;
    reviewMissJustification?: string;
  }>;
  boundaryTestsWritten: boolean;
  skeletonRatio?: number;
  skeletonEvidence?: string;
  claims: Array<{
    kind: Claim['kind'];
    justification: string;
    against?: string;
  }>;
}

export type Submission = WorkSubmission | ReviewSubmission | TestSubmission;

/** Inspector settle/integrate summary, persisted as an artifact for the report. */
export interface InspectorReport {
  kind: 'inspector';
  id: string;
  phase: number;
  stage: 'settle' | 'integrate';
  at: number;
  summary: string;
  contractChecks: Array<{
    contractId: string;
    status: 'ok' | 'mismatch' | 'unverifiable';
    note: string;
  }>;
  integration?: {
    result: 'pass' | 'fail' | 'not_run';
    commands: Array<{ cmd: string; exit: number; summary: string }>;
  };
  rca?: RcaInput;
  escalations: Array<{
    kind: Escalation['kind'];
    wpId?: string;
    topic: string;
    positions: EscalationPosition[];
  }>;
}

export interface RcaInput {
  failingChecks: Array<{ name: string; files: string[] }>;
  /** Cross-module? false => an individual bug, not an integration failure. */
  boundary: boolean;
  attributions: Array<{
    agentId: string;
    level: 'primary' | 'contributing' | 'oversight';
    contract: 'producer' | 'consumer_unverified' | 'none';
    miss?: 'review_integration' | 'test_defect' | 'test_boundary';
    note: string;
  }>;
  /** Cannot isolate to one agent => C4. */
  systemic: boolean;
}

// ---------------------------------------------------------------------------
// Persistence (events.jsonl is the truth; run.json / ledger.json are checkpoints)
// ---------------------------------------------------------------------------

export type StoredEventType =
  | 'run_started'
  | 'stage_started'
  | 'submission'
  | 'ledger'
  | 'claim'
  | 'ruling'
  | 'escrow'
  | 'eliminated'
  | 'respawned'
  | 'view_granted'
  | 'view_denied'
  | 'ownership_violation'
  | 'escalation'
  | 'resolution'
  | 'budget'
  | 'stage_ended'
  | 'run_paused'
  | 'run_resumed'
  | 'run_closed'
  | 'compacted';

export interface StoredEvent {
  seq: number;
  at: number;
  type: StoredEventType;
  actor: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The CLI-local event stream and the UI snapshot
// ---------------------------------------------------------------------------

export type GovAgentState =
  | 'queued'
  | 'working'
  | 'submitted'
  | 'idle'
  | 'failed'
  | 'eliminated';

export interface RosterRow {
  id: string;
  role: GovRole;
  generation: number;
  state: GovAgentState;
  wpId: string | null;
  /** Live activity text from the team stream (already sanitized); '' when none. */
  activity: string;
  /**
   * STRUCTURED LIVE ACTIVITY, for the friendly voice (persona names / tool phrases).
   * Optional, so an older snapshot or fixture reads as `undefined` and the renderer
   * falls back to `activity`. The legacy `activity` string is left byte-identical
   * because developer mode and old readers still print it.
   *
   * WHY NOT JUST RE-WORD `activity`: it is `run.activity ?? run.lastTool`, and in the
   * `thinking` phase (where `run.activity` is empty) it falls back to the PREVIOUS tool
   * id - a raw `read_file` the friendly voice must never print.
   */
  activityPhase?: SubagentPhase;
  /** The tool in flight; set only while `activityPhase === 'tool'`. */
  activityTool?: string;
  /** `pickActivityArgs` subset for that tool (already truncated); same condition. */
  activityArgs?: ActivityArgs;
  /** The prose the child is writing, WITHOUT any `lastTool` fallback. */
  activityText?: string;
  /** `run.toolCalls`: the variant seed, shared with the team row so surfaces agree. */
  activityCalls?: number;
  /** null for the inspector (not scored). */
  confirmed: number | null;
  provisional: number;
  label: StandingLabel | 'NOT_SCORED';
  /** Last delta and when it landed, for the 4 s emphasis window (10.3). */
  lastDelta: { delta: number; code: string; at: number; provisional: boolean } | null;
  replacedBy: string | null;
}

export type PipelineStepKey = 'intake' | StageKind;

export interface PipelineStep {
  key: PipelineStepKey;
  state: 'done' | 'active' | 'pending';
}

export interface LedgerTickerRow {
  at: number;
  agentId: string;
  code: string;
  delta: number;
  provisional: boolean;
  reason: string;
}

export interface GovernanceSnapshot {
  runId: string;
  goal: string;
  status: RunStatus;
  /** 1-based phase number for display. */
  phase: number;
  phaseCount: number;
  stage: StageKind | null;
  stageRunning: boolean;
  startedAt: number;
  pipeline: PipelineStep[];
  roster: RosterRow[];
  /** Mean `confirmed` over active scored agents; null before any agent exists. */
  health: number | null;
  recent: LedgerTickerRow[];
  usage: RunUsage;
  budgetTokens: number;
  alerts: string[];
  reworkNote: string | null;
  /**
   * A cooperative `/gov pause` is waiting for the running stage to finish
   * (governance-mode-v1-1 6.4). Optional so older fixtures read it as `false`.
   */
  pauseRequested?: boolean;
  /** Monotone; lets reducers drop stale snapshots. */
  rev: number;
}

export type GovernanceEvent =
  | { type: 'run_started'; snapshot: GovernanceSnapshot; card: GovernanceCardData | null }
  | { type: 'stage_started'; snapshot: GovernanceSnapshot }
  | { type: 'agent_state'; snapshot: GovernanceSnapshot }
  | { type: 'submission'; snapshot: GovernanceSnapshot; identity: string; wpId: string; kind: Submission['kind'] }
  | { type: 'ledger'; snapshot: GovernanceSnapshot }
  | { type: 'stage_ended'; snapshot: GovernanceSnapshot; card: GovernanceCardData | null }
  | { type: 'escrow'; snapshot: GovernanceSnapshot; phase: number; released: boolean }
  | { type: 'eliminated'; snapshot: GovernanceSnapshot; agentId: string; reason: FailureAnalysis['reason'] }
  | { type: 'respawned'; snapshot: GovernanceSnapshot; agentId: string; predecessor: string }
  | { type: 'escalation'; snapshot: GovernanceSnapshot; escalation: Escalation; card: GovernanceCardData }
  | { type: 'budget'; snapshot: GovernanceSnapshot; fraction: number }
  | { type: 'run_paused'; snapshot: GovernanceSnapshot; reason: string }
  | { type: 'run_resumed'; snapshot: GovernanceSnapshot }
  | { type: 'run_closed'; snapshot: GovernanceSnapshot; card: GovernanceCardData };

export type GovernanceEventListener = (event: GovernanceEvent) => void;

/**
 * Transcript card payload (`Entry.kind === 'governance'`). PURE DATA: no functions, no
 * Dates, no class instances - it is persisted with `entries` (10.4).
 */
export interface GovernanceCardRow {
  id: string;
  role: GovRole;
  confirmed: number | null;
  /** Compact per-row delta text, e.g. `+15P->C D1  +10 D12`. ASCII. */
  deltaText: string;
}

export interface GovernanceCardData {
  /** charter = run start; phase = settle+integrate; escalation; final = close. */
  variant: 'charter' | 'phase' | 'escalation' | 'final';
  runId: string;
  title: string;
  /** One line status under the title, e.g. `integration passed (attempt 1)`. */
  headline: string;
  tone: 'ok' | 'warn' | 'error' | 'info';
  rows: GovernanceCardRow[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Sub-agent spec extension (SubagentSpec.governance, optional)
// ---------------------------------------------------------------------------

export interface GovernanceSpecExt {
  role: GovRole;
  identity: string;
  runId: string;
  /** 1-based phase number. */
  phase: number;
  stage: StageKind;
  /** WP ids this child is responsible for (one for DEV/FIX, several for REV/TEST). */
  wpIds: string[];
  tokens: number;
  generation: number;
  predecessorAnalysis?: FailureAnalysis;
  profile: ProfileId;
  /**
   * The integration commands registered for the run. Carried on the INSPECTOR's spec only:
   * the host reads it to build that child's restricted `bash` (7.4).
   */
  integrationCommands?: string[];
}

// ---------------------------------------------------------------------------
// Engine inputs (tool arguments after normalization)
// ---------------------------------------------------------------------------

export interface WorkPackageInput {
  id: string;
  title: string;
  goal: string;
  files: string[];
  acceptance: string[];
  dependsOn?: string[];
}

export interface ContractInput {
  id: string;
  name: string;
  producer: string;
  consumers: string[];
  definition: string;
}

export interface StartInput {
  goal: string;
  spec: string;
  profile?: ProfileId;
  workPackages: WorkPackageInput[];
  contracts?: ContractInput[];
  integrationCommands?: string[];
}

export interface DispatchInput {
  stage: StageKind;
  wps?: string[];
  notes?: Record<string, string>;
}

export type ResolveDisposition = 'retry' | 'accept_as_is' | 'drop' | 'accept_failing';

export interface ResolveInput {
  escalationId: string;
  ruling: string;
  favor?: string;
  disposition?: ResolveDisposition;
}

// ---------------------------------------------------------------------------
// Engine facade (what tools / wiring call). The implementation is engine/engine.ts.
// ---------------------------------------------------------------------------

export interface GovernanceEngineApi {
  // orchestrator surface
  start(input: unknown, signal?: AbortSignal): Promise<ToolText>;
  status(): ToolText;
  resume(runId?: string): Promise<ToolText>;
  dispatchStage(input: unknown, signal?: AbortSignal): Promise<ToolText>;
  close(summary?: string): Promise<ToolText>;
  abandon(reason: string): Promise<ToolText>;
  resolve(input: unknown): Promise<ToolText>;
  // ui / wiring surface
  snapshot(): GovernanceSnapshot | null;
  isStageRunning(): boolean;
  abortStage(): void;
  subscribe(listener: GovernanceEventListener): () => void;
  dispose(): void;
  // child-tool entry points (identity-bound by the tool factories)
  submitWork(identity: Identity, input: unknown): ToolText;
  submitReview(identity: Identity, input: unknown): ToolText;
  submitTest(identity: Identity, input: unknown): ToolText;
  /**
   * A call the TOOL layer refused (schema error) never reaches `submit*`; this counts it toward
   * the same 3-strikes limit (spec 8.4) and returns `text` with the attempts-left tail.
   */
  rejectInvalid(identity: Identity, input: unknown, text: string): ToolText;
  inspectorApply(input: unknown): ToolText;
  inspectorRule(input: unknown): ToolText;
  inspectorSettle(input: unknown): ToolText;
  standings(): ToolText;
  readArtifact(identity: Identity, input: unknown): ToolText;
  requestView(identity: Identity, input: unknown): ToolText;
  scan(identity: Identity, input: unknown): ToolText | Promise<ToolText>;
}

/** Aggregated usage helper type, re-exported for the engine's budget module. */
export type { TokenUsage };
