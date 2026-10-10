/**
 * FastReviewer — the periodic asynchronous review (fast-model-tier §3.5).
 *
 * ASCII ONLY: `src/fast/**` is inside the glyph scanner's scope.
 *
 * THE ENTIRE CLASS IS SHAPED AROUND *WHEN* IT IS ALLOWED TO SPEAK.
 * `Agent.steer()` pushes onto a queue that `runAgentLoop` drains at three
 * places, and only one of them is safe:
 *
 *   1  top of the loop, before the LLM call (`agent-loop.ts:126`) - pushed as a
 *      `user` message, conversation shape stays valid. SAFE.
 *   2  after the LLM call, before tool execution (`:199`) - `continue`, leaving
 *      the assistant's `tool_use` blocks with no `tool_result`. Anthropic then
 *      rejects the NEXT request with HTTP 400. HARD FAILURE.
 *   3  between two tool executions (`:214`) - every remaining call in the batch
 *      is replaced with "Tool execution skipped due to steering interrupt."
 *      SILENTLY DESTRUCTIVE.
 *
 * For a human pressing Enter mid-run, 2 and 3 are the DESIRED semantics. For an
 * unrequested background critique they are a defect generator whose symptoms
 * (an HTTP 400 about tool_result ids; work silently deleted) point nowhere near
 * the reviewer. So this class calls `steer()` from EXACTLY ONE PLACE: inside the
 * synchronous listener for the `tool_execution_end` that brings the batch to
 * zero. `Agent.emit()` runs listeners synchronously inside the loop
 * (`agent.ts:340`), the batch is finished, and the next `hasSteering()` the loop
 * evaluates is therefore checkpoint 1 (AC-20).
 *
 * AND STEERING IS NOT DELIVERY (§3.5.4a / RV-1 / D-19). `steer()` only enqueues;
 * `runLoopWithLifecycle`'s `finally` never clears the queues (`agent.ts:410`);
 * and the loop emits the batch's last `tool_execution_end` (`:249`) BEFORE it
 * re-tests the abort signal (`:271`). So an Esc landing inside the final tool's
 * `await` yields exactly the interleaving where the reviewer steers, the loop
 * breaks, and the block resurfaces in the user's NEXT conversation wearing the
 * user's role. Two guards close it:
 *
 *   guard 1  do not steer into a REQUESTED abort (`isAbortRequested`).
 *   guard 2  prove delivery. `awaitingDrain` is set on steer and cleared at the
 *            next `turn_start` - the loop cannot reach `turn_start` (`:136`)
 *            without having passed checkpoint 1 (`:126`), so `turn_start` IS the
 *            receipt. Still true at `agent_end` means the block was stranded.
 *
 * Guard 2 exists because the idle watchdog calls `Agent.abort()` DIRECTLY
 * (`watchdog.ts:15-17`), where no controller-level flag can see it (D-20) - and
 * the watchdog fires precisely on the long quiet runs where a review is most
 * likely to be pending.
 *
 * A future refactor that moves `steer()` into the `complete()` callback will
 * look tidier and will reintroduce all of the above.
 *
 * WHAT WAS SPLIT OUT, AND WHAT DELIBERATELY WAS NOT (hardening W3 / §3.3).
 * The turn-frame ring moved to `frames.ts` and the bounded call to
 * `review-call.ts`, both leaves. THE PROTOCOL STAYED HERE, WHOLE: the two drain
 * guards above (AC-H11) and the call-cancellation stamping - `callAbort`,
 * `callAbortReason`, `cancelCall()` and the one `new AbortController()`
 * (AC-H16). A split that puts half of either behind a module boundary is a
 * "simplification" that reopens a P0, and in the cancellation case it is round
 * 1's IF-7 verbatim; `review-call.ts`'s header states why.
 */

import type { AgentEvent, AssistantMessage, LLMRequest, TokenUsage } from '@aragon-agent/core';
import type { FastConfig } from '../config/schema.js';
import { getLogger } from '../logging/logger.js';
import type { NoticeLevel } from '../agent/reducer.js';
import { normalizeCritique } from './critique.js';
import { buildReviewDigest } from './digest.js';
import { TurnFrameRing } from './frames.js';
import { FAST_LIMITS } from './limits.js';
import { renderReviewInjection } from './prompt.js';
import {
  accumulateUsage,
  assistantText,
  classifyReviewFailure,
  errorText,
  runReviewCall,
  usageOf,
} from './review-call.js';
import type { FastEvent, FastReview, FastSnapshot, FastTier } from './types.js';

/**
 * Everything the reviewer needs from the rest of the world.
 *
 * ALL INJECTED, so `fast-reviewer.test.ts` can replay a scripted `AgentEvent`
 * sequence against a stub `complete` and assert the injection window without a
 * network, a terminal or an `Agent` (§8.1).
 */
export interface FastReviewerDeps {
  /** The LEAD agent's event stream, through `AgentController` (C-7). */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /**
   * `ProviderRegistry.complete` — bound since round 2 to `FastWiring`'s OWN
   * fail-fast registry, not to the lead's (W2 / §3.2). Nothing in this file
   * knows that, which is the whole reason the dep is injected.
   */
  complete(providerId: string, request: LLMRequest): Promise<AssistantMessage>;
  /** `AgentController.steer` - the ONLY writer of the queue besides the user. */
  steer(text: string): void;
  isRunning(): boolean;
  /** Guard 1: `AgentController.abort()` sets this synchronously BEFORE
   *  `agent.abort()`, so the reviewer can see an Esc that has not landed yet. */
  isAbortRequested(): boolean;
  /** Guard 2: user messages queued since the last `turn_start`. `0` is what
   *  makes `clearAllQueues()` provably safe (D-21). */
  userSteerCount(): number;
  clearAllQueues(): void;
  /** Re-read at EVERY use, never snapshot (RV-3). */
  getTier(): FastTier;
  getConfig(): FastConfig;
  /** `FastWiring.available()` - the live predicate of §3.3. */
  available(): boolean;
  getApiKey(providerId: string): string | undefined;
  emit(event: FastEvent): void;
  /**
   * `FastWiring.snapshot()`, so the self-disable can announce itself.
   *
   * The reviewer cannot build a `FastSnapshot` on its own — `live`,
   * `sameAsMain` and `pricingUnknown` all belong to the wiring —
   * and the two existing `tier_changed` emitters read it the same way.
   */
  snapshot(): FastSnapshot;
  notify(level: NoticeLevel, text: string): void;
  /** Injected clock. A test that reads the wall clock fails on a slow machine
   *  and nowhere else - the reason `TodoStore` and `TeamPanel` take one. */
  now?: () => number;
}

/** A critique that has an answer and is waiting for a window to say it in. */
interface PendingReview {
  runId: number;
  reviewIndex: number;
  /** The turn the critique is ABOUT, for the wrapper and the staleness test. */
  turn: number;
  text: string;
  model: string;
  at: number;
  durationMs: number;
  usage?: TokenUsage;
}

/**
 * Reasons a critique never reached the lead. All of them are reported (R-8).
 *
 * NOT EXTENDED FOR THE SESSION BUDGET (§3.1.3). All five members describe a
 * review that was in flight or pending; a review suppressed by the budget never
 * started, has no index, and gets a notice rather than a card.
 */
type DropReason = 'run_ended' | 'aborted' | 'stale_run' | 'stale_pending' | 'stranded';

export class FastReviewer {
  /** Scope `fast` since round 2 (W4): an unrequested background call is not one
   *  of the LEAD's records, and a support reader filtering `agent` wants those. */
  private readonly log = getLogger().child('fast');
  private readonly now: () => number;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  // --- Per-run state -----------------------------------------------------
  private runId = 0;
  /** The turn-frame ring (`frames.ts`). Owns `turns`, the open frame and the
   *  outstanding-call counter; decides nothing. */
  private readonly ring = new TurnFrameRing({ canRecord: () => this.canReviewAgain() });
  private inFlight = false;
  private pending: PendingReview | null = null;
  private reviewsThisRun = 0;
  /** Set on steer, cleared at the next `turn_start`. Guard 2's receipt. */
  private awaitingDrain = false;
  private awaitingReviewIndex = 0;
  /** The run's own abort channel for an in-flight `complete()`. */
  private callAbort: AbortController | null = null;
  /**
   * WHY the in-flight call was aborted - RECORDED here because it cannot be
   * recovered from the error: a timeout and a cancellation go through the same
   * `controller.abort()` and arrive as byte-identical bare `Error`s. The full
   * argument, and the prohibition it implies for `review-call.ts`, is in that
   * file's header; this field and `cancelCall()` are the halves it protects.
   */
  private callAbortReason: 'timeout' | 'cancelled' | null = null;

  // --- Per-session state -------------------------------------------------
  private goal = '';
  /**
   * Reviews STARTED this session. NEVER RESET (§3.1.1).
   *
   * This is BOTH the status line's numerator and the session budget's left-hand
   * side, on purpose: a parallel `reviewsThisSession` would be a second answer
   * to one question, and the first time the two drifted the product would print
   * `12/40` while suppressing at a number nobody can see.
   */
  private reviewIndex = 0;
  /** The limit at which exhaustion was last announced; `-1` = not announced.
   *  Keyed on the LIMIT, not on a boolean, so raising the budget re-arms the
   *  notice without a second latch to keep in sync (§3.1.3). */
  private budgetAnnouncedAt = -1;
  private consecutiveFailures = 0;
  private selfDisabled = false;
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(private readonly deps: FastReviewerDeps) {
    this.now = deps.now ?? Date.now;
    this.unsubscribe = deps.subscribe((event) => this.onAgentEvent(event));
  }

  // -----------------------------------------------------------------------
  // Public surface
  // -----------------------------------------------------------------------

  /** The user's request for this run, captured in `AgentController.prompt()`. */
  setGoal(text: string): void {
    this.goal = String(text ?? '').slice(0, FAST_LIMITS.goalChars);
  }

  /** Reviews STARTED this session, for `/fast status` and `FastSnapshot`. */
  reviewCount(): number {
    return this.reviewIndex;
  }

  /** The live session budget, read from config so `/fast budget <n>` takes
   *  effect on the next sealed frame with no restart. */
  budgetLimit(): number {
    return this.deps.getConfig().reviewMaxPerSession;
  }

  /** Carried on the snapshot rather than re-derived by callers (RV-H10). */
  isBudgetReached(): boolean {
    return this.reviewIndex >= this.budgetLimit();
  }

  sessionUsage(): TokenUsage {
    return { ...this.usage };
  }

  isReviewInFlight(): boolean {
    return this.inFlight;
  }

  /**
   * Whether this reviewer switched itself off after
   * `FAST_LIMITS.maxConsecutiveFailures` non-transient failures in a row.
   *
   * Carried onto `FastSnapshot` so a wrapper can say "the fast reviews stopped,
   * and here is why" instead of showing a tier that reads as healthy while not
   * one review ever arrives. Same shape as `reviewCount()` / `isBudgetReached()`
   * — a read-only accessor, no side effects.
   */
  isSelfDisabled(): boolean {
    return this.selfDisabled;
  }

  /**
   * `AgentController.abort()`.
   *
   * Aborts the in-flight call and drops `pending`. It MUST NOT clear
   * `awaitingDrain`: that flag is guard 2's receipt and is resolved only at
   * `turn_start` (delivered) or `agent_end` (stranded).
   */
  abort(): void {
    this.cancelCall();
    if (this.pending) this.dropPending('aborted');
  }

  /**
   * Cancel an in-flight review because nobody wants the answer any more.
   *
   * A CANCELLATION IS NOT A FAILURE (§3.5.5). The three callers - `endRun()`
   * (the run finished first), `abort()` (Esc) and `dispose()` - all mean "never
   * mind", and none of them is evidence of a MISCONFIGURED tier, which is the
   * only thing self-disable exists for (D-18 / D-24). Scoring them as strikes
   * silently killed the reviewer for the rest of a session over three ordinary
   * runs - the common shape, since a turn that answers without tools ends the
   * run - behind a warn quoting an internal stream message (IF-7).
   *
   * THE STAMP MUST HAPPEN HERE, BEFORE THE ABORT, AND THE CONTROLLER MUST STAY
   * REACHABLE FROM THIS METHOD (AC-H16).
   */
  private cancelCall(): void {
    if (!this.callAbort) return;
    this.callAbortReason = 'cancelled';
    this.callAbort.abort();
  }

  /** Idempotent. Unsubscribes as well as aborting. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // -----------------------------------------------------------------------
  // The event listener - SYNCHRONOUS, inside the core loop (C-7)
  // -----------------------------------------------------------------------

  private onAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.beginRun();
        break;
      case 'turn_start':
        this.onTurnStart();
        break;
      case 'message_update':
        this.ring.recordDelta(event.streamEvent);
        break;
      case 'tool_execution_start':
        this.ring.noteToolArgs(event.toolCallId, event.args);
        break;
      case 'turn_end':
        this.ring.endTurn(event.message);
        break;
      case 'tool_execution_end':
        this.onToolEnd(event.toolCallId, event.toolName, event.isError, event.duration);
        break;
      case 'agent_end':
        this.endRun();
        break;
      default:
        break;
    }
  }

  private beginRun(): void {
    // MINTED HERE, NOT READ FROM THE EVENT (RV-8): `agent_start` carries no
    // payload (`agent.ts:385`), so `runId` is a counter this class owns. Every
    // stale-result test compares against it.
    this.runId += 1;
    this.ring.reset();
    this.pending = null;
    // PER-RUN ONLY. `reviewIndex` and `budgetAnnouncedAt` are deliberately NOT
    // reset beside this: they are the session budget (§3.1.1), and tidying the
    // two counters into one reset silently removes it.
    this.reviewsThisRun = 0;
    this.awaitingDrain = false;
    this.awaitingReviewIndex = 0;
  }

  private onTurnStart(): void {
    // GUARD 2's RECEIPT. The loop cannot reach `turn_start` (`agent-loop.ts:136`)
    // without having passed checkpoint 1 (`:126`), so arriving here proves the
    // steered block was drained into the conversation.
    if (this.awaitingDrain) {
      this.log.debug('fast_review_delivered', { reviewIndex: this.awaitingReviewIndex });
      this.awaitingDrain = false;
      this.awaitingReviewIndex = 0;
    }
    this.ring.beginTurn();
  }

  private onToolEnd(
    toolCallId: string,
    toolName: string,
    isError: boolean,
    duration: number,
  ): void {
    const batchEmpty = this.ring.endTool(toolCallId, toolName, isError, duration);
    if (!batchEmpty) return;

    // THE BATCH IS EMPTY. This is both the sealing point (§3.5.1) and the one
    // injection window (§3.5.4), in that order: injecting first clears `pending`
    // so the freshly sealed turn can trigger the next review.
    this.ring.seal();
    this.maybeInject();
    this.maybeStartReview();
  }

  private endRun(): void {
    // GUARD 2 (§3.5.4a). `awaitingDrain` still set means the loop never reached
    // `turn_start`, so the block sits in a queue nothing will ever clear (C-10)
    // and would surface at checkpoint 1 of the user's NEXT question.
    if (this.awaitingDrain) this.recoverStranded();
    if (this.pending) this.dropPending('run_ended');
    this.cancelCall();
    this.ring.endRun();
  }

  /**
   * Remove a block that was steered and never delivered.
   *
   * THE ASYMMETRY IS DELIBERATE (D-21): the reviewer may always destroy its own
   * message and may NEVER destroy the user's. `Agent` exposes no way to remove
   * one entry - only `clearAllQueues()` - so removal is permitted only while the
   * reviewer can PROVE it owns the whole queue, which `userSteerCount() === 0`
   * establishes: `AgentController.steer()` is the only other writer in the
   * package and the counter resets at every `turn_start`.
   *
   * With a user steer queued it clears NOTHING and warns. The residue is
   * bounded, rare, labelled by its own `<fast_review turn model>` wrapper, and -
   * unlike v1 - reported.
   */
  private recoverStranded(): void {
    const reviewIndex = this.awaitingReviewIndex;
    this.awaitingDrain = false;
    this.awaitingReviewIndex = 0;
    const userQueued = this.deps.userSteerCount();
    const cleared = userQueued === 0;
    if (cleared) {
      this.deps.clearAllQueues();
    }
    this.log.warn('fast_review_stranded', { reviewIndex, cleared, userQueued });
    this.log.info('fast_review_dropped', { reviewIndex, reason: 'stranded' });
    this.emitReview({
      index: reviewIndex,
      runId: this.runId,
      turn: this.ring.turns,
      model: this.currentModelId(),
      kind: 'dropped',
      detail: cleared
        ? 'missed its window (run ended before delivery)'
        : 'missed its window; a queued message could not be cleared',
      durationMs: 0,
      injected: false,
    });
  }

  // -----------------------------------------------------------------------
  // Trigger
  // -----------------------------------------------------------------------

  /** Whether another review could still be STARTED this run. */
  private canReviewAgain(): boolean {
    if (this.selfDisabled) return false;
    if (!this.deps.available()) return false;
    if (this.deps.getConfig().review !== true) return false;
    return this.reviewsThisRun < FAST_LIMITS.maxReviewsPerRun;
  }

  private maybeStartReview(): void {
    if (!this.canReviewAgain()) return;
    // SINGLE-FLIGHT IS NOT AN OPTIMIZATION. With `reviewEveryTurns: 1` and a slow
    // fast provider an unguarded reviewer starts a second call before the first
    // returns, then a third, and the run ends with four critiques racing for one
    // window - of which three are stale by construction.
    if (this.inFlight || this.pending !== null) return;
    const turns = this.ring.turns;
    const cadence = Math.max(1, this.deps.getConfig().reviewEveryTurns);
    if (turns === 0 || turns % cadence !== 0) return;
    // THE SESSION BUDGET, AFTER THE CADENCE GATE AND NOT BEFORE (§3.1.2 / D-H5).
    // An exhausted session still seals a frame and still reaches this method on
    // every turn; checking earlier would evaluate the budget on all of them and
    // the notice would be tied to the clock rather than to a review the user
    // actually lost. It is NOT folded into `canReviewAgain()` either: that is a
    // predicate with three other callers, and a query that emits UI is how a
    // status read starts writing to the transcript.
    if (this.reviewIndex >= this.budgetLimit()) {
      this.announceBudgetReached();
      return;
    }
    void this.runReview(turns);
  }

  /**
   * Say it once per limit value, and say what is NOT affected.
   *
   * `info`, NOT `warn` (D-H6): D-24 reserves the alarming register for a
   * MISCONFIGURED tier, because that is the case that never fixes itself. A
   * budget reached is the system working as configured, and warning here would
   * train the user to ignore the register that matters.
   *
   * NEITHER `consecutiveFailures` NOR `selfDisabled` IS TOUCHED. A budget stop
   * is neither a success that clears the strike counter nor a failure that
   * raises it - the exact distinction IF-7 was filed for, applied to a second
   * cause. And the reviewer is not broken: it must revive the moment the budget
   * rises, which `budgetLimit()` reading live config is what delivers.
   *
   * NO TRANSCRIPT CARD, and that is a correctness requirement rather than a
   * styling choice (§3.1.3). R-8 ("it did nothing" is never the observable
   * outcome) governs a review that STARTED; every such path emits a `FastReview`
   * carrying an `index`, and indices come from `this.reviewIndex += 1`. Minting
   * one here would advance the very counter `/fast status` renders as the
   * numerator, so the first suppression would display `41/40`.
   */
  private announceBudgetReached(): void {
    const limit = this.budgetLimit();
    if (this.budgetAnnouncedAt === limit) return;
    this.budgetAnnouncedAt = limit;
    this.deps.notify(
      'info',
      `Fast reviews: session budget reached (${limit}). ` +
        `Raise it with /fast budget <n>.`,
    );
    this.log.info('fast_review_budget_reached', { limit, reviews: this.reviewIndex });
  }

  // -----------------------------------------------------------------------
  // The call
  // -----------------------------------------------------------------------

  private currentModelId(): string {
    const tier = this.deps.getTier();
    return tier.ok ? tier.ref.modelId : '';
  }

  private async runReview(turn: number): Promise<void> {
    const tier = this.deps.getTier();
    if (!tier.ok) return;
    const apiKey = this.deps.getApiKey(tier.ref.providerId);
    if (!apiKey) return;

    const cfg = this.deps.getConfig();
    const runId = this.runId;
    const index = (this.reviewIndex += 1);
    this.reviewsThisRun += 1;
    this.inFlight = true;

    const frames = this.ring.frames();
    const digest = buildReviewDigest({
      frames,
      goal: this.goal,
      contextTurns: cfg.reviewContextTurns,
    });

    this.log.debug('fast_review_start', {
      runId,
      turn,
      reviewIndex: index,
      budget: this.budgetLimit(),
      digestChars: digest.length,
      frames: frames.length,
    });
    // The digest text itself is `trace` only: it carries workspace content, and
    // `logging/redact.ts` already draws that line for prompt text.
    this.log.trace('fast_review_digest', { reviewIndex: index, digest });
    this.deps.emit({ type: 'review_start', index, turn });

    // THE ONE `new AbortController()` OF THIS FEATURE, AND IT STAYS IN THIS FILE
    // (AC-H16 / RV-H1). `review-call.ts` receives the signal and a timeout
    // callback; it never constructs, owns or classifies the abort, because
    // `cancelCall()` above has to be able to stamp `'cancelled'` before aborting.
    const controller = new AbortController();
    this.callAbort = controller;
    this.callAbortReason = null;
    const startedAt = this.now();

    try {
      const outcome = await runReviewCall({
        complete: (providerId, request) => this.deps.complete(providerId, request),
        ref: tier.ref,
        apiKey,
        digest,
        reviewMaxChars: cfg.reviewMaxChars,
        signal: controller.signal,
        now: startedAt,
        // A TIMEOUT *IS* A STRIKE (§3.5.5: "a transport error, a timeout or an
        // unparseable answer increments consecutiveFailures"), and stamping it
        // here is what keeps it distinguishable from a cancellation once the
        // retry layer has flattened both into the same bare `Error`.
        onTimeout: () => {
          this.callAbortReason = 'timeout';
          controller.abort();
        },
      });

      if (outcome.ok) {
        this.onReviewAnswer(index, runId, turn, tier.ref.modelId, outcome.message, startedAt);
      } else if (this.callAbortReason === 'cancelled') {
        this.onReviewCancelled(index, runId, turn, startedAt);
      } else {
        this.onReviewFailure(index, runId, turn, outcome.error, startedAt);
      }
    } finally {
      if (this.callAbort === controller) {
        this.callAbort = null;
        this.callAbortReason = null;
      }
      this.inFlight = false;
    }
  }

  /**
   * A review nobody is waiting for any more.
   *
   * It still has to produce a TERMINAL card. `review_start` already put a
   * `running` entry in the transcript, and `Transcript`'s settled boundary is
   * monotonic (C-5) - an entry that never settles is re-rendered on every frame
   * for the rest of the session. "It did nothing" is also never allowed to be
   * the observable outcome (R-8).
   *
   * `consecutiveFailures` is left EXACTLY as it was: a cancellation is neither a
   * success that clears the count nor a failure that raises it.
   */
  private onReviewCancelled(
    index: number,
    runId: number,
    turn: number,
    startedAt: number,
  ): void {
    this.log.info('fast_review_dropped', { reviewIndex: index, reason: 'aborted' });
    this.emitReview({
      index,
      runId,
      turn,
      model: this.currentModelId(),
      kind: 'dropped',
      detail: DROP_DETAIL.aborted,
      durationMs: Math.max(0, this.now() - startedAt),
      injected: false,
    });
  }

  private onReviewAnswer(
    index: number,
    runId: number,
    turn: number,
    model: string,
    message: AssistantMessage,
    startedAt: number,
  ): void {
    const durationMs = Math.max(0, this.now() - startedAt);
    const { usage, missing: usageMissing } = usageOf(message);
    this.usage = accumulateUsage(this.usage, usage);
    this.deps.emit({ type: 'usage', usage });
    this.consecutiveFailures = 0;

    const critique = normalizeCritique(
      assistantText(message),
      this.deps.getConfig().reviewMaxChars,
    );
    this.log.info('fast_review_done', {
      reviewIndex: index,
      ms: durationMs,
      kind: critique.kind,
      chars: critique.kind === 'advice' ? critique.text.length : 0,
      usage,
      ...(usageMissing ? { usageMissing: true } : {}),
    });

    // STALE RUN: the answer outlived the run it was about. Injecting it into a
    // later conversation is R-4 exactly.
    if (runId !== this.runId || !this.deps.isRunning()) {
      this.emitReview({
        index,
        runId,
        turn,
        model,
        kind: 'dropped',
        detail: 'the run ended before the review came back',
        durationMs,
        usage,
        injected: false,
      });
      this.log.info('fast_review_dropped', { reviewIndex: index, reason: 'stale_run' });
      return;
    }

    if (critique.kind !== 'advice') {
      // Shown, never injected (D-16): the user can see the harness is alive
      // without the lead paying context for "nothing to say".
      this.emitReview({
        index,
        runId,
        turn,
        model,
        kind: critique.kind,
        durationMs,
        usage,
        injected: false,
      });
      return;
    }

    // THE ASYNC CALLBACK NEVER INJECTS. It only parks the critique; the window
    // is opened by a synchronous `tool_execution_end` listener (D-7).
    this.pending = {
      runId,
      reviewIndex: index,
      turn,
      text: critique.text,
      model,
      at: this.now(),
      durationMs,
      usage,
    };
  }

  private onReviewFailure(
    index: number,
    runId: number,
    turn: number,
    err: unknown,
    startedAt: number,
  ): void {
    const durationMs = Math.max(0, this.now() - startedAt);
    const { errorType, transient } = classifyReviewFailure(err);
    if (!transient) this.consecutiveFailures += 1;

    this.log.warn('fast_review_failed', {
      reviewIndex: index,
      error: errorText(err),
      errorType,
      transient,
      consecutiveFailures: this.consecutiveFailures,
    });

    this.emitReview({
      index,
      runId,
      turn,
      model: this.currentModelId(),
      kind: 'failed',
      detail: errorText(err),
      durationMs,
      injected: false,
    });

    // ONE NOTICE, AT THE THRESHOLD - never one per failure (D-18). Three
    // identical stream errors in the transcript teach the user nothing and bury
    // the answer they were reading.
    if (!this.selfDisabled && this.consecutiveFailures >= FAST_LIMITS.maxConsecutiveFailures) {
      this.selfDisabled = true;
      this.deps.notify(
        'warn',
        `Fast review disabled for this session after ${FAST_LIMITS.maxConsecutiveFailures} ` +
          `failures. Last error: ${errorText(err)}`,
      );
      // THE ONE LINE THAT MAKES THE FLAG OBSERVABLE OUTSIDE THIS PROCESS.
      //
      // `emitReview({kind:'failed'})` above already fired, carrying a snapshot
      // in which `selfDisabled` was still `false`, and after this point the
      // reviewer emits NOTHING EVER AGAIN (`shouldReview()` opens with
      // `if (this.selfDisabled) return false;`). Without this extra
      // `tier_changed`, the field exists, the accessor exists, the snapshot line
      // exists — and no consumer can ever see it as `true`. The `App` chip also
      // consumes `tier_changed`; one more refresh is free.
      this.deps.emit({ type: 'tier_changed', snapshot: this.deps.snapshot() });
    }
  }

  // -----------------------------------------------------------------------
  // The injection window (§3.5.4) - THE ONLY `steer()` CALL SITE
  // -----------------------------------------------------------------------

  private maybeInject(): void {
    const pending = this.pending;
    if (!pending) return;

    // The run moved on without it.
    if (pending.runId !== this.runId) {
      this.dropPending('stale_run');
      return;
    }
    // STALENESS (RV-12). One `task` dispatch is a single tool call that can run
    // for minutes, so a critique triggered just before one arrives at the far
    // side describing a state five children have since rewritten. Advice that is
    // merely late is worse than no advice, because the lead cannot tell.
    const age = this.now() - pending.at;
    const behind = this.ring.turns - pending.turn;
    if (age > FAST_LIMITS.pendingMaxAgeMs || behind > FAST_LIMITS.pendingMaxTurnsBehind) {
      this.dropPending('stale_pending');
      return;
    }
    // GUARD 1 (§3.5.4a). `AgentController.abort()` sets this synchronously
    // BEFORE `agent.abort()`, so the common Esc path is visible here even though
    // the loop has not broken yet.
    if (this.deps.isAbortRequested() || !this.deps.isRunning()) {
      this.dropPending('aborted');
      return;
    }

    const block = renderReviewInjection({
      turn: pending.turn,
      model: pending.model,
      text: pending.text,
    });
    // NOTE THE ORDERING THIS SITS ON (RV-9): `tool_execution_end` is emitted at
    // `agent-loop.ts:249`, BEFORE its own `tool_result` is pushed at `:263`. The
    // design is still correct because `steer()` only ENQUEUES and the drain does
    // not happen until checkpoint 1 of the next iteration, by which time `:263`
    // has run. An "improvement" that pushed this block onto `messageManager`
    // directly from here would place a `user` message BETWEEN an assistant's
    // `tool_use` and its `tool_result` - checkpoint 2's HTTP 400, reintroduced
    // by a change that looks like a simplification.
    this.deps.steer(block);
    this.awaitingDrain = true;
    this.awaitingReviewIndex = pending.reviewIndex;
    this.pending = null;

    this.log.info('fast_review_injected', {
      reviewIndex: pending.reviewIndex,
      turn: pending.turn,
      // Always 0 - the assertion, recorded.
      outstanding: this.ring.outstandingCalls,
    });
    this.emitReview({
      index: pending.reviewIndex,
      runId: pending.runId,
      turn: pending.turn,
      model: pending.model,
      kind: 'advice',
      text: pending.text,
      durationMs: pending.durationMs,
      ...(pending.usage ? { usage: pending.usage } : {}),
      injected: true,
    });
  }

  private dropPending(reason: DropReason): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.log.info('fast_review_dropped', { reviewIndex: pending.reviewIndex, reason });
    this.emitReview({
      index: pending.reviewIndex,
      runId: pending.runId,
      turn: pending.turn,
      model: pending.model,
      kind: 'dropped',
      detail: DROP_DETAIL[reason],
      durationMs: pending.durationMs,
      ...(pending.usage ? { usage: pending.usage } : {}),
      injected: false,
    });
  }

  private emitReview(review: FastReview): void {
    this.deps.emit({ type: 'review_end', review });
  }
}

/**
 * The one-line reason a review is shown as `dropped`.
 *
 * "It did nothing" is never the observable outcome (R-8): every path that ends
 * without an injection still produces a card and a log record.
 */
const DROP_DETAIL: Record<DropReason, string> = {
  run_ended: 'missed its window (the run ended first)',
  aborted: 'cancelled',
  stale_run: 'the run ended before the review came back',
  stale_pending: 'too late to be useful',
  stranded: 'missed its window (run ended before delivery)',
};
