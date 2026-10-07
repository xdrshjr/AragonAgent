/**
 * TeamRuntime — dispatch scheduling, budgets, the `TeamEvent` stream, abort and
 * disposal (team-subagents §3.2 / §3.5 / §3.8).
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
 */

import type { ModelRole } from '../config/model-profiles.js';
import type { ProviderRegistry, SkillRegistry, ToolPolicyDecision, ToolPolicyVerdict } from '@aragon-agent/core';
import type { AgentMode } from '../agent/agent-mode.js';
import type { CliConfig } from '../config/schema.js';
import type { ToolPermission } from '../exec/permission.js';
import { TeamBus } from './bus.js';
import type { TeamHumanQueue } from './human-queue.js';
import { TEAM_LIMITS } from './limits.js';
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
   * Per-tier model resolution (fast-model-tier §3.4). Passed straight through to
   * `SubagentDeps`; absent means every child runs on the session's model, which
   * is the pre-feature behaviour.
   */
  resolveTier?: SubagentDeps['resolveTier'];
  /**
   * Per-child context compaction (context-auto-compaction-hardening §3.4 / W3).
   *
   * Passed straight through to `SubagentDeps`; absent means children get none,
   * which is the pre-hardening behaviour exactly. `AgentController` supplies it
   * from `CompactionWiring.childFactory()`, and the closure returns `undefined`
   * when compaction is unregistered or `compaction.subagents` is false - which is
   * what lets `subagent.ts` spread nothing at all.
   */
  contextManagerFor?: SubagentDeps['contextManagerFor'];
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
    /** Carried through from the normalizer so the report can state it (§3.4 /
     *  R-6). Optional, so every existing caller compiles unchanged. */
    extra: { downgraded?: number } = {},
  ): Promise<DispatchOutcome> {
    this.counter += 1;
    const dispatchId = `d${this.counter}`;
    const config = this.deps.getConfig();
    const team = config.team;
    const startedAt = Date.now();

    this.busy = true;
    this.aborted = false;

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
     * natural way to write this and it is wrong on the SHIPPED DEFAULTS: at
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
      ...(this.deps.resolveTier ? { resolveTier: this.deps.resolveTier } : {}),
      // Site two of two, and the omission is silent in the same way the policy
      // one above is: declaring it on `TeamRuntimeDeps` and forgetting this line
      // type-checks and forwards nothing, so every child would quietly run with
      // no compaction while the config key says it has one.
      ...(this.deps.contextManagerFor
        ? { contextManagerFor: this.deps.contextManagerFor }
        : {}),
    };

    // Hoisted into a factory so a retry can build a fresh child with IDENTICAL
    // wiring (F-4). Replacing the child rather than re-prompting it is the only
    // shape where the retried child is genuinely equivalent to the first:
    // `Agent.prompt()` appends to the same history, so a second prompt would
    // show the child its brief twice.
    const makeHandle = (spec: SubagentSpec): SubagentHandle =>
      createSubagent(spec, subDeps, {
        onUpdate: (run) => this.publish(dispatchId, run),
        // `tier` rides along so `App.tsx` can pick the RIGHT cost table for this
        // event rather than always using the lead's (§3.6 / R-7). Taken from the
        // SPEC, which the normalizer already downgraded when the tier was
        // unavailable, so it names the model that actually billed.
        onUsage: (label, usage) =>
          this.emit({ type: 'usage', dispatchId, label, usage, tier: spec.tier }),
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
    this.dispatchTimer = setTimeout(() => this.abortAll(), team.dispatchTimeoutMs);

    const runCtx: RunOneCtx = {
      dispatchId,
      handles,
      makeHandle,
      subagentTimeoutMs: team.subagentTimeoutMs,
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

    // SUMMED PER TIER (fast-model-tier §3.4 / R-7). One total priced at the
    // lead's table would over-report a Haiku child under a Sonnet lead by
    // roughly an order of magnitude — and the whole justification for delegating
    // to a cheaper model is a number in the report this feeds.
    // `main` IS THE COMPLEMENT OF `fast`, not an equality test. `SubagentRun.tier`
    // is populated by `createSubagent` from the spec, but a hand-built run in a
    // test — or a run restored from a session file written before this field
    // existed — has it `undefined`, and `=== 'main'` would silently drop that
    // child's spend from the total. Under-reporting is the one failure this
    // split exists to prevent, so the default direction has to be "counted".
    const sumTier = (tier: SubagentSpec['tier']) =>
      handles
        .filter((h) => (tier === 'fast' ? h.run.tier === 'fast' : h.run.tier !== 'fast'))
        .reduce(
          (acc, h) => ({
            inputTokens: acc.inputTokens + h.run.usage.inputTokens,
            outputTokens: acc.outputTokens + h.run.usage.outputTokens,
          }),
          { inputTokens: 0, outputTokens: 0 },
        );
    const fastUsage = sumTier('fast');
    const ranFast = handles.some((h) => h.run.tier === 'fast');

    const outcome: DispatchOutcome = {
      dispatchId,
      runs: handles.map((h) => ({ ...h.run, filesTouched: [...h.run.filesTouched] })),
      requested,
      startedAt,
      endedAt: Date.now(),
      aborted: this.aborted,
      leadMail: bus.leadMail(),
      usage: sumTier('main'),
      // ABSENT when no fast child ran, which is what keeps a default session's
      // outcome shape byte-identical to the pre-feature one.
      ...(ranFast ? { fastUsage } : {}),
      ...(extra.downgraded ? { downgraded: extra.downgraded } : {}),
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
   * request died on a transport error before it did anything at all (F-4).
   */
  private async runOne(ctx: RunOneCtx, index: number): Promise<void> {
    const { dispatchId, handles, makeHandle, subagentTimeoutMs } = ctx;
    for (let attempt = 0; ; attempt += 1) {
      const handle = handles[index]!;
      const { run, agent } = handle;
      run.phase = 'starting';
      run.startedAt = Date.now();
      this.publish(dispatchId, run);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        agent.abort();
      }, subagentTimeoutMs);

      try {
        await agent.prompt(handle.spec.prompt);
      } catch (err) {
        // `Agent.prompt()` resolves even on failure, so this only fires for a
        // stub factory or a genuine throw. Recorded rather than swallowed: a
        // child that failed for a reason nobody can see is the worst outcome the
        // report can produce.
        run.error = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timer);
      }

      // THE TWO ABORT EXCLUSIONS THAT MAKE THE PREDICATE SAFE. Every abort in
      // this system reaches the provider as an aborted fetch, and `core` marks
      // an `AbortError` retryable - so Esc, `ctx.signal`, the dispatch timeout
      // (all three via `this.aborted`) and the per-child timeout (`timedOut`)
      // are excluded HERE, before `shouldRetryColdStart` is ever consulted.
      const retryable = !this.aborted && !timedOut && shouldRetryColdStart(run, attempt + 1);
      if (!retryable) {
        run.endedAt = Date.now();
        this.settlePhase(run, timedOut, subagentTimeoutMs);
        this.publish(dispatchId, run);
        return;
      }

      const fresh = this.replaceForRetry(dispatchId, handles, index, makeHandle);
      await this.backoff(TEAM_LIMITS.retryBackoffMs);
      if (this.aborted) {
        fresh.run.phase = 'aborted';
        fresh.run.endedAt = Date.now();
        this.publish(dispatchId, fresh.run);
        return;
      }
    }
  }

  /**
   * Swap a cold-started child for a fresh one, carrying only what must survive.
   *
   * `this.live` IS `handles`, so the single assignment below also makes
   * `abortAll()` abort the NEW child and makes the outcome carry the new run.
   * Anyone tempted to "clean up" that aliasing into a defensive copy must update
   * both places.
   */
  private replaceForRetry(
    dispatchId: string,
    handles: SubagentHandle[],
    index: number,
    makeHandle: (spec: SubagentSpec) => SubagentHandle,
  ): SubagentHandle {
    const handle = handles[index]!;
    const carried = { ...handle.run.usage };
    const retries = (handle.run.retries ?? 0) + 1;
    handle.unsubscribe();
    try {
      handle.agent.abort();
    } catch {
      // Already gone; this must not stop the retry.
    }

    const fresh = makeHandle(handle.spec);
    // Provably {0,0} under the predicate above (no turn completed, so no
    // `turn_end` and no usage event). Carried anyway so that a future relaxation
    // of the predicate cannot silently under-report spend - the most misleading
    // failure this feature can produce.
    fresh.run.usage = carried;
    fresh.run.retries = retries;
    handles[index] = fresh;
    this.publish(dispatchId, fresh.run);
    return fresh;
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
    } else if (timedOut) {
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
        handle.agent.abort();
      } catch {
        // A child that is already gone must not stop the others being aborted.
      }
    }
    this.bus?.cancelAllWaits();
    // Every in-flight retry backoff, not just the last one registered: a
    // provider-wide failure puts up to `maxConcurrent` children here at once.
    for (const release of [...this.pendingBackoffs]) release();
  }

  /** Process-exit path: abort everything and clear timers (R-15). */
  dispose(): void {
    this.abortAll();
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    this.dispatchTimer = null;
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
