/**
 * TeamRuntime — dispatch scheduling, budgets, the `TeamEvent` stream, abort and
 * disposal (team-subagents §3.2 / §3.5 / §3.8; team-overseer §3.4).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope.
 *
 * ALL CONCURRENCY LIVES INSIDE ONE TOOL EXECUTION (I-1 / D-1). The core agent
 * loop runs tool calls strictly sequentially, and that is not an accident to be
 * "fixed": plan mode's human-input bridge holds ONE outstanding request slot and
 * is correct only because tool calls never overlap (I-P11). So `task` takes a
 * BATCH and the fan-out is scheduled here, where it is ours to control. Anyone
 * tempted to make `agent-loop.ts` concurrent to "fix" parallel delegation is
 * about to silently mis-route a plan approval to a question wizard.
 *
 * The scheduler is a plain slot pool: an index cursor plus `maxConcurrent`
 * worker loops, awaited with `Promise.allSettled`. No worker abstraction, no
 * queue class, no event-loop trickery — every path is observable from the event
 * stream.
 *
 * THE DISPATCH SUPERVISOR (team-overseer) — a time ceiling is an inspection
 * trigger, not a death sentence. When a supervisor is live for the dispatch,
 * two SOFT timers per child (wall clock and event silence) fire an inspection;
 * the supervisor decides wait / nudge / replace / abandon; THIS module applies.
 * Lifecycle changes are funnelled exclusively through `runOne`, the only place
 * a child's `prompt()` is awaited (I-OV1): the supervisor may steer, flag and
 * abort, but a replacement is built by the worker loop or it is built for
 * nobody. Without a supervisor, every path below is byte for byte the
 * pre-feature behaviour.
 */

import type { ModelRole } from '../config/model-profiles.js';
import type { ProviderRegistry, SkillRegistry, ToolPolicyDecision, ToolPolicyVerdict } from '@aragon-agent/core';
import type { AgentMode } from '../agent/agent-mode.js';
import type { CliConfig } from '../config/schema.js';
import type { ToolPermission } from '../exec/permission.js';
import { TeamBus } from './bus.js';
import type { TeamHumanQueue } from './human-queue.js';
import { TEAM_AGGREGATE_LABEL, TEAM_LIMITS } from './limits.js';
import {
  TeamOverseer,
  buildReplacementPrompt,
  nextOverseerLadderStepMs,
  resolveOverseerFirstCheckMs,
  type OverseerInspectRequest,
  type OverseerProvider,
} from './overseer.js';
import { shouldRetryColdStart } from './retry.js';
import {
  createSubagent,
  defaultSubagentFactory,
  type SubagentAgentFactory,
  type SubagentDeps,
  type SubagentHandle,
} from './subagent.js';
import type {
  DispatchOutcome,
  OverseerDecision,
  OverseerIntervention,
  OverseerVerdict,
  SubagentRun,
  SubagentSpec,
  TeamEvent,
  TeamEventListener,
  TeamSnapshot,
} from './types.js';

export interface TeamRuntimeDeps {
  /** Read LIVE: a settings-screen model or key edit must reach the next dispatch. */
  getConfig: () => CliConfig;
  providerRegistry: ProviderRegistry;
  getCwd: () => string;
  getMode: () => AgentMode;
  getApiKey: (providerId: string, role?: ModelRole) => string | undefined;
  skillRegistry?: SkillRegistry;
  alwaysBlock?: () => string;
  toolPolicy?: () => ToolPolicyDecision;
  /**
   * The lead's `aragon exec` tool policy, carried BESIDE `toolPolicy` and never
   * folded into it (cli-integration-surface §4.2 invariant 3 / R-4).
   *
   * They answer different questions: `toolPolicy` is the skills CEILING, which
   * refuses at call time and changes per turn; this REMOVES the tool from the
   * child's array. A child that inherits one and not the other is a policy that
   * holds for the lead and not for the fan-out, which is the security control
   * silently not holding (AC-12).
   */
  permission?: ToolPermission;
  onChildToolPolicyEvent?: (e: {
    label: string;
    tool: string;
    verdict: ToolPolicyVerdict;
    sourceNames: string[];
  }) => void;
  humanQueue?: TeamHumanQueue;
  /** Test seam (§8.1): a stub factory keeps the whole scheduler off the network. */
  agentFactory?: SubagentAgentFactory;
  /**
   * Per-child fast review (main-agent parity), passed straight through to
   * `SubagentDeps`. ABSENT means the session has no fast wiring and children
   * are built exactly as they were before the reviewers existed.
   */
  review?: SubagentDeps['review'];
  /**
   * Per-child context compaction (context-auto-compaction-hardening §3.4 / W3).
   *
   * Passed straight through to `SubagentDeps`; absent means children get none,
   * which is the pre-hardening behaviour exactly. `AgentController` supplies it
   * from `CompactionWiring.childFactory()`, and the closure returns `undefined`
   * when compaction is unregistered or `compaction.subagents` is false - which
   * is what lets `subagent.ts` spread nothing at all.
   */
  contextManagerFor?: SubagentDeps['contextManagerFor'];
  /**
   * The dispatch supervisor (team-overseer). ABSENT means the session has no
   * supervision, and every path below is the pre-feature behaviour exactly.
   * `active()` is read once per dispatch AND once per inspection (inside
   * `TeamOverseer`), so a mid-dispatch `/fast off` stops the next look.
   */
  overseer?: OverseerProvider;
}

/**
 * Everything `runOne` needs that is the same for every attempt of every child.
 *
 * AN OPTIONS OBJECT, NOT FIVE POSITIONAL PARAMETERS (P2-8). This repo caps a
 * signature at five formal parameters (`CLAUDE.md`, Clean Code Guidelines), and
 * a signature that has already grown twice is the wrong place to sit exactly on
 * a ceiling.
 */
interface RunOneCtx {
  dispatchId: string;
  /**
   * THE LIVE ARRAY, mutated in place by a retry. `TeamRuntime.live` aliases the
   * same reference, so replacing `handles[index]` also replaces what
   * `abortAll()` will abort and what the outcome is built from.
   */
  handles: SubagentHandle[];
  makeHandle: (spec: SubagentSpec) => SubagentHandle;
  subagentTimeoutMs: number;
}

/** What one soft supervision timer was armed for. */
type SupervisionTrigger = 'silence' | 'clock';

/**
 * The pseudo-label aggregate supervisor notices travel under (D-5 / R-P1-6):
 * `TEAM_AGGREGATE_LABEL`, RESERVED at normalization so no child slug can be
 * `team`. The reservation is what makes this label a safe namespace - a
 * colliding child would have the aggregate notice attributed to it in the
 * ledger and its own quiet note swallowed by the report's aggregate count.
 */
const MONITOR_TEAM_LABEL = TEAM_AGGREGATE_LABEL;

const MONITOR_EXHAUSTED_DECISION: OverseerDecision = {
  action: 'wait',
  reason: 'dispatch look budget exhausted; supervision quiet for the rest of the dispatch',
};

/**
 * The wait a DEGRADED tick announces per child (D-4 / D-10). One shared
 * object, not a fresh literal per event: it is the same fact every time and
 * identity makes that obvious to any consumer that looks.
 */
const DEGRADED_WAIT_DECISION: OverseerDecision = {
  action: 'wait',
  reason: 'fast tier unavailable; waiting unassisted',
};

interface ChildSupervisorDeps {
  /** The silence window: `config.idleTimeoutMs`, the same fact the child's own
   *  (lengthened) watchdog uses, so the soft look always precedes the hard stop. */
  idleMs: number;
  /** `team_wait` / human-queue waits are legitimate, not stalls (I-OV3). */
  isLegitimatelyBlocked: (label: string) => boolean;
  onFire: (label: string, trigger: SupervisionTrigger) => void;
}

/**
 * The per-child SILENCE windows (team-overseer §3.2; subagent-overseer-v2
 * keeps only this half). Timers only — no state, no decisions; the runtime
 * applies what the supervisor decides. The wall-clock half moved to
 * `MonitorLoop`, which owns the cadence ladder for the whole roster.
 *
 * Every timer is `unref`'d (the `backoff` argument): a pending supervision
 * look must not hold the process open on exit.
 */
class ChildSupervisor {
  private readonly silences = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: ChildSupervisorDeps) {}

  /** Arm (or re-arm) the silence window for a child starting an attempt. */
  start(label: string): void {
    this.armSilence(label);
  }

  /** Reset the silence window. A no-op for a child nobody is supervising. */
  kick(label: string): void {
    if (this.silences.has(label)) this.armSilence(label);
  }

  rearmSilence(label: string): void {
    this.armSilence(label);
  }

  clear(label: string): void {
    const silence = this.silences.get(label);
    if (silence !== undefined) clearTimeout(silence);
    this.silences.delete(label);
  }

  clearAll(): void {
    for (const label of [...this.silences.keys()]) this.clear(label);
  }

  private armSilence(label: string): void {
    const previous = this.silences.get(label);
    if (previous !== undefined) clearTimeout(previous);
    const timer = setTimeout(() => {
      // I-OV3: a child legitimately blocked on `team_wait` or the confirm
      // queue re-arms quietly instead of spending an inspection on a fact the
      // digest would only re-derive.
      if (this.deps.isLegitimatelyBlocked(label)) {
        this.armSilence(label);
        return;
      }
      this.silences.delete(label);
      this.deps.onFire(label, 'silence');
    }, this.deps.idleMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.silences.set(label, timer);
  }
}

/**
 * What one cadence tick does with the labels that came due.
 *
 * AN OPTIONS OBJECT, NOT POSITIONAL PARAMETER DRIP, for the same reason
 * `RunOneCtx` exists. Everything here is a callback so `MonitorLoop` owns
 * timers and ladder arithmetic and nothing else - the runtime keeps every
 * decision, event and bookkeeping path.
 */
interface MonitorLoopDeps {
  /** The D-8 first-check derivation, resolved once per dispatch. */
  firstCheckMs: number;
  now: () => number;
  /**
   * R-P1-5: only a child that ACTUALLY STARTED and has not settled ticks. A
   * `queued` child has no ladder entry at all - it produces no inspection,
   * costs no look and takes no digest space.
   */
  isLive: (label: string) => boolean;
  /** The fast tier's live predicate, read PER TICK (R-P0-2). */
  isActive: () => boolean;
  /** Whether this child's per-child look budget is spent (D-5). */
  isExhausted: (label: string) => boolean;
  /** Whether the dispatch-wide fool-proof look total is spent (R-P1-6). */
  dispatchExhausted: () => boolean;
  /**
   * Run ONE assisted batch inspection over `labels` and apply every returned
   * decision. The returned map carries only the labels that were actually
   * inspected - a label skipped for single-flight (R-P1-4) is absent, and
   * its ladder must not move.
   */
  inspectBatch: (labels: string[]) => Promise<Map<string, OverseerDecision>>;
  /** One degraded tick: the listed children waited UNASSISTED (D-4 / D-10). */
  onDegraded: (labels: string[]) => void;
  /** Per-child look budget spent: go quiet, once (D-5). */
  onQuiet: (label: string) => void;
  /** Dispatch-wide total spent: stop the whole loop (R-P1-6). */
  onExhausted: () => void;
}

/**
 * The cadence ladder (subagent-overseer-v2 D-2): one timer for the whole
 * roster, per-child `nextAt` / `ladderStep` entries armed at each child's
 * ACTUAL start (R-P1-5), and a strict one-batch-in-flight rule.
 *
 * A SKIPPED LABEL RE-SCHEULES WITHOUT TOUCHING ITS LADDER STEP: the
 * single-flight guard (R-P1-4) can leave a due `nextAt` in the past while a
 * silence-triggered inspection of that child is still settling, and a timer
 * that re-fired at `max(0, due - now)` would busy-loop until it settles. The
 * recheck delay is invisible to the protocol - no look is spent, the ladder
 * value does not move - it only keeps the event loop idle.
 */
const MONITOR_RECHECK_MS = 500;

class MonitorLoop {
  private readonly nextAt = new Map<string, number>();
  private readonly ladderStep = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopped = false;

  constructor(private readonly deps: MonitorLoopDeps) {}

  /** Arm the FIRST rung for a child that just started (R-P1-5). */
  arm(label: string): void {
    const now = this.deps.now();
    this.nextAt.set(label, now + this.deps.firstCheckMs);
    this.ladderStep.set(label, this.deps.firstCheckMs);
    this.schedule();
  }

  /** A wait decision's `nextCheckMs` OVERRIDES the rung and becomes it (D-2). */
  override(label: string, ms: number): void {
    const now = this.deps.now();
    this.nextAt.set(label, now + ms);
    this.ladderStep.set(label, ms);
    this.schedule();
  }

  /** Any ACTION resets that child's ladder to the base rung (D-2). */
  reset(label: string): void {
    this.arm(label);
  }

  /** Grow the rung and schedule the next visit (D-2). */
  advance(label: string): void {
    const now = this.deps.now();
    const step = nextOverseerLadderStepMs(this.ladderStep.get(label) ?? this.deps.firstCheckMs);
    this.ladderStep.set(label, step);
    this.nextAt.set(label, now + step);
    this.schedule();
  }

  /** Stop visiting one child (settled, quieted, or its verdict applied). */
  clear(label: string): void {
    this.nextAt.delete(label);
    this.ladderStep.delete(label);
    this.schedule();
  }

  /** Stop the whole loop; the dispatch is over or the total budget is spent. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt.clear();
    this.ladderStep.clear();
  }

  dispose(): void {
    this.stop();
  }

  /** The earliest due time among live labels, or null when nothing is armed. */
  private earliestDue(): number | null {
    let earliest: number | null = null;
    for (const [label, at] of this.nextAt) {
      if (!this.deps.isLive(label)) continue;
      earliest = earliest === null ? at : Math.min(earliest, at);
    }
    return earliest;
  }

  private schedule(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stopped || this.ticking) return;
    const earliest = this.earliestDue();
    if (earliest === null) return;
    const delay = Math.max(0, earliest - this.deps.now());
    const timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    const now = this.deps.now();
    const due: string[] = [];
    for (const [label, at] of [...this.nextAt]) {
      if (!this.deps.isLive(label)) {
        // Settled while armed; R-P1-5 also means a re-queued replacement body
        // re-arms itself at its own start.
        this.nextAt.delete(label);
        this.ladderStep.delete(label);
        continue;
      }
      if (now >= at) due.push(label);
    }
    if (due.length === 0) {
      this.schedule();
      return;
    }

    // DEGRADED TICK (D-4 / D-10): no fast tier right now. The children wait
    // unassisted - announced per child, never killed - and the cadence keeps
    // running so a `/fast on` restores assistance at the next rung.
    if (!this.deps.isActive()) {
      this.deps.onDegraded(due);
      for (const label of due) this.advance(label);
      this.schedule();
      return;
    }

    // PER-CHILD QUIET (D-5): budget spent says so once, then stop visiting.
    const inspectable: string[] = [];
    for (const label of due) {
      if (this.deps.isExhausted(label)) {
        this.clear(label);
        this.deps.onQuiet(label);
        continue;
      }
      inspectable.push(label);
    }
    if (inspectable.length === 0) {
      this.schedule();
      return;
    }

    this.ticking = true;
    let decisions: Map<string, OverseerDecision>;
    try {
      decisions = await this.deps.inspectBatch(inspectable);
    } catch {
      // Defence in depth: `inspectBatch` is fail-soft by contract. Treat the
      // tick as if every child had answered wait.
      decisions = new Map();
    } finally {
      this.ticking = false;
    }

    const after = this.deps.now();
    for (const label of inspectable) {
      const decision = decisions.get(label);
      if (decision === undefined) {
        // Skipped for single-flight (R-P1-4): no decision, no look, and the
        // ladder does not move - only the timer must not busy-loop.
        this.nextAt.set(label, after + MONITOR_RECHECK_MS);
        continue;
      }
      if (decision.action === 'wait' && decision.nextCheckMs !== undefined) {
        this.override(label, decision.nextCheckMs);
      } else if (decision.action === 'wait') {
        this.advance(label);
      } else {
        this.reset(label);
      }
    }

    if (this.deps.dispatchExhausted()) {
      // The fool-proof total (R-P1-6). Stop the whole loop, once, loudly.
      this.stop();
      this.deps.onExhausted();
      return;
    }
    this.schedule();
  }
}

export class TeamRuntime {
  private readonly listeners = new Set<TeamEventListener>();
  private live: SubagentHandle[] = [];
  private bus: TeamBus | null = null;
  private snapshotState: TeamSnapshot | null = null;
  private busy = false;
  private aborted = false;
  private counter = 0;
  private dispatchTimer: NodeJS.Timeout | null = null;
  /**
   * Every in-flight retry backoff, so an abort releases ALL of them (P1-7).
   *
   * A SET, NOT ONE FIELD, and the plural is load-bearing: the failure that
   * triggers a cold start is usually provider-wide, so a 429 fails every
   * in-flight child's first request in the same tick and up to `maxConcurrent`
   * children enter backoff together. With a single stored resolver two of three
   * are overwritten and only the last is released, so "an abort during the
   * backoff window ends the dispatch promptly" would hold for one child and
   * quietly not for the others.
   */
  private readonly pendingBackoffs = new Set<() => void>();
  /**
   * The dispatch supervisor, LIVE for the current dispatch only
   * (team-overseer / subagent-overseer-v2). Null when the provider is not
   * wired or the policy is off, and reset to null at every dispatch end so
   * nothing supervision-shaped leaks across dispatches.
   *
   * THE GATE IS "PROVIDER PRESENT AND POLICY ON" (R-P0-2), deliberately NOT
   * the provider's live `active()`: a dispatch that STARTS without a fast
   * tier must still get a MonitorLoop, because the promise this feature
   * makes is "timeout is never a death sentence" - an unavailable tier
   * degrades the tick to an announced unassisted wait rather than falling
   * back to the legacy hard abort. `active()` is re-read every tick.
   */
  private overseer: TeamOverseer | null = null;
  /** The per-child silence windows, same lifetime as `overseer`. */
  private supervision: ChildSupervisor | null = null;
  /** The cadence ladder (subagent-overseer-v2 D-2), same lifetime. */
  private monitor: MonitorLoop | null = null;
  /** Applied interventions for the in-flight dispatch's outcome. */
  private interventions: OverseerIntervention[] = [];
  /** Labels already told the supervisor went quiet on them (D-5, once). */
  private readonly quietNotified = new Set<string>();
  /** Edge-latched "a tick ran unassisted" (D-10), per dispatch. */
  private overseerDegraded = false;
  private overseerDegradedTicks = 0;

  constructor(private readonly deps: TeamRuntimeDeps) {}

  subscribe(listener: TeamEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Unreachable while I-1 holds, and present anyway so "only one dispatch at a
   * time" is a property of THIS module rather than a consequence of another
   * package's loop shape (R-14).
   */
  isBusy(): boolean {
    return this.busy;
  }

  /** The live roster, for `/team` status. `null` when nothing is dispatching. */
  snapshot(): TeamSnapshot | null {
    return this.snapshotState;
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  async dispatch(
    specs: SubagentSpec[],
    requested: number,
    signal?: AbortSignal,
  ): Promise<DispatchOutcome> {
    this.counter += 1;
    const dispatchId = `d${this.counter}`;
    const config = this.deps.getConfig();
    const team = config.team;
    const startedAt = Date.now();

    this.busy = true;
    this.aborted = false;
    this.interventions = [];
    this.quietNotified.clear();
    this.overseerDegraded = false;
    this.overseerDegradedTicks = 0;

    // THE SUPERVISOR IS CREATED PER DISPATCH (R-P0-2): provider wired AND
    // policy on. `TeamOverseer.isActive()` re-checks the provider per
    // inspection and per tick, so a mid-dispatch `/fast off` degrades the
    // NEXT look to an unassisted wait instead of unwinding anything already
    // applied - and a dispatch that started without the tier is still
    // supervised, in that degraded, never-kill sense.
    const supervised = this.deps.overseer !== undefined && team.overseer;
    this.overseer =
      supervised && this.deps.overseer !== undefined
        ? new TeamOverseer(this.deps.overseer, { startedAt })
        : null;
    this.supervision =
      this.overseer !== null
        ? new ChildSupervisor({
            idleMs: config.idleTimeoutMs,
            isLegitimatelyBlocked: (label) => this.isBlocked(label),
            onFire: (label, trigger) => {
              void this.inspectAndApply(dispatchId, label, trigger);
            },
          })
        : null;
    this.monitor =
      this.overseer !== null
        ? new MonitorLoop({
            // D-8: `overseerIntervalMs` wins, then a positive
            // `subagentTimeoutMs` (compat), then the structural default.
            firstCheckMs: resolveOverseerFirstCheckMs(team),
            now: () => Date.now(),
            // R-P1-5: only STARTED, UNSETTLED children tick.
            isLive: (label) => this.isMonitorLive(label),
            isActive: () => this.overseer?.isActive() === true,
            isExhausted: (label) => this.overseer?.looksExhausted(label) === true,
            dispatchExhausted: () => this.overseer?.dispatchLooksExhausted() === true,
            inspectBatch: (labels) => this.monitorInspectBatch(dispatchId, labels),
            onDegraded: (labels) => this.noteDegradedTick(dispatchId, labels),
            onQuiet: (label) => this.noteQuiet(dispatchId, label),
            onExhausted: () => this.noteDispatchExhausted(dispatchId),
          })
        : null;

    // DECLARED BEFORE THE BUS, ASSIGNED AFTER THE HANDLES. `canSend` closes over
    // this binding so it reads the LIVE array: F-4 replaces `handles[index]`
    // mid-dispatch, and a captured array or a captured handle would answer for
    // the discarded child. The bus is built from `specs` and the handles are
    // built from the bus, so the existing construction order forces the hoist.
    // `canSend` is only ever called from inside a `team_wait` on a child that
    // does not exist yet, so the TDZ window is not reachable.
    let handles: SubagentHandle[] = [];

    /**
     * Whether `label` still has a loop that could call `team_send` (F-3 / P0-2).
     *
     * NEGATIVE, over TERMINAL PHASES ONLY. "The child's phase is running" is the
     * natural way to write this and is wrong on the SHIPPED DEFAULTS: at
     * `maxConcurrent: 3, maxSubagents: 5`, children 4 and 5 sit in `queued` for
     * the first part of every five-way dispatch, and a wait on one of them would
     * be refused with "nobody can answer: a4 already finished". `queued` is not
     * terminal - that child has not started yet and will.
     *
     * An unknown label permits, so this can never become a second, silent path
     * to a refusal: `checkWaitable` has its own `unknown_sender` branch.
     */
    const canSend = (label: string): boolean => {
      const handle = handles.find((h) => h.run.label === label);
      if (!handle) return true;
      const phase = handle.run.phase;
      return phase !== 'done' && phase !== 'failed' && phase !== 'aborted';
    };

    const bus = new TeamBus(
      specs.map((s) => s.label),
      {
        onMessage: (message) => this.emit({ type: 'message', dispatchId, message }),
        canSend,
      },
    );
    this.bus = bus;

    const subDeps: SubagentDeps = {
      bus,
      config,
      providerRegistry: this.deps.providerRegistry,
      getCwd: this.deps.getCwd,
      getMode: this.deps.getMode,
      getApiKey: this.deps.getApiKey,
      ...(this.deps.skillRegistry ? { skillRegistry: this.deps.skillRegistry } : {}),
      ...(this.deps.alwaysBlock ? { alwaysBlock: this.deps.alwaysBlock() } : {}),
      ...(this.deps.toolPolicy ? { toolPolicy: this.deps.toolPolicy } : {}),
      // Site two of two for the policy. Declaring it on `TeamRuntimeDeps` and
      // forgetting this line type-checks and forwards nothing — the
      // `recordChange` / `recordOutput` failure mode `tools/index.ts` records in
      // its own words, here with a security consequence rather than a cosmetic
      // one (R-5).
      ...(this.deps.permission ? { permission: this.deps.permission } : {}),
      ...(this.deps.onChildToolPolicyEvent
        ? { onChildToolPolicyEvent: this.deps.onChildToolPolicyEvent }
        : {}),
      confirmTools: config.confirmTools,
      ...(this.deps.humanQueue ? { humanQueue: this.deps.humanQueue } : {}),
      agentFactory: this.deps.agentFactory ?? defaultSubagentFactory,
      ...(this.deps.review ? { review: this.deps.review } : {}),
      // Site two of two, and the omission is silent in the same way the policy
      // one above is: declaring it on `TeamRuntimeDeps` and forgetting this line
      // type-checks and forwards nothing, so every child would quietly run with
      // no compaction while the config key says it has one.
      ...(this.deps.contextManagerFor
        ? { contextManagerFor: this.deps.contextManagerFor }
        : {}),
      // Same conditional-spread rule: a dispatch without a supervisor builds
      // the exact pre-feature `SubagentDeps`, and the child's idle watchdog
      // keeps its un-lengthened ceiling (team-overseer §3.6).
      ...(this.overseer !== null ? { overseerActive: true } : {}),
    };

    // Hoisted into a factory so a retry can build a fresh child with IDENTICAL
    // wiring (F-4). Replacing the child rather than re-prompting it is the only
    // shape where the retried child is genuinely equivalent to the first:
    // `Agent.prompt()` appends to the same history, so a second prompt would
    // show the child its brief twice.
    const makeHandle = (spec: SubagentSpec): SubagentHandle =>
      createSubagent(spec, subDeps, {
        onUpdate: (run) => this.publish(dispatchId, run),
        onUsage: (label, usage) => this.emit({ type: 'usage', dispatchId, label, usage }),
        // ONE KICK PER REAL AGENT EVENT, unthrottled (I-OV3): the silence
        // window resets on evidence, not on a coalesced UI frame.
        onActivity: () => this.supervision?.kick(spec.label),
      });
    // ASSIGNMENT, not a declaration: a `const` here would shadow the `let` above
    // the bus, `canSend` would see the empty array forever, and every peer would
    // look live - which fails open rather than closed, so nothing would break
    // loudly.
    handles = specs.map(makeHandle);
    this.live = handles;
    this.snapshotState = {
      dispatchId,
      active: true,
      runs: handles.map((h) => ({ ...h.run })),
      requested,
      startedAt,
      messageCount: 0,
    };
    this.emit({ type: 'dispatch_start', dispatchId, requested, specs });

    // TWO ABORT SOURCES, ON PURPOSE (§3.8). `ctx.signal` is the correct path
    // today; `AgentController.abort()` also calls `abortAll()` directly, which
    // makes "no child survives its dispatch" a property of the controller rather
    // than a consequence of signal plumbing three modules away.
    const onAbort = (): void => this.abortAll();
    signal?.addEventListener('abort', onAbort, { once: true });
    // The dispatch ceiling has to be enforced HERE as well as through
    // `toolTimeoutOverrides.task`: the executor's timeout is COOPERATIVE (I-2),
    // so the override only bites because `task` listens to `ctx.signal` — and a
    // second, independent timer means a signal that never arrives still ends the
    // dispatch.
    //
    // `0` MEANS NO CEILING (main-agent parity): the dispatch lasts as long as
    // its slowest child and only an Esc ends it early. The lead's idle
    // watchdog is paused for the whole dispatch either way, exactly as it is
    // for the lead's own long turns.
    this.dispatchTimer =
      team.dispatchTimeoutMs > 0
        ? setTimeout(() => this.abortAll(), team.dispatchTimeoutMs)
        : null;

    const runCtx: RunOneCtx = {
      dispatchId,
      handles,
      makeHandle,
      // D-4: with the supervisor gate open, `subagentTimeoutMs` NEVER arms a
      // hard abort - 0 here arms no timer, so the key's only remaining role
      // is the ladder's compat first-check (D-8). The legacy hard abort
      // exists ONLY under `team.overseer: false`.
      subagentTimeoutMs: team.overseer ? 0 : team.subagentTimeoutMs,
    };
    const cursor = { next: 0 };
    const workers = Array.from(
      { length: Math.max(1, Math.min(team.maxConcurrent, handles.length)) },
      () => this.worker(runCtx, cursor),
    );
    await Promise.allSettled(workers);

    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    this.dispatchTimer = null;
    signal?.removeEventListener('abort', onAbort);
    for (const handle of handles) handle.unsubscribe();
    this.monitor?.dispose();
    this.monitor = null;
    this.supervision?.clearAll();
    this.supervision = null;
    // CAPTURED BEFORE THE FIELD IS NULLED: the outcome carries what the
    // supervisor spent (D-7) and whether any tick ran unassisted (D-10),
    // both read off the per-dispatch state being torn down here.
    const overseerUsage = this.overseer?.usage();
    const overseerCalls = this.overseer?.calls();
    const overseerDegraded = this.overseerDegraded;
    const overseerDegradedTicks = this.overseerDegradedTicks;
    this.overseer = null;

    // ONE TOTAL, AT THE LEAD'S TABLE. Every child runs the lead's own model
    // (main-agent parity), so there is exactly one tier to sum and one price to
    // sum it at; a split would be two answers to one question.
    const usage = handles.reduce(
      (acc, h) => ({
        inputTokens: acc.inputTokens + h.run.usage.inputTokens,
        outputTokens: acc.outputTokens + h.run.usage.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    );

    const outcome: DispatchOutcome = {
      dispatchId,
      runs: handles.map((h) => ({ ...h.run, filesTouched: [...h.run.filesTouched] })),
      requested,
      startedAt,
      endedAt: Date.now(),
      aborted: this.aborted,
      leadMail: bus.leadMail(),
      interventions: this.interventions,
      usage,
      // Honest supervision accounting (D-7 / D-10). `overseerCalls > 0`
      // with zero usage is a provider that never reported usage - the
      // report then omits the spend line rather than pricing nothing.
      ...(overseerUsage !== undefined ? { overseerUsage } : {}),
      ...(overseerCalls !== undefined ? { overseerCalls } : {}),
      ...(overseerDegraded ? { overseerDegraded: true } : {}),
      ...(overseerDegradedTicks > 0 ? { overseerDegradedTicks } : {}),
    };

    this.live = [];
    this.bus = null;
    this.snapshotState = null;
    this.busy = false;
    this.emit({ type: 'dispatch_end', dispatchId, outcome });
    return outcome;
  }

  /** One slot of the pool: take the next index until the list is exhausted. */
  private async worker(ctx: RunOneCtx, cursor: { next: number }): Promise<void> {
    for (;;) {
      const index = cursor.next;
      cursor.next += 1;
      const handle = ctx.handles[index];
      if (!handle) return;
      if (this.aborted) {
        // Never started. Marked here rather than left `queued`, so the report
        // accounts for every spec the dispatch accepted.
        handle.run.phase = 'aborted';
        handle.run.endedAt = Date.now();
        this.publish(ctx.dispatchId, handle.run);
        continue;
      }
      await this.runOne(ctx, index);
    }
  }

  /**
   * Run one child to a terminal phase, replacing it once if its very first
   * request died on a transport error before it did anything at all (F-4), and
   * replacing it when the SUPERVISOR decides to (team-overseer §3.4).
   *
   * ONE LOOP, ALL LIFECYCLE: the cold-start replacement, the supervisor's
   * replace and the post-mortem replace all swap `handles[index]` and continue
   * THIS loop, because the await below is the only place a child is driven and
   * a handle swapped anywhere else would never be (I-OV1).
   */
  private async runOne(ctx: RunOneCtx, index: number): Promise<void> {
    const { dispatchId, handles, makeHandle, subagentTimeoutMs } = ctx;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const handle = handles[index]!;
      const { run, agent } = handle;
      // ABORTS GO THROUGH THE HANDLE (never `agent.abort()` directly): the
      // handle sets the synchronous `abortRequested` flag the child's fast
      // reviewer reads as its never-steer-into-a-requested-abort fact.
      run.phase = 'starting';
      run.startedAt = Date.now();
      this.publish(dispatchId, run);

      // WITH THE SUPERVISOR GATE OPEN there is no hard wall clock on the
      // child at all (D-4): the cadence ladder looks and decides, and the
      // child's own (lengthened) idle watchdog is the silence backstop. The
      // rung and the silence window are both armed HERE, at the attempt's
      // actual start (R-P1-5) - a `queued` child has neither. WITHOUT the
      // gate - `team.overseer: false`, the legacy regime - the hard timer is
      // armed exactly as before, `0` meaning no ceiling. A provider that is
      // wired but INACTIVE arms no timer either: the tick degrades to an
      // announced unassisted wait, never a kill (R-P0-2).
      const supervised = this.overseer !== null;
      if (supervised) {
        this.supervision?.start(run.label);
        this.monitor?.arm(run.label);
      }
      let timedOut = false;
      const timer =
        !supervised && subagentTimeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              handle.abort();
            }, subagentTimeoutMs)
          : null;

      try {
        await agent.prompt(handle.spec.prompt);
      } catch (err) {
        // `Agent.prompt()` resolves even on failure, so this only fires for a
        // stub factory or a genuine throw. Recorded rather than swallowed: a
        // child that failed for a reason nobody can see is the worst outcome the
        // report can produce.
        run.error = err instanceof Error ? err.message : String(err);
      } finally {
        if (timer) clearTimeout(timer);
      }

      const verdict: OverseerVerdict | null = handle.overseerVerdict ?? null;

      // THE SUPERVISOR'S REBUILD. Same loop, fresh body, amended brief: the
      // verdict was set and the child aborted by `inspectAndApply`; here is
      // where the replacement is actually built and driven. `attempt` resets so
      // the fresh body gets its own cold-start budget.
      if (verdict !== null && verdict.action === 'replace' && !this.aborted) {
        this.replaceChild(dispatchId, handles, index, makeHandle, handle, verdict);
        attempt = 0;
        continue;
      }

      // THE ABORT EXCLUSIONS THAT MAKE THE PREDICATE SAFE. Every abort in
      // this system reaches the provider as an aborted fetch, and `core` marks
      // an `AbortError` retryable - so Esc, `ctx.signal`, the dispatch timeout
      // (all three via `this.aborted`), the per-child timeout (`timedOut`) and
      // now the SUPERVISOR's verdict are excluded HERE, before
      // `shouldRetryColdStart` is ever consulted.
      const retryable =
        !this.aborted &&
        !timedOut &&
        verdict === null &&
        shouldRetryColdStart(run, attempt);
      if (!retryable) {
        run.endedAt = Date.now();
        // The supervisor's abandon is an error like any other, with the
        // supervisor's own reason so the report explains WHO stopped it and why.
        if (verdict !== null && verdict.action === 'abandon') {
          run.error = run.error ?? `overseer abandoned: ${verdict.reason}`;
        }
        this.settlePhase(run, timedOut, subagentTimeoutMs);
        this.publish(dispatchId, run);
        // ONE post-mortem look at a child that died silently (team-overseer
        // §3.4): a watchdog death is the "timed out" case the requirement most
        // wants diagnosed, and replace-after-death is exactly re-assignment.
        await this.maybePostMortem(ctx, index, handle, verdict);
        this.supervision?.clear(run.label);
        this.monitor?.clear(run.label);
        return;
      }

      this.replaceChild(dispatchId, handles, index, makeHandle, handle, null);
      await this.backoff(TEAM_LIMITS.retryBackoffMs);
      if (this.aborted) {
        const fresh = handles[index]!;
        fresh.run.phase = 'aborted';
        fresh.run.endedAt = Date.now();
        this.publish(dispatchId, fresh.run);
        return;
      }
    }
  }

  /**
   * One post-mortem inspection, and possibly ONE replacement driven by a
   * recursive `runOne` — the worker that called us has already moved on to the
   * next index, so nobody else will drive the fresh child (I-OV1 holds here
   * too, one frame deeper). Recursion depth is bounded by the replacement
   * budget, which is 1.
   */
  private async maybePostMortem(
    ctx: RunOneCtx,
    index: number,
    handle: SubagentHandle,
    verdict: OverseerVerdict | null,
  ): Promise<void> {
    const overseer = this.overseer;
    if (overseer === null || this.aborted || verdict !== null) return;
    const { run, agent } = handle;
    if (run.phase !== 'failed' || run.summary !== undefined) return;
    if (!overseer.replacementsLeft(run.label)) return;
    const decision = await overseer.inspect({
      run: { ...run },
      messages: agent.state.messages,
      trigger: 'postmortem',
      childAlive: false,
    });
    if (decision === null || this.aborted) return;
    this.recordIntervention(ctx.dispatchId, run.label, 'postmortem', decision);
    this.emit({
      type: 'overseer',
      dispatchId: ctx.dispatchId,
      label: run.label,
      decision,
      trigger: 'postmortem',
    });
    if (decision.action === 'replace' && overseer.replacementsLeft(run.label)) {
      this.replaceChild(ctx.dispatchId, ctx.handles, index, ctx.makeHandle, handle, {
        action: 'replace',
        reason: decision.reason,
        ...(decision.guidance !== undefined ? { guidance: decision.guidance } : {}),
      });
      await this.runOne(ctx, index);
    }
  }

  /**
   * Swap one child for a fresh one, carrying only what must survive.
   *
   * `this.live` IS `handles`, so the single assignment below also makes
   * `abortAll()` abort the NEW child and makes the outcome carry the new run.
   * Anyone tempted to "clean up" that aliasing into a defensive copy must update
   * both places.
   *
   * `verdict === null` is the COLD-START retry (F-4): identical spec, `retries`
   * carried. A verdict is the SUPERVISOR's replace: an amended brief
   * (`buildReplacementPrompt`), `replacements` carried, and the supervisor's
   * budget spent HERE, at the moment the rebuild is real.
   */
  private replaceChild(
    dispatchId: string,
    handles: SubagentHandle[],
    index: number,
    makeHandle: (spec: SubagentSpec) => SubagentHandle,
    handle: SubagentHandle,
    verdict: OverseerVerdict | null,
  ): SubagentHandle {
    const carried = { ...handle.run.usage };
    const retries = (handle.run.retries ?? 0) + (verdict === null ? 1 : 0);
    const replacements = (handle.run.replacements ?? 0) + (verdict !== null ? 1 : 0);
    const interventions = handle.run.interventions;
    const lastIntervention = handle.run.lastIntervention;
    handle.unsubscribe();
    try {
      handle.abort();
    } catch {
      // Already gone; this must not stop the retry.
    }

    const spec =
      verdict !== null
        ? {
            ...handle.spec,
            prompt: buildReplacementPrompt(
              handle.spec,
              {
                action: 'replace',
                reason: verdict.reason,
                ...(verdict.guidance !== undefined ? { guidance: verdict.guidance } : {}),
              },
              handle.run,
            ),
          }
        : handle.spec;
    const fresh = makeHandle(spec);
    // Provably {0,0} under the cold-start predicate above (no turn completed,
    // so no `turn_end` and no usage event). Carried anyway so that a future
    // relaxation of the predicate cannot silently under-report spend - the most
    // misleading failure this feature can produce.
    fresh.run.usage = carried;
    fresh.run.retries = retries;
    if (replacements > 0) fresh.run.replacements = replacements;
    if (interventions !== undefined) fresh.run.interventions = interventions;
    // The badge survives a rebuild (`replaced 5s`) - the panel row does not
    // reset just because the body under it did.
    if (lastIntervention !== undefined) fresh.run.lastIntervention = lastIntervention;
    if (verdict !== null) this.overseer?.noteReplacement(handle.run.label);
    handles[index] = fresh;
    this.publish(dispatchId, fresh.run);
    return fresh;
  }

  // -------------------------------------------------------------------------
  // Supervision (team-overseer)
  // -------------------------------------------------------------------------

  /**
   * Whether a child's silence is a legitimate wait rather than a stall:
   * `team_wait` (the comm tool already pauses the child's own watchdog for
   * exactly this wait) or a confirmation queued on the one human slot.
   */
  private isBlocked(label: string): boolean {
    const handle = this.live.find((h) => h.run.label === label);
    if (handle !== undefined && handle.run.phase === 'waiting') return true;
    return this.deps.humanQueue?.isWaiting(label) === true;
  }

  /**
   * One SILENCE trigger handled: look, then apply. Fired from a supervision
   * timer and therefore async-and-forgotten; nothing here may throw.
   *
   * A NULL DECISION HAS THREE DISTINCT QUIETS: the look budget is spent ->
   * say so ONCE and stop supervising this child (D-5); an inspection of this
   * child is already in flight -> re-arm and let it settle (R-P1-4); the
   * tier is gone -> clear quietly, because the cadence tick - not the
   * silence path - owns the degraded announcements (D-4).
   */
  private async inspectAndApply(
    dispatchId: string,
    label: string,
    trigger: SupervisionTrigger,
  ): Promise<void> {
    const overseer = this.overseer;
    const supervision = this.supervision;
    if (overseer === null || supervision === null || this.aborted) return;
    const handle = this.live.find((h) => h.run.label === label);
    if (handle === undefined) return;
    const phase = handle.run.phase;
    if (phase === 'done' || phase === 'failed' || phase === 'aborted') return;

    try {
      const decision = await overseer.inspect({
        run: handle.run,
        messages: handle.agent.state.messages,
        trigger,
        childAlive: true,
      });
      if (decision === null || this.aborted) {
        if (!this.aborted && overseer.looksExhausted(label)) {
          this.noteQuiet(dispatchId, label);
          supervision.clear(label);
          this.monitor?.clear(label);
        } else if (!this.aborted && overseer.isInFlight(label)) {
          supervision.rearmSilence(label);
        } else {
          supervision.clear(label);
        }
        return;
      }
      // The child may have settled while the call was in flight; an
      // intervention is still recorded (it happened), but nothing is applied.
      const settled =
        handle.run.phase === 'done' ||
        handle.run.phase === 'failed' ||
        handle.run.phase === 'aborted';
      this.recordIntervention(dispatchId, label, trigger, decision);
      this.emit({ type: 'overseer', dispatchId, label, decision, trigger });
      if (settled) {
        supervision.clear(label);
        this.monitor?.clear(label);
        return;
      }
      this.applyDecision(handle, label, decision);
    } catch {
      // Defence in depth around an async timer callback: an unexpected throw
      // must not take the dispatch down. The child keeps its timers.
      supervision.rearmSilence(label);
    }
  }

  private applyDecision(
    handle: SubagentHandle,
    label: string,
    decision: OverseerDecision,
  ): void {
    const supervision = this.supervision;
    const overseer = this.overseer;
    if (supervision === null || overseer === null) return;
    switch (decision.action) {
      case 'wait':
        // A model-chosen interval OVERRIDES the rung and becomes it (D-2);
        // without one the rung is untouched - the silence window is the only
        // clock this path re-arms.
        if (decision.nextCheckMs !== undefined) {
          this.monitor?.override(label, decision.nextCheckMs);
        }
        supervision.rearmSilence(label);
        break;
      case 'nudge': {
        // THE NUDGE BUDGET IS CHECKED BEFORE STEERING (D-5): a fourth nudge
        // is not advice, it is the supervisor refusing to decide - it waits.
        if (!overseer.nudgesLeft(label)) {
          supervision.rearmSilence(label);
          break;
        }
        // I-OV4: never steer into an abort already requested — the same
        // guard-1 fact the child's fast reviewer reads. Queued steering is
        // drained at the safe top-of-loop checkpoint by core.
        if (!handle.isAborted() && decision.guidance !== undefined) {
          handle.agent.steer(decision.guidance);
          overseer.noteNudge(label);
        }
        this.monitor?.reset(label);
        supervision.rearmSilence(label);
        break;
      }
      case 'replace': {
        // Budgets checked BEFORE the verdict is set, so two near-simultaneous
        // replace decisions cannot both rebuild (the second becomes an
        // abandon with the budget stated in the reason).
        if (overseer.replacementsLeft(label)) {
          handle.overseerVerdict = {
            action: 'replace',
            reason: decision.reason,
            ...(decision.guidance !== undefined ? { guidance: decision.guidance } : {}),
          };
        } else if (overseer.abandonsLeft(label)) {
          handle.overseerVerdict = {
            action: 'abandon',
            reason: `replacement budget exhausted; ${decision.reason}`,
          };
          overseer.noteAbandon(label);
        } else {
          // Both mutation budgets spent: the honest reading is wait (I-OV2).
          supervision.rearmSilence(label);
          this.monitor?.advance(label);
          break;
        }
        supervision.clear(label);
        this.monitor?.clear(label);
        handle.abort();
        break;
      }
      case 'abandon':
        if (!overseer.abandonsLeft(label)) {
          supervision.rearmSilence(label);
          this.monitor?.advance(label);
          break;
        }
        handle.overseerVerdict = { action: 'abandon', reason: decision.reason };
        overseer.noteAbandon(label);
        supervision.clear(label);
        this.monitor?.clear(label);
        handle.abort();
        break;
    }
  }

  /** Record one applied decision on the outcome, the run and the event stream. */
  private recordIntervention(
    dispatchId: string,
    label: string,
    trigger: OverseerIntervention['trigger'],
    decision: OverseerDecision,
  ): void {
    const at = Date.now();
    this.interventions.push({
      label,
      at,
      action: decision.action,
      reason: decision.reason,
      trigger,
    });
    const handle = this.live.find((h) => h.run.label === label);
    if (handle !== undefined) {
      handle.run.interventions = (handle.run.interventions ?? 0) + 1;
      // The panel's badge (AC-5): ABSOLUTE `at`, same units as `startedAt`
      // (R-P2-3), so rendering is one subtraction.
      handle.run.lastIntervention = {
        action: decision.action,
        at,
        reasonHead: decision.reason.slice(0, 60),
      };
      this.publish(dispatchId, handle.run);
    }
  }

  // -------------------------------------------------------------------------
  // The cadence loop's callbacks (subagent-overseer-v2 D-2 / D-3 / D-4)
  // -------------------------------------------------------------------------

  /** R-P1-5: a label ticks only once STARTED and not yet settled. */
  private isMonitorLive(label: string): boolean {
    const handle = this.live.find((h) => h.run.label === label);
    if (handle === undefined || handle.run.startedAt === undefined) return false;
    const phase = handle.run.phase;
    return phase !== 'done' && phase !== 'failed' && phase !== 'aborted';
  }

  /**
   * One ASSISTED cadence tick: build the batch over the due labels, apply
   * every returned decision through the same `applyDecision` the silence
   * path uses (D-3's single application path), and hand the map back so the
   * loop can move the ladders. Labels the batch skipped (single-flight,
   * R-P1-4) are absent from the map.
   */
  private async monitorInspectBatch(
    dispatchId: string,
    labels: string[],
  ): Promise<Map<string, OverseerDecision>> {
    const overseer = this.overseer;
    if (overseer === null || this.aborted) return new Map();
    const reqs: OverseerInspectRequest[] = [];
    for (const label of labels) {
      const handle = this.live.find((h) => h.run.label === label);
      if (handle === undefined) continue;
      reqs.push({
        run: handle.run,
        messages: handle.agent.state.messages,
        trigger: 'clock',
        childAlive: true,
      });
    }
    const decisions = await overseer.inspectBatch(reqs);
    for (const [label, decision] of decisions) {
      if (this.aborted) break;
      const handle = this.live.find((h) => h.run.label === label);
      const settled =
        handle === undefined ||
        handle.run.phase === 'done' ||
        handle.run.phase === 'failed' ||
        handle.run.phase === 'aborted';
      this.recordIntervention(dispatchId, label, 'clock', decision);
      this.emit({ type: 'overseer', dispatchId, label, decision, trigger: 'clock' });
      if (settled) {
        this.monitor?.clear(label);
        continue;
      }
      this.applyDecision(handle!, label, decision);
    }
    return decisions;
  }

  /**
   * One DEGRADED cadence tick (D-4 / D-10): the fast tier is missing right
   * now. The children wait unassisted - announced per child through the same
   * event shape, never killed - and the fact is edge-latched here, NOT in
   * the interventions ledger.
   */
  private noteDegradedTick(dispatchId: string, labels: string[]): void {
    this.overseerDegraded = true;
    this.overseerDegradedTicks += 1;
    for (const label of labels) {
      this.emit({
        type: 'overseer',
        dispatchId,
        label,
        decision: DEGRADED_WAIT_DECISION,
        trigger: 'clock',
      });
    }
  }

  /** The supervisor goes quiet on one child, ONCE (D-5 / D-10). */
  private noteQuiet(dispatchId: string, label: string): void {
    if (this.quietNotified.has(label)) return;
    this.quietNotified.add(label);
    const decision: OverseerDecision = {
      action: 'wait',
      reason: 'look budget exhausted; supervision quiet for this child',
    };
    this.recordIntervention(dispatchId, label, 'quiet', decision);
    this.emit({ type: 'overseer', dispatchId, label, decision, trigger: 'quiet' });
  }

  /**
   * The dispatch-wide fool-proof total is spent (R-P1-6): stop the whole
   * loop and emit ONE aggregate notice under a pseudo-label that is never a
   * child slug.
   */
  private noteDispatchExhausted(dispatchId: string): void {
    this.monitor?.stop();
    this.recordIntervention(dispatchId, MONITOR_TEAM_LABEL, 'quiet', MONITOR_EXHAUSTED_DECISION);
    this.emit({
      type: 'overseer',
      dispatchId,
      label: MONITOR_TEAM_LABEL,
      decision: MONITOR_EXHAUSTED_DECISION,
      trigger: 'quiet',
    });
  }

  /**
   * The final phase of an attempt, in a FIXED ORDER: aborted, then timed out,
   * then error, then no-summary, then done.
   *
   * Extracted verbatim so the retry loop has one exit and the order lives in one
   * place.
   */
  private settlePhase(run: SubagentRun, timedOut: boolean, subagentTimeoutMs: number): void {
    if (this.aborted) {
      run.phase = 'aborted';
    } else if (timedOut && subagentTimeoutMs > 0) {
      run.phase = 'failed';
      run.error = run.error ?? `subagent exceeded ${Math.round(subagentTimeoutMs / 1000)}s`;
    } else if (run.error) {
      run.phase = 'failed';
    } else if (!run.summary) {
      // A child whose watchdog fired, or whose stream died silently, resolves
      // with nothing. `[failed: run produced no output]` is the honest reading;
      // `[ok]` with an empty section is not.
      run.phase = 'failed';
      run.error = 'run produced no output';
    } else {
      run.phase = 'done';
    }
  }

  /**
   * Sleep, releasing early when the dispatch aborts.
   *
   * The timer is `unref`'d so a pending backoff cannot hold the process open on
   * exit, and the resolver is registered in `pendingBackoffs` so `abortAll()`
   * releases EVERY one of them rather than only the last (P1-7).
   */
  private backoff(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.pendingBackoffs.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.pendingBackoffs.add(done);
    });
  }

  // -------------------------------------------------------------------------
  // Abort / dispose
  // -------------------------------------------------------------------------

  /**
   * Stop every child and settle every blocking wait.
   *
   * Idempotent, and safe to call when nothing is running — `AgentController.abort()`
   * calls it unconditionally.
   */
  abortAll(): void {
    if (!this.busy) return;
    this.aborted = true;
    for (const handle of this.live) {
      try {
        handle.abort();
      } catch {
        // A child that is already gone must not stop the others being aborted.
      }
    }
    this.bus?.cancelAllWaits();
    this.supervision?.clearAll();
    // The cadence loop too: every child is being aborted, so no tick has
    // anything left to look at (an in-flight batch's decisions are dropped
    // by the aborted guard in `monitorInspectBatch`).
    this.monitor?.stop();
    // Every in-flight retry backoff, not just the last one registered: a
    // provider-wide failure puts up to `maxConcurrent` children here at once.
    for (const release of [...this.pendingBackoffs]) release();
  }

  /** Process-exit path: abort everything and clear timers (R-15). */
  dispose(): void {
    this.abortAll();
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    this.dispatchTimer = null;
    this.monitor?.dispose();
    this.monitor = null;
    this.supervision?.clearAll();
    this.supervision = null;
    this.overseer = null;
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private publish(dispatchId: string, run: SubagentRun): void {
    const copy: SubagentRun = { ...run, filesTouched: [...run.filesTouched] };
    if (this.snapshotState && this.snapshotState.dispatchId === dispatchId) {
      this.snapshotState = {
        ...this.snapshotState,
        runs: this.snapshotState.runs.map((r) => (r.label === copy.label ? copy : r)),
        messageCount: this.bus?.messageCount() ?? this.snapshotState.messageCount,
        ...(this.bus?.lastMessage() ? { lastMessage: this.bus.lastMessage() } : {}),
      };
    }
    this.emit({ type: 'agent_update', dispatchId, run: copy });
  }

  private emit(event: TeamEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One bad subscriber must not take the dispatch down with it.
      }
    }
  }
}
