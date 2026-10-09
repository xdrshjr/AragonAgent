/** Threshold-authorized compaction with host-owned, append-only task memory. */
import type { ModelRole } from '../config/model-profiles.js';
import {
  planCompaction, estimatePromptTokens, CONTEXT_SAFETY_MARGIN_TOKENS,
  type Message, type ModelInfo, type ModelRef, type TokenUsage,
  type AssistantMessage, type CompactionContext, type CompactionOutcome,
  type CompactionProbe, type ContextManager, type LLMRequest,
} from '@aragon-agent/core';
import type { CliConfig } from '../config/schema.js';
import type { NoticeLevel } from '../agent/reducer.js';
import { getLogger } from '../logging/logger.js';
import { computeCost } from '../agent/usage.js';
import { resolveFastTier } from '../fast/resolve.js';
import { COMPACTION_LIMITS } from './limits.js';
import { buildDigest } from './digest.js';
import { buildCompactedBlock, countProtectedPrefix } from './summary-prompt.js';
import { accumulateUsage, errorText, runSummarizeCall, buildSummarizeRequest } from './summarize-call.js';
import { shouldCompactAt } from './pressure.js';
import { ContextMeter } from './meter.js';
import { CompactionOperation } from './operation.js';
import { prepareMemoryInput, type PreparedMemoryInput } from './memory-input.js';
import { mergeMemory, parseMemoryDelta, type CompactionMemory } from './memory.js';
import { validateMemoryDelta } from './memory-validation.js';
import { renderMemoryMarkdown } from './memory-render.js';
import {
  createCompactionIdentity, verifyCompactionIdentity, type CompactionIdentity,
} from './memory-identity.js';
import type { CompactionEvent, CompactionRecord, CompactionUiTrigger, Pressure } from './types.js';
export interface CompactorDeps {
  mainRole?: ModelRole;
  resolveFastCandidate?: () => ReturnType<typeof resolveFastTier>;
  /** Read LIVE on every call — the controller replaces the object on mutation. */
  getConfig: () => CliConfig;
  hasKey: (providerId: string, role?: ModelRole) => boolean;
  getApiKey: (providerId: string, role?: ModelRole) => string | undefined;
  /**
   * The engine's live history and system prompt.
   *
   * `shouldCompact` NEEDS THEM, and that is the whole reason they are here.
   * `CompactionProbe` carries `messageCount` but not the messages — the port is
   * synchronous and cheap by design (D-3) — so the ESTIMATE fallback (§3.4.2)
   * has nothing to measure unless the host supplies it. Estimating over an empty
   * array yields 0 %, which is exactly the naive answer §3.4.2 exists to reject:
   * the first request of a resumed 180 k-token session is the most dangerous
   * moment in this feature's life, `lastUsage` is `undefined` there by
   * definition, and a trigger that reads 0 % never fires.
   *
   * LAZY, and they must be: the wiring is constructed BEFORE the `Agent` (C-12),
   * so a closure that touches it is only valid from inside a call the loop makes.
   */
  getMessages: () => readonly Message[];
  getSystemPrompt: () => string;
  /** `ModelInfo` for ANY model, so the summarizer's own window and price resolve. */
  getModelInfoFor: (ref: Pick<ModelRef, 'providerId' | 'modelId'>) => ModelInfo;
  isPricedModel: (ref: Pick<ModelRef, 'providerId' | 'modelId'>) => boolean;
  /** The compactor's OWN fail-fast transport (D-10). Supplied by the wiring. */
  complete: (providerId: string, request: LLMRequest) => Promise<AssistantMessage>;
  emit: (event: CompactionEvent) => void;
  notify: (level: NoticeLevel, text: string) => void;
  /**
   * The ONE owner of occupancy measurement (context-usage-gauge-accuracy W1).
   *
   * THE COMPACTOR NO LONGER MEASURES. It used to hold `estimateOffset`,
   * `measuredPrefixLength` and `lastPressure` itself, which locked the only
   * measuring code in the process behind `compaction.enabled` - and a session
   * that turned compaction OFF is exactly the one whose gauge then had a single
   * sample per turn and nothing else. Reading a meter the controller owns makes
   * "the trigger and the gauge read one number" a STRUCTURAL fact rather than a
   * discipline (§3.3).
   *
   * OPTIONAL SO EVERY EXISTING CONSTRUCTION SITE COMPILES (R-1), and lazily
   * replaced by a private one built from the deps already here. PRODUCTION MUST
   * INJECT: `context-gauge-wiring.test.ts` asserts one instance per process
   * (`controller.getContextMeter()` is the same object the wiring forwards), and
   * two meters in one session means two answers to one question.
   */
  meter?: ContextMeter;
  /**
   * Publish the occupancy this checkpoint measured (hardening §3.2.4 / DH-15).
   *
   * REPORTING IS NOT A SIDE EFFECT OF DECIDING; it is the other half of R-11.
   * `shouldCompact` measures ONCE, ABOVE the guards, and calls this
   * unconditionally on every enabled checkpoint - so the gauge and the trigger
   * keep reading one number even on the turns a guard declines to compact.
   * Optional, so a `Compactor` built without a UI (the child manager, W3) passes
   * nothing and the call is one `?.` per turn.
   */
  onPressure?: (pressure: Pressure) => void;
}

/** Per-instance bounds a child manager tightens (hardening §3.4.2 mechanism B). */
export interface CompactorOptions {
  /**
   * Guard 2's ceiling for THIS compactor.
   *
   * A FIELD RATHER THAN A DIRECT `COMPACTION_LIMITS` READ, because a child gets a
   * tighter one (W3 / DH-6) and `maxPerRun` is STRUCTURAL, not policy - there is
   * no config path to it by design (`limits.ts` header). Defaults to the lead's
   * value, so every existing construction site is unchanged.
   */
  maxPerRun?: number;
}

/** The summarizer the next compaction would use. */
export interface SummarizerChoice {
  role: ModelRole;
  ref: ModelRef;
  /** Whether the fast tier supplied it, for `/compact status` and the card. */
  fromFastTier: boolean;
}

interface PendingManual {
  requestId: number;
  instructions?: string;
  historyEpoch: number;
}

interface StagedOperation {
  operation: CompactionOperation;
  epoch: number;
  settings: string;
  trigger: CompactionUiTrigger;
  pressure: Pressure;
  threshold: number;
  started: number;
  messages: readonly Message[];
  index?: number;
  model: string;
  candidate?: Message[];
  generation?: number;
  reason?: string;
}

export class Compactor implements ContextManager {
  private readonly log = getLogger().child('compaction');
  private compactionsThisRun = 0;
  private lastCompactionTurn = -Infinity;
  private compactions = 0;
  private declined = 0;
  private tokensReclaimed = 0;
  private sessionUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private pricingUnknown = false;
  private costUsd = 0;
  private consecutiveNoProgress = 0;
  private selfDisabled = false;
  private selfDisabledReason: string | undefined;
  private pendingManual: PendingManual | null = null;
  private generation = 0;
  private ownMeter: ContextMeter | null = null;
  private lastDropped: Message[] | null = null;
  private active: StagedOperation | null = null;
  private historyEpoch = 0;
  private serial = 0;
  private identity: CompactionIdentity | undefined;
  private legacyFailureNotified = false;
  private readonly maxPerRun: number;

  constructor(private readonly deps: CompactorDeps, opts?: CompactorOptions) {
    this.maxPerRun = opts?.maxPerRun ?? COMPACTION_LIMITS.maxPerRun;
  }

  onRunStart(): void {
    this.compactionsThisRun = 0;
    this.lastCompactionTurn = -Infinity;
  }

  onRunEnd(): void { this.clearPendingManual(); }

  onTurnEnd(usage: TokenUsage, _messages: readonly Message[], _systemPrompt: string): void {
    this.meter().onTurnEnd(usage);
  }

  onHistoryReplaced(identity?: CompactionIdentity): void {
    this.historyEpoch += 1;
    this.clearPendingManual();
    this.abort();
    this.identity = identity;
    this.generation = identity && verifyCompactionIdentity(this.deps.getMessages(), identity)
      ? identity.generation : 0;
    this.meter().onHistoryReplaced();
  }

  getIdentity(): CompactionIdentity | undefined { return this.identity; }

  takeLastDropped(): Message[] | null {
    const dropped = this.lastDropped;
    this.lastDropped = null;
    return dropped;
  }

  abort(): void {
    this.clearPendingManual();
    this.active?.operation.abort();
  }

  queueManual(instructions?: string): void {
    if ((instructions?.length ?? 0) > COMPACTION_LIMITS.instructionsChars) throw new Error('instructions_too_large');
    if (this.active) {
      this.deps.notify('info', 'Compaction is already running.');
      return;
    }
    if (this.pendingManual) this.deps.notify('info', 'Updated queued compaction request.');
    this.pendingManual = { requestId: ++this.serial, historyEpoch: this.historyEpoch,
      ...(instructions ? { instructions } : {}) };
  }

  hasPendingManual(): boolean { return this.pendingManual !== null; }
  clearPendingManual(): void { this.pendingManual = null; }

  shouldCompact(probe: CompactionProbe): boolean {
    const config = this.deps.getConfig().compaction;
    if (!config.enabled) return false;
    const pressure = this.meter().current();
    this.deps.onPressure?.(pressure);
    if (this.active) return false;
    if (this.compactionsThisRun >= this.maxPerRun) {
      if (this.pendingManual) {
        this.clearPendingManual();
        this.deps.notify('warn', 'Compaction limit reached for this run.');
      }
      return false;
    }
    if (this.pendingManual?.historyEpoch === this.historyEpoch) return true;
    if (this.selfDisabled || !shouldCompactAt(pressure, config.threshold)) return false;
    return probe.trigger === 'overflow' ||
      probe.turnIndex - this.lastCompactionTurn >= COMPACTION_LIMITS.minTurnsBetween;
  }

  async compact(ctx: CompactionContext): Promise<CompactionOutcome> {
    if (this.active) return { action: 'keep', reason: 'already_running' };
    const manual = this.pendingManual;
    this.pendingManual = null;
    const state: StagedOperation = {
      operation: new CompactionOperation(++this.serial, ctx.signal, COMPACTION_LIMITS.operationTimeoutMs),
      epoch: this.historyEpoch, settings: this.settingsKey(),
      trigger: manual ? 'manual' : ctx.trigger, pressure: this.meter().current(),
      threshold: this.deps.getConfig().compaction.threshold,
      started: Date.now(), messages: [...ctx.messages], model: '',
    };
    this.active = state;
    this.compactionsThisRun += 1;
    this.lastCompactionTurn = ctx.turnIndex;
    try {
      if (state.operation.signal.aborted) throw new Error('aborted');
      return await this.prepareCandidate(state, ctx, manual?.instructions);
    } catch (error) {
      return this.keep(state, errorText(error));
    }
  }

  private async prepareCandidate(
    state: StagedOperation, ctx: CompactionContext, instructions?: string,
  ): Promise<CompactionOutcome> {
    const config = this.deps.getConfig().compaction;
    if (this.identity && !verifyCompactionIdentity(state.messages, this.identity)) {
      return this.keep(state, 'invalid_prior_memory');
    }
    const plan = planCompaction(state.messages, {
      keepRecentTurns: config.keepRecentTurns,
      protectedPrefix: countProtectedPrefix(state.messages, this.identity),
    });
    if (!plan) return this.keep(state, 'nothing_to_drop');
    const input = prepareMemoryInput({ messages: state.messages, cutIndex: plan.cutIndex,
      ...(this.identity ? { identity: this.identity } : {}) });
    const selected = this.selectInput(input, instructions);
    this.checkMinimumCandidate(input, selected.digest, state, ctx.systemPrompt);
    const memory = await this.summarize(state, input, selected, instructions);
    if (!this.isCurrent(state, ctx)) return this.keep(state, 'stale_history');
    const block = buildCompactedBlock({ memory, replaced: input.cutIndex,
      turns: input.tail.filter((m) => m.role === 'user').length,
      anchor: input.anchorShape, generation: memory.generation, truncated: false });
    const candidate = [input.anchor, block, ...input.tail];
    this.checkCandidate(candidate, state, ctx.systemPrompt);
    state.candidate = candidate;
    state.generation = memory.generation;
    if (config.archive) this.lastDropped = state.messages.slice(0, input.cutIndex);
    const summary = renderMemoryMarkdown(memory);
    this.finishRecord(state, { action: 'replace', mode: 'summarized', messages: candidate }, summary);
    return { action: 'replace', mode: 'summarized', messages: candidate, summary };
  }

  private selectInput(input: PreparedMemoryInput, instructions?: string): {
    choice: SummarizerChoice; digest: ReturnType<typeof buildDigest>;
  } {
    const choice = this.resolveSummarizer();
    if (!choice) throw new Error('no_summarizer_model');
    try { return { choice, digest: this.digestFor(input, choice, instructions) }; }
    catch (error) {
      if (!choice.fromFastTier || !errorText(error).includes('digest_budget_exceeded')) throw error;
      const main = this.mainChoice();
      return { choice: main, digest: this.digestFor(input, main, instructions) };
    }
  }

  private checkMinimumCandidate(
    input: PreparedMemoryInput, digest: ReturnType<typeof buildDigest>,
    state: StagedOperation, systemPrompt: string,
  ): void {
    const memory: CompactionMemory = {
      schemaVersion: 2, generation: input.generation,
      originalTask: { sourceId: input.originalTaskSourceId, location: 'anchor' },
      userMessages: input.userMessages, items: input.prior?.items ?? [],
      ...(input.legacySummary ? { legacySummary: input.legacySummary } : {}),
      coverage: {
        summarizedMessages: (input.prior?.coverage.summarizedMessages ?? 0) +
          digest.coverage.summarizedMessages,
        clippedToolResults: [...(input.prior?.coverage.clippedToolResults ?? []),
          ...digest.coverage.clippedToolResults],
        legacyIncomplete: !!input.prior?.coverage.legacyIncomplete || !!input.legacySummary,
      },
    };
    const block = buildCompactedBlock({ memory, replaced: input.cutIndex,
      turns: input.tail.filter((message) => message.role === 'user').length,
      anchor: input.anchorShape, generation: input.generation });
    this.checkCandidate([input.anchor, block, ...input.tail], state, systemPrompt);
  }

  private digestFor(
    input: PreparedMemoryInput, choice: SummarizerChoice, instructions?: string,
  ): ReturnType<typeof buildDigest> {
    const window = this.deps.getModelInfoFor(choice.ref).contextWindow;
    const digest = buildDigest({ head: input.head, anchor: input.anchor, generation: input.generation,
      startIndex: input.headStartIndex, summarizerWindow: window,
      ...(input.prior ? { priorMemory: input.prior } : {}),
      ...(input.legacySummary ? { legacySummary: input.legacySummary } : {}) });
    const request = buildSummarizeRequest({ ref: choice.ref, apiKey: '', digest: digest.text,
      hasPriorSummary: !!input.prior, signal: new AbortController().signal, now: 0,
      ...(instructions ? { instructions } : {}) });
    if (estimatePromptTokens(request.messages, request.systemPrompt) +
        COMPACTION_LIMITS.summaryOutputTokens + CONTEXT_SAFETY_MARGIN_TOKENS >= window) {
      throw new Error('digest_budget_exceeded');
    }
    return digest;
  }

  private async summarize(
    state: StagedOperation, input: PreparedMemoryInput,
    selected: ReturnType<Compactor['selectInput']>, instructions?: string,
  ): Promise<CompactionMemory> {
    let choice = selected.choice;
    let digest = selected.digest;
    let previousError: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (state.operation.signal.aborted) throw new Error('aborted');
      if (attempt > 0) {
        choice = this.mainChoice();
        digest = this.digestFor(input, choice, instructions);
      }
      const text = await this.callOnce(state, choice, {
        digest: digest.text, hasPriorSummary: !!input.prior,
        ...(instructions ? { instructions } : {}),
        ...(previousError ? { validationError: previousError } : {}),
      }).catch((error: unknown) => { previousError = errorText(error); return null; });
      if (state.operation.signal.aborted) throw new Error(previousError ?? 'aborted');
      if (text === null) continue;
      try {
        const delta = parseMemoryDelta(text);
        validateMemoryDelta(delta, { sourceMap: digest.sourceMap, prior: input.prior,
          hasSummarizableMessages: digest.coverage.summarizedMessages > 0 });
        return mergeMemory({ input, delta, sourceMap: digest.sourceMap, coverage: digest.coverage });
      } catch (error) {
        previousError = errorText(error);
        if (!/invalid_memory_delta|empty_memory_delta/.test(previousError)) throw error;
      }
    }
    throw new Error(previousError ?? 'invalid_memory_delta');
  }

  private async callOnce(
    state: StagedOperation, choice: SummarizerChoice,
    input: { digest: string; hasPriorSummary: boolean; instructions?: string; validationError?: string },
  ): Promise<string> {
    const apiKey = this.deps.getApiKey(choice.ref.providerId, choice.role);
    if (!apiKey) throw new Error('no_api_key');
    this.announce(state, choice);
    const outcome = await state.operation.run(() => runSummarizeCall({
      ...input, ref: choice.ref, apiKey, signal: state.operation.signal, now: Date.now(),
      complete: (providerId, request) => this.deps.complete(providerId, request),
      onTimeout: () => state.operation.abort('timeout'),
      onUsage: (usage) => this.noteUsage(choice.ref, usage),
    }), COMPACTION_LIMITS.callTimeoutMs);
    if (!outcome.ok) throw outcome.error;
    return outcome.text;
  }

  private checkCandidate(
    candidate: Message[], state: StagedOperation, systemPrompt: string,
  ): void {
    const before = estimatePromptTokens([...state.messages], systemPrompt);
    const after = estimatePromptTokens(candidate, systemPrompt);
    if (candidate.length > state.messages.length || after >= before) {
      throw new Error('no_token_reclaim');
    }
    if (after + Math.max(0, state.pressure.estimateOffset ?? 0) >=
        state.pressure.contextWindow - CONTEXT_SAFETY_MARGIN_TOKENS) {
      throw new Error('protected_memory_too_large');
    }
  }

  private isCurrent(state: StagedOperation, ctx: CompactionContext): boolean {
    return this.active === state && state.epoch === this.historyEpoch &&
      state.settings === this.settingsKey() && !ctx.signal.aborted &&
      !state.operation.signal.aborted;
  }

  private announce(state: StagedOperation, choice: SummarizerChoice): void {
    state.model = choice.ref.modelId;
    if (state.index !== undefined) return;
    state.index = ++this.compactions;
    this.deps.emit({ type: 'compaction_start', index: state.index,
      trigger: state.trigger, model: state.model });
  }

  private keep(state: StagedOperation, reason: string): CompactionOutcome {
    state.reason = reason;
    const outcome: CompactionOutcome = { action: 'keep', reason };
    if (this.active !== state) return outcome;
    this.finishRecord(state, outcome);
    if (state.trigger === 'manual') this.deps.notify('warn', `History preserved: ${reason}.`);
    if (this.deps.getConfig().compaction.onFailure === 'truncate' && !this.legacyFailureNotified) {
      this.legacyFailureNotified = true;
      this.deps.notify('info', 'Legacy truncate configuration: preserving history on failure.');
    }
    return outcome;
  }

  private finishRecord(
    state: StagedOperation, outcome: CompactionOutcome, summary?: string,
  ): void {
    if (this.active !== state) return;
    if (state.index === undefined) { this.declined += 1; return; }
    const p = state.pressure;
    const record: CompactionRecord = {
      index: state.index, trigger: state.trigger,
      mode: outcome.action === 'replace' ? 'summarized' : 'none', applied: false,
      ...(outcome.action === 'keep' ? { reason: outcome.reason } : {}),
      messagesBefore: state.messages.length,
      messagesAfter: outcome.action === 'replace' ? outcome.messages.length : state.messages.length,
      tokensBefore: p.occupied, tokensAfter: 0, model: state.model,
      durationMs: Date.now() - state.started, ...(summary ? { summary } : {}),
      memoryVersion: 2,
      decision: { occupied: p.occupied, contextWindow: p.contextWindow,
        threshold: state.threshold,
        source: p.source, deltaTokens: p.deltaTokens },
    };
    this.deps.emit({ type: 'compaction_end', record });
  }

  /** Commit only the engine/host verdict; candidates have no authority before this point. */
  settleOperation(verdict: {
    applied: boolean; reason?: string; tokensBefore?: number; tokensAfter: number;
  }): boolean {
    const state = this.active;
    if (!state || !state.operation.settle()) return false;
    this.active = null;
    if (verdict.applied && state.candidate) {
      this.identity = createCompactionIdentity(state.candidate);
      this.generation = state.generation ?? this.generation;
      this.recordApplied(verdict.tokensBefore ?? state.pressure.occupied, verdict.tokensAfter);
      this.meter().onHistorySpliced();
      const projected = (verdict.tokensAfter + (state.pressure.estimateOffset ?? 0)) /
        state.pressure.contextWindow;
      if (projected < this.deps.getConfig().compaction.threshold - COMPACTION_LIMITS.minReclaimRatio) {
        this.consecutiveNoProgress = 0;
      } else this.noteNoProgress(state.trigger, 'insufficient_reclaim');
    } else {
      const reason = verdict.reason ?? state.reason ?? 'invalid_history';
      if (!/abort|cancel|stale/.test(reason)) this.noteNoProgress(state.trigger, reason);
    }
    this.log.info('compaction_settled', {
      operationId: state.operation.id, trigger: state.trigger, applied: verdict.applied,
      generation: this.generation, messagesBefore: state.messages.length,
      messagesAfter: verdict.applied ? state.candidate?.length : state.messages.length,
      tokensBefore: verdict.tokensBefore, tokensAfter: verdict.tokensAfter,
      reason: (verdict.reason ?? state.reason)?.split(':', 1)[0]?.replace(/[^a-z_]/g, ''),
    });
    return true;
  }

  private noteNoProgress(trigger: CompactionUiTrigger, reason: string): void {
    if (trigger === 'manual') return;
    this.consecutiveNoProgress += 1;
    if (this.consecutiveNoProgress < COMPACTION_LIMITS.stuckLimit || this.selfDisabled) return;
    this.selfDisabled = true;
    this.selfDisabledReason = reason;
    this.deps.notify('warn', `Auto-compaction paused: ${reason}. History preserved. Use /compact.`);
  }

  measure(_probe: Pick<CompactionProbe, 'lastUsage'> & {
    messages?: readonly Message[]; systemPrompt?: string;
  }): Pressure { return this.meter().current(); }

  lastMeasured(): Pressure | null { return this.meter().lastPublished(); }

  recordApplied(tokensBefore: number, tokensAfter: number): void {
    this.tokensReclaimed += Math.max(0, tokensBefore - tokensAfter);
  }

  sessionTotals() {
    return { compactions: this.compactions, declined: this.declined,
      tokensReclaimed: this.tokensReclaimed, usage: this.sessionUsage, costUsd: this.costUsd,
      pricingUnknown: this.pricingUnknown, inFlight: this.active !== null,
      selfDisabled: this.selfDisabled, generation: this.generation,
      ...(this.selfDisabledReason ? { selfDisabledReason: this.selfDisabledReason } : {}) };
  }

  clearSelfDisable(): void {
    this.selfDisabled = false;
    this.selfDisabledReason = undefined;
    this.consecutiveNoProgress = 0;
  }

  isSelfDisabled(): boolean { return this.selfDisabled; }

  resolveSummarizer(): SummarizerChoice | null {
    const config = this.deps.getConfig();
    if (config.compaction.useFastTier) {
      const tier = this.deps.resolveFastCandidate?.() ?? resolveFastTier(config, this.deps.hasKey);
      if (tier.ok) return { ref: tier.ref, role: 'fast', fromFastTier: true };
    }
    const choice = this.mainChoice();
    return this.deps.hasKey(choice.ref.providerId, choice.role) ? choice : null;
  }

  private mainChoice(): SummarizerChoice {
    return { ref: this.mainRef(), role: this.deps.mainRole ?? 'main', fromFastTier: false };
  }

  private meter(): ContextMeter {
    if (this.deps.meter) return this.deps.meter;
    this.ownMeter ??= new ContextMeter({
      getMessages: this.deps.getMessages, getSystemPrompt: this.deps.getSystemPrompt,
      getModelInfo: () => this.deps.getModelInfoFor(this.mainRef()),
      isWindowKnown: () => {
        const source = this.deps.getModelInfoFor(this.mainRef()).contextWindowSource;
        return source === undefined ? this.deps.isPricedModel(this.mainRef()) : source !== 'fallback';
      },
      getWindowOverride: () => this.deps.getConfig().contextWindow,
    });
    return this.ownMeter;
  }

  private mainRef(): ModelRef {
    const config = this.deps.getConfig();
    return { providerId: config.provider, modelId: config.model,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) };
  }

  private settingsKey(): string {
    const config = this.deps.getConfig();
    return JSON.stringify([config.provider, config.model, config.baseUrl, config.compaction,
      this.deps.getSystemPrompt()]);
  }

  private noteUsage(ref: ModelRef, usage: TokenUsage): void {
    this.sessionUsage = accumulateUsage(this.sessionUsage, usage);
    const pricingUnknown = !this.deps.isPricedModel(ref);
    const costUsd = pricingUnknown ? 0 : computeCost(usage, this.deps.getModelInfoFor(ref).cost);
    if (pricingUnknown) this.pricingUnknown = true;
    this.costUsd += costUsd;
    this.deps.emit({ type: 'usage', usage, modelRef: ref, costUsd, pricingUnknown });
  }
}
