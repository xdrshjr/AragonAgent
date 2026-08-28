/**
 * `CompactionWiring` — the controller-side glue for context compaction
 * (context-auto-compaction §3.2.1 / §5.2).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope.
 *
 * CONSTRUCT BEFORE THE `Agent`, ATTACH AFTER IT (C-12 / D-19), and the split is
 * the whole reason this class has an `attach` method at all:
 *
 *   - The PORT has to be INSIDE the `Agent`'s constructor argument, because
 *     `AgentConfig.contextManager` has no setter and the loop reads it from the
 *     loop context.
 *   - The WIRING has to SUBSCRIBE to the `Agent`, because `compaction_end` is
 *     where the engine's `applied` verdict arrives and `agent_start` is what
 *     resets the per-run cap.
 *
 * `AgentController` cannot do both in one step: `new Agent({...})` runs before
 * every optional subsystem, precisely because `FastWiring`'s constructor
 * subscribes. So THIS CONSTRUCTOR MUST NOT SUBSCRIBE. A field assigned after the
 * `new Agent` call and spread into it conditionally produces a build where the
 * feature is registered, enabled, and SILENTLY ABSENT - the exact shape of
 * failure `controller.ts`'s `toolOutputs` comment documents.
 *
 * `manager()` returns a STABLE object for the controller's lifetime, whose two
 * methods delegate to a compactor that reads config LIVE - which is what lets
 * `/compact off`, `/compact threshold 0.8` and a settings-screen save take effect
 * mid-session without touching the `Agent`.
 *
 * DECLINED COMPACTIONS PRODUCE NO CLI EVENTS (quiet-noop §3.6). A `pressure`
 * compaction that changed nothing, called nothing and spent nothing never emits
 * `compaction_start`, so `onCompactorEvent` never opens a card and `settlePending`
 * finds neither a held record nor a skeleton to synthesize. CORE still emits its
 * own pair for every attempt, which is why `settlePending` still runs - it just
 * refreshes the snapshot and returns. `onCompactorEvent`'s `if (!this.open)`
 * guard is now unreachable for declines and stays for the abort race it was
 * written for.
 */

import {
  DEFAULT_RETRY_POLICY,
  estimatePromptTokens,
  initProviders,
  validateHistory,
  type AgentEvent,
  type ContextManager,
  type Message,
  type ModelInfo,
  type ModelRef,
  type ProviderRegistry,
  type ProviderRegistryOptions,
  type RetryPolicy,
  type TokenUsage,
} from '@aragon-agent/core';
import type { CliConfig } from '../config/schema.js';
import type { NoticeLevel } from '../agent/reducer.js';
import { getLogger } from '../logging/logger.js';
import { mintRunId, writeArchive } from './archive.js';
import { createChildContextManager, type ChildContextManagerFactory } from './child.js';
import { Compactor } from './compactor.js';
import type {
  CompactionEvent,
  CompactionEventListener,
  CompactionRecord,
  CompactionSnapshot,
  CompactionUiTrigger,
  Pressure,
} from './types.js';

/**
 * One retry, not ten and not zero - the `fast/wiring.ts` argument unchanged
 * (D-10).
 *
 * Inheriting the user's `/retry` policy would let a background repair compete
 * with the user's own work for a rate-limited provider's quota, and it would put
 * up to ten backoffs inside a window the idle watchdog is PAUSED across.
 */
const COMPACTION_RETRY_POLICY: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxRetries: 1 };

export interface CompactionWiringDeps {
  /** Read LIVE on every call - the controller replaces the object on mutation. */
  getConfig: () => CliConfig;
  hasKey: (providerId: string) => boolean;
  getApiKey: (providerId: string) => string | undefined;
  getModelInfoFor: (ref: Pick<ModelRef, 'providerId' | 'modelId'>) => ModelInfo;
  isPricedModel: (ref: Pick<ModelRef, 'providerId' | 'modelId'>) => boolean;
  /**
   * LAZY, and they must be: this class is constructed BEFORE the `Agent`, so a
   * closure that touches it is only valid from inside an event handler.
   */
  getMessages: () => readonly Message[];
  getSystemPrompt: () => string;
  notify: (level: NoticeLevel, text: string) => void;
  /**
   * How the summarizer's own registry is built. Defaults to `initProviders`.
   *
   * THE ONE PRODUCTION SEAM ADDED FOR TESTABILITY (hardening DH-13 / W6).
   * Everything else the offline harness needs is already public:
   * `ProviderRegistry.register` overwrites by id, `AgentController` exposes the
   * lead's registry, and `Agent` accepts one in its config. `getRegistry()` was
   * the only closed door - it calls `initProviders` with no injection point, so
   * the lead's transport was scriptable in a test and the SUMMARIZER'S was not.
   * A test-only seam per module is how a codebase acquires a shadow API; this is
   * one, and it is named.
   */
  createRegistry?: (options: ProviderRegistryOptions) => ProviderRegistry;
  /**
   * The archive directory, injected by the tests. Production passes nothing and
   * `archive.ts` resolves `<home>/compaction` itself.
   */
  archiveDir?: string;
}

/** The status of a session that never had compaction (the wiring is `null`). */
export function offCompactionSnapshot(): CompactionSnapshot {
  return {
    live: false,
    model: '',
    compactions: 0,
    tokensReclaimed: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    pricingUnknown: false,
    inFlight: false,
    selfDisabled: false,
    generation: 0,
    pressure: {
      occupied: 0,
      contextWindow: 0,
      ratio: 0,
      headroom: 0,
      source: 'estimate',
      windowKnown: false,
      deltaTokens: 0,
    },
  };
}

export class CompactionWiring {
  private readonly log = getLogger().child('compaction');
  private readonly listeners = new Set<CompactionEventListener>();
  private readonly compactor: Compactor;
  /** The compactor's OWN transport (D-10). Lazy - see `getRegistry()`. */
  private registry: ProviderRegistry | null = null;
  private unsubscribe: (() => void) | null = null;
  /** The stable port handed to `new Agent({...})`. Never reassigned. */
  private readonly port: ContextManager;

  /**
   * The record the compactor produced, waiting for the ENGINE's verdict.
   *
   * `applied` is not knowable on the host side: validation happens after
   * `compact()` returns, inside the loop. So the compactor's record is held here
   * and corrected when the core `compaction_end` arrives (§3.2.1). The IDLE
   * `/compact` path has no core event and settles its own record directly.
   */
  private pending: CompactionRecord | null = null;

  /**
   * What the CLI-local `compaction_start` announced, and `null` once the card has
   * been settled.
   *
   * THE ENGINE'S VERDICT CAN ARRIVE BEFORE THE COMPACTOR'S RECORD, and Esc is the
   * ordinary way it happens: `runCompaction` races `compact()` against the run's
   * signal, so an abort resolves the race and emits `compaction_end` while
   * `compact()` is still unwinding its own call. With nothing held here,
   * `settlePending` would find no record, return, and leave the card `live:
   * true` FOREVER — which is C-8's failure mode exactly: `Transcript`'s settled
   * boundary is monotonic, so the whole tail re-renders on every frame for the
   * rest of the session, and the card goes on claiming a compaction is running.
   * `manager_timeout` and a `compact()` that rejects outright reach the same
   * place.
   *
   * So the verdict settles the card from whatever is available — the compactor's
   * record when it exists, this skeleton when it does not — and clearing this
   * field is what tells a LATE record that its card is already closed.
   */
  private open: { index: number; trigger: CompactionUiTrigger; model: string } | null = null;

  /** Live flag, flipped by `/compact on|off`. Starts equal to `enabled`. */
  private enabled: boolean;

  /**
   * Identifies THIS RUN's archives in a directory several runs share (RV-6).
   *
   * NOT `SessionMeta.id`: that exists only once a session has been saved, and the
   * unattended long run this feature serves is exactly the one nobody saved.
   * Short, filename-safe, and only ever compared for equality - it is a grouping
   * key, not an identity.
   */
  private readonly runId = mintRunId();

  constructor(private readonly deps: CompactionWiringDeps) {
    this.enabled = deps.getConfig().compaction.enabled;
    this.compactor = new Compactor({
      getConfig: deps.getConfig,
      hasKey: deps.hasKey,
      getApiKey: deps.getApiKey,
      getModelInfoFor: deps.getModelInfoFor,
      isPricedModel: deps.isPricedModel,
      // `shouldCompact` reads these on the ESTIMATE branch (§3.4.2). Forwarded
      // rather than defaulted to `[]`, because an empty history estimates to 0 %
      // and the resumed-session case would then never trigger.
      getMessages: deps.getMessages,
      getSystemPrompt: deps.getSystemPrompt,
      complete: (providerId, request) => this.getRegistry().complete(providerId, request),
      emit: (event) => this.onCompactorEvent(event),
      notify: deps.notify,
      // ONE NUMBER ON SCREEN AND IN THE TRIGGER (R-11 / DH-15). The checkpoint
      // has already measured; publishing THAT pressure rather than re-measuring
      // is what keeps the two from disagreeing by one turn's tool results.
      onPressure: (pressure) => this.emit({ type: 'snapshot', snapshot: this.snapshotWith(pressure) }),
    });

    // ONE OBJECT, FOR THE CONTROLLER'S LIFETIME. The `Agent` therefore needs no
    // setter and `contextManager` is never reassigned; the LIVE switch is inside
    // `shouldCompact`, not in the identity of this object.
    this.port = {
      shouldCompact: (probe) => this.enabled && this.compactor.shouldCompact(probe),
      compact: (ctx) => this.compactor.compact(ctx),
    };
  }

  /**
   * The port for `new Agent({...})`.
   *
   * Spread CONDITIONALLY at the call site so `contextManager` stays genuinely
   * `undefined` when the feature is off (AC-1): the loop's gate is
   * `if (!ctx.contextManager) return false` against an ABSENT field, not a live
   * object whose predicate says no.
   */
  manager(): ContextManager {
    return this.port;
  }

  /**
   * Subscribe to the lead agent's stream. IDEMPOTENT, and separate from the
   * constructor - see the file header.
   */
  attach(subscribe: (listener: (event: AgentEvent) => void) => () => void): void {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribe((event) => this.onAgentEvent(event));
  }

  dispose(): void {
    this.compactor.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  // -----------------------------------------------------------------------
  // Flags
  // -----------------------------------------------------------------------

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    // Turning it back on is the user overriding guard 4, which is the only way
    // out of a self-disable short of a restart.
    if (enabled) this.compactor.clearSelfDisable();
    this.emit({ type: 'snapshot', snapshot: this.snapshot() });
  }

  /** Re-emit the snapshot after any config mutation, so the chip and the gauge move. */
  onConfigChanged(): void {
    this.emit({ type: 'snapshot', snapshot: this.snapshot() });
  }

  abort(): void {
    this.compactor.abort();
  }

  /**
   * The host replaced or cleared the history (hardening §3.2.3, sites 3 and 4).
   *
   * `/clear`, `/resume`, and any future host-side rewrite. A recorded prefix
   * length indexes an array that no longer exists, so the delta must be
   * abandoned rather than applied to a different history.
   */
  onHistoryReplaced(): void {
    this.compactor.invalidateMeasurement();
  }

  /**
   * The per-child manager factory, or `null` when children get none
   * (hardening §3.4 / W3).
   *
   * `null` RATHER THAN A NO-OP FACTORY, so `subagent.ts` can spread NOTHING and
   * the child's loop gate tests a genuinely absent `contextManager` - the same
   * byte-identity argument `AgentController` makes for the lead (AC-H10).
   */
  childFactory(): ChildContextManagerFactory | null {
    if (!this.deps.getConfig().compaction.subagents) return null;
    return (req) =>
      createChildContextManager(req, {
        complete: (providerId, request) => this.getRegistry().complete(providerId, request),
        getConfig: this.deps.getConfig,
        hasKey: this.deps.hasKey,
        getApiKey: this.deps.getApiKey,
        getModelInfoFor: this.deps.getModelInfoFor,
        isPricedModel: this.deps.isPricedModel,
        // A CHILD'S COMPACTION SPEND JOINS THE SESSION TOTALS THROUGH THE LEAD'S
        // SINK (AC-H12). It is real money on the summarizer's price table, and a
        // background repair inside a background worker is exactly the spend a
        // user would otherwise never see.
        onUsage: (usage) => this.emit({ type: 'usage', usage }),
      });
  }

  // -----------------------------------------------------------------------
  // The manual queue (§4.4)
  // -----------------------------------------------------------------------

  queueManual(instructions?: string): void {
    this.compactor.queueManual(instructions);
  }

  hasPendingManual(): boolean {
    return this.compactor.hasPendingManual();
  }

  clearPendingManual(): void {
    this.compactor.clearPendingManual();
  }

  /**
   * The IDLE `/compact` path (§4.4 / D-25).
   *
   * IT VALIDATES BEFORE IT SPLICES, AND THAT IS NOT OPTIONAL (P1-7). When the
   * agent is idle there is no loop, so §3.3 step 5 does not run — and the only
   * way to replace the history is `Agent.replaceMessages`, which validates
   * nothing. D-4 declares that gate unbypassable and R-2 calls an invalid splice
   * the worst possible outcome, so this path mirrors the engine's steps 3-5
   * exactly, INCLUDING the failure vocabulary: the card, the log and
   * `/compact status` cannot tell the two paths apart.
   *
   * No watchdog handling is needed — `runLoopWithLifecycle`'s `finally` already
   * called `watchdog.stop()`, so nothing is armed while idle.
   *
   * ITS CALLER MUST ADOPT `messages` — THE ARCHIVE IS ALREADY WRITTEN BY THE
   * TIME THIS RETURNS (hardening RV-7). This path settles `applied: true` here,
   * one statement before the caller splices, so the "never archive a live
   * history" rule holds only because that caller applies unconditionally. That is
   * a fact about one call site rather than an invariant, which is why it is
   * written down where it can be checked.
   */
  async compactNow(args: {
    messages: readonly Message[];
    systemPrompt: string;
    model: ModelRef;
    signal: AbortSignal;
    lastUsage?: TokenUsage;
    instructions?: string;
  }): Promise<{ ok: true; messages: Message[] } | { ok: false; reason: string }> {
    this.compactor.queueManual(args.instructions);
    // BOTH SIDES FROM CORE'S OWN ESTIMATOR, exactly as the in-loop path gets them
    // from `compaction_end` (§5.1). There is no engine event here to supply them,
    // and the two numbers are the card's headline claim ("118.4k -> 23.1k") and
    // the input to `tokensReclaimed`: a `tokensAfter` of 0 would render a
    // compaction that freed the entire window and inflate the session total by
    // the whole occupancy. Two figures produced by one function are comparable;
    // a measured "before" against a zeroed "after" is not.
    const tokensBefore = estimatePromptTokens(args.messages as Message[], args.systemPrompt);
    const outcome = await this.compactor.compact({
      messageCount: args.messages.length,
      turnIndex: 0,
      trigger: 'pressure',
      ...(args.lastUsage ? { lastUsage: args.lastUsage } : {}),
      messages: args.messages,
      systemPrompt: args.systemPrompt,
      model: args.model,
      signal: args.signal,
    });

    // NOTHING CHANGED, so "after" IS "before" — the same thing the engine reports
    // when it refuses a splice.
    if (outcome.action !== 'replace') {
      this.settlePending({
        applied: false,
        reason: outcome.reason,
        tokensBefore,
        tokensAfter: tokensBefore,
      });
      return { ok: false, reason: outcome.reason };
    }

    const check = validateHistory(outcome.messages, { previousLength: args.messages.length });
    if (!check.ok) {
      const reason = `invalid_history: ${check.reason}`;
      this.settlePending({ applied: false, reason, tokensBefore, tokensAfter: tokensBefore });
      return { ok: false, reason };
    }

    this.settlePending({
      applied: true,
      tokensBefore,
      tokensAfter: estimatePromptTokens(outcome.messages, args.systemPrompt),
    });
    return { ok: true, messages: outcome.messages };
  }

  // -----------------------------------------------------------------------
  // Status and events
  // -----------------------------------------------------------------------

  snapshot(): CompactionSnapshot {
    const pressure =
      this.compactor.lastMeasured() ??
      this.compactor.measure({
        messages: this.deps.getMessages(),
        systemPrompt: this.deps.getSystemPrompt(),
      });
    return this.snapshotWith(pressure);
  }

  /**
   * `snapshot()` with the pressure argument substituted for the re-measurement.
   *
   * SO THE CHECKPOINT DOES NOT MEASURE TWICE. `shouldCompact` has already walked
   * the appended slice; measuring again here would double the one cost DH-15
   * accepted, and - worse - the second measurement could differ from the one the
   * decision was made on if anything appended in between.
   */
  private snapshotWith(pressure: Pressure): CompactionSnapshot {
    const totals = this.compactor.sessionTotals();
    const summarizer = this.compactor.resolveSummarizer();
    return {
      live: this.enabled && summarizer !== null,
      model: summarizer?.ref.modelId ?? '',
      compactions: totals.compactions,
      // OMITTED WHEN ZERO (quiet-noop D-9), so a healthy session's snapshot is
      // shaped exactly as it was before this feature and `/compact status` has
      // nothing extra to render.
      ...(totals.declined > 0 ? { declined: totals.declined } : {}),
      tokensReclaimed: totals.tokensReclaimed,
      usage: totals.usage,
      pricingUnknown: totals.pricingUnknown,
      inFlight: totals.inFlight,
      selfDisabled: totals.selfDisabled,
      ...(totals.selfDisabledReason ? { selfDisabledReason: totals.selfDisabledReason } : {}),
      generation: totals.generation,
      pressure,
    };
  }

  /** The summarizer that would be used right now, for `/compact status`. */
  summarizerRef(): ModelRef | null {
    return this.compactor.resolveSummarizer()?.ref ?? null;
  }

  subscribe(listener: CompactionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * The transport one summarization call goes through - separate from the lead's,
   * and fail-fast (D-10).
   *
   * LAZY, SO OFF STAYS BYTE-IDENTICAL. Nothing is constructed until a compaction
   * actually calls, so a session that never crosses the threshold allocates no
   * registry and registers no adapters.
   */
  private getRegistry(): ProviderRegistry {
    if (this.registry === null) {
      const create = this.deps.createRegistry ?? initProviders;
      this.registry = create({ retryPolicy: COMPACTION_RETRY_POLICY });
      this.log.info('compaction_registry_created', {
        maxRetries: COMPACTION_RETRY_POLICY.maxRetries,
      });
    }
    return this.registry;
  }

  private onCompactorEvent(event: CompactionEvent): void {
    if (event.type === 'compaction_start') {
      this.open = { index: event.index, trigger: event.trigger, model: event.model };
      this.pending = null;
      this.emit(event);
      return;
    }
    if (event.type === 'compaction_end') {
      // DROPPED WHEN THE CARD IS ALREADY CLOSED. An abort or the engine's hard
      // ceiling settles the card from the verdict alone, and this record is what
      // arrives afterwards, when `compact()` finally unwinds; emitting it would
      // open a second card for a compaction the user has already been told about.
      if (!this.open) return;
      // Otherwise HELD, NOT FORWARDED. `applied` is the engine's verdict and has
      // not happened yet; forwarding an optimistic record would settle the card
      // with a claim the structural gate may be about to refuse.
      this.pending = event.record;
      return;
    }
    this.emit(event);
  }

  private onAgentEvent(event: AgentEvent): void {
    if (event.type === 'agent_start') {
      this.compactor.onRunStart();
      return;
    }
    if (event.type === 'turn_end') {
      // The calibration offset, re-measured every turn (D-23). Read the history
      // AFTER the turn's assistant message is pushed? No: `turn_end` is emitted
      // BEFORE the push, so this is exactly the history the reported `usage`
      // was measured against, which is what makes the difference meaningful.
      this.compactor.onTurnEnd(event.usage, this.deps.getMessages(), this.deps.getSystemPrompt());
      // The gauge and the trigger read one function (R-11 / AC-3), so the
      // snapshot's pressure is refreshed from the same measurement the status bar
      // is about to render.
      this.compactor.measure({
        lastUsage: event.usage,
        messages: this.deps.getMessages(),
        systemPrompt: this.deps.getSystemPrompt(),
      });
      this.emit({ type: 'snapshot', snapshot: this.snapshot() });
      return;
    }
    if (event.type === 'compaction_end') {
      this.settlePending({
        applied: event.applied,
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        tokensBefore: event.estimatedTokensBefore,
        tokensAfter: event.estimatedTokensAfter,
      });
    }
  }

  /**
   * Settle the held record with the authoritative verdict, then emit it.
   *
   * `tokensBefore` / `tokensAfter` come from CORE'S OWN estimator on BOTH sides
   * (§5.1), so the card's headline claim compares two numbers in one unit rather
   * than a measurement against a guess. `tokensReclaimed` is accumulated from the
   * same pair, which is what keeps `/compact status` and the card agreeing.
   */
  private settlePending(verdict: {
    applied: boolean;
    reason?: string;
    tokensBefore?: number;
    tokensAfter: number;
  }): void {
    // `?? skeletonRecord()` IS THE ABORT PATH, not padding. See `open` above: the
    // engine's verdict can land while `compact()` is still unwinding, and a card
    // that never settles re-renders the tail on every frame for the rest of the
    // session. A skeleton settle can only ever carry `applied: false` — the
    // engine cannot report `true` without a `replace` outcome, which means the
    // compactor's own record already exists — so its zeroed counts are never
    // rendered.
    const record = this.pending ?? this.skeletonRecord();
    this.pending = null;
    this.open = null;
    // CALLED ON EVERY VERDICT AND DISCARDED ON THE ONES THAT DO NOT ARCHIVE
    // (RV-3). `takeLastDropped` releases the reference as it returns it, so this
    // one line is what guarantees the dropped history cannot outlive one
    // compaction no matter which branch the verdict took - including the early
    // `return` below.
    const dropped = this.compactor.takeLastDropped();
    if (!record) {
      // A SILENT DECLINE (quiet-noop §3.6). No card - but the gauge and the chip
      // are still refreshed: `inFlight` has just gone false and `/compact status`
      // reads this same snapshot, which is where the `declined` count surfaces.
      // `snapshot()` uses the CACHED pressure (`compactor.lastMeasured()`), so
      // this costs no re-measurement, and guard 4 caps the number of declines per
      // session at `stuckLimit`.
      this.emit({ type: 'snapshot', snapshot: this.snapshot() });
      return;
    }

    const settled: CompactionRecord = {
      ...record,
      applied: verdict.applied,
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      ...(verdict.tokensBefore !== undefined ? { tokensBefore: verdict.tokensBefore } : {}),
      tokensAfter: verdict.tokensAfter,
      mode: verdict.applied ? record.mode : 'none',
    };
    if (verdict.applied) {
      this.compactor.recordApplied(settled.tokensBefore, settled.tokensAfter);
      // SITE 1 OF THE FOUR INVALIDATION SITES (hardening §3.2.3). The in-loop
      // splice replaced the history, so every recorded index means nothing; the
      // manual path settles through here too, so one call covers both.
      this.compactor.invalidateMeasurement();
      const path = this.archive(settled, dropped);
      if (path) settled.archivePath = path;
    }
    this.emit({ type: 'compaction_end', record: settled });
    this.emit({ type: 'snapshot', snapshot: this.snapshot() });
  }

  /**
   * Write the archive, if there is one to write (hardening §3.5.3 / W4).
   *
   * ONLY ON `applied: true`, because the rule the writer enforces is "never
   * archive a history that is still live" - and the two paths reach that verdict
   * at different moments relative to the splice. In loop, the ENGINE decides
   * after `validateHistory`, so this runs AFTER adoption. On the manual path the
   * WIRING decides and `compactNow`'s caller adopts on the next statement, so
   * this runs BEFORE adoption; `compactNow`'s doc comment carries that obligation
   * for its one caller (RV-7).
   *
   * BEST-EFFORT AND SYNCHRONOUS-BUT-GUARDED. `writeArchive` never throws and
   * logs its own failure; a failed archive never affects the compaction, and it
   * never notifies - a toast for a best-effort audit file trains users to ignore
   * toasts.
   */
  private archive(record: CompactionRecord, dropped: Message[] | null): string | null {
    if (!this.deps.getConfig().compaction.archive) return null;
    // A RELIEF-ONLY COMPACTION DROPS NOTHING AND IS STILL ARCHIVED, which is why
    // `mode` is `summarized | truncated | relieved` in §3.5.2's document rather
    // than the first two. `/compact history` numbers its rows by COMPACTION
    // INDEX, so skipping this one leaves a hole at exactly the index a user
    // investigating a clipped tail would ask for, and `/compact show <n>` answers
    // "no archive" for the compaction that damaged their data (AC-H9).
    //
    // ANY OTHER VERDICT WITH NO RETAINED SLICE was compacted while the key was
    // off and genuinely has nothing to record - writing `droppedCount: 0` for it
    // would claim a splice dropped nothing when it dropped a hundred messages.
    if (!dropped && record.mode !== 'relieved') return null;
    return writeArchive({
      runId: this.runId,
      index: record.index,
      trigger: record.trigger,
      mode: record.mode,
      model: record.model,
      generation: this.compactor.sessionTotals().generation,
      tokensBefore: record.tokensBefore,
      tokensAfter: record.tokensAfter,
      messagesBefore: record.messagesBefore,
      messagesAfter: record.messagesAfter,
      ...(record.summary !== undefined ? { summary: record.summary } : {}),
      ...(record.tailRelief ? { tailRelief: record.tailRelief } : {}),
      dropped: dropped ?? [],
      ...(this.deps.archiveDir ? { dir: this.deps.archiveDir } : {}),
    });
  }

  /** This run's archive key, for `/compact history` and `/compact show`. */
  archiveRunId(): string {
    return this.runId;
  }

  /**
   * The minimum a card needs to settle when the compactor's own record has not
   * arrived (see `open`). `null` when no card was ever opened — the
   * `shouldCompact`-threw path, where the engine emits a pair of events the CLI
   * stream knows nothing about.
   */
  private skeletonRecord(): CompactionRecord | null {
    if (!this.open) return null;
    return {
      index: this.open.index,
      trigger: this.open.trigger,
      mode: 'none',
      applied: false,
      messagesBefore: 0,
      messagesAfter: 0,
      tokensBefore: 0,
      tokensAfter: 0,
      model: this.open.model,
      durationMs: 0,
    };
  }

  private emit(event: CompactionEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One bad subscriber must not take the run down with it - the rule
        // `TeamRuntime.emit` and `FastWiring.emit` both already state.
      }
    }
  }
}
