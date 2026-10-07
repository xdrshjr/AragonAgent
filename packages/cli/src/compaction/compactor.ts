/**
 * `Compactor` — the `ContextManager` implementation (context-auto-compaction
 * §3.4 / §3.6 / §3.7 / §3.8).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope.
 *
 * THIS IS THE POLICY HALF OF THE FEATURE. The engine owns exactly one thing -
 * structural validity - and every other decision is here: when to fire, what to
 * keep, which model summarizes, what the prompt asks for, what happens when the
 * call fails, and when to stop spending.
 */

import type { ModelRole } from '../config/model-profiles.js';
import {
  planCompaction,
  type Message,
  type TailReliefResult,
  type ModelInfo,
  type ModelRef,
  type TokenUsage,
  type AssistantMessage,
  type CompactionContext,
  type CompactionOutcome,
  type CompactionProbe,
  type ContextManager,
  type LLMRequest,
} from '@aragon-agent/core';
import type { CliConfig } from '../config/schema.js';
import type { NoticeLevel } from '../agent/reducer.js';
import { getLogger } from '../logging/logger.js';
import { resolveFastTier } from '../fast/resolve.js';
import { COMPACTION_LIMITS } from './limits.js';
import { attemptTailRelief, reliefSummary, tailBudgetTokens } from './tail-budget.js';
import { buildDigest, isPriorSummaryBlock } from './digest.js';
import {
  buildAnchor,
  buildCompactedBlock,
  countProtectedPrefix,
  readGeneration,
  truncationBody,
} from './summary-prompt.js';
import { accumulateUsage, errorText, runSummarizeCall } from './summarize-call.js';
import { computePressure, shouldCompactAt } from './pressure.js';
import { ContextMeter } from './meter.js';
import type {
  CompactionEvent,
  CompactionMode,
  CompactionRecord,
  CompactionUiTrigger,
  Pressure,
} from './types.js';

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

/** A queued `/compact`, honoured at the next turn boundary (D-17). */
interface PendingManual {
  instructions?: string;
}

/**
 * What `compaction_start` was emitted under (quiet-noop §3.2).
 *
 * `null` in `runCompaction`'s local means this compaction is still SILENT, and
 * must stay silent: nothing was announced, so there is nothing to settle.
 */
interface Announcement {
  index: number;
}

export class Compactor implements ContextManager {
  private readonly log = getLogger().child('compaction');

  // --- Per-run state (reset on `agent_start`) ---
  private compactionsThisRun = 0;
  private lastCompactionTurn = -Infinity;

  // --- Per-session state ---
  private compactions = 0;
  /**
   * How many `compact()` calls returned WITHOUT announcing (quiet-noop D-9).
   *
   * A SESSION TOTAL, LIKE `compactions`, and reset by neither `onRunStart()` nor
   * `clearSelfDisable()`: `/compact on` overrides a guard, it does not rewrite
   * history. `/compact status` is its only reader, and it is the whole of what
   * keeps a decline reportable once the transcript stops carrying one.
   */
  private declined = 0;
  private tokensReclaimed = 0;
  private sessionUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private pricingUnknown = false;
  private inFlight = false;
  private consecutiveNoProgress = 0;
  private selfDisabled = false;
  private selfDisabledReason: string | undefined;
  private pendingManual: PendingManual | null = null;
  private generation = 0;
  /**
   * The fallback meter, built on first use when no host injected one (R-1).
   *
   * `estimateOffset`, `measuredPrefixLength` and `lastPressure` used to be
   * FIELDS HERE. They moved to `ContextMeter` wholesale
   * (context-usage-gauge-accuracy W1), because keeping them here is what put the
   * only measurement in the process behind `compaction.enabled`.
   */
  private ownMeter: ContextMeter | null = null;
  /**
   * The messages the last splice dropped, held ONLY until the wiring collects
   * them for the archive (W4 / RV-3).
   *
   * NOT ON `CompactionRecord`: that record is dispatched into the reducer and
   * retained in view state for the card's lifetime, so putting a megabyte of
   * history on it would park the dropped conversation in React state - precisely
   * the memory this compaction just reclaimed.
   *
   * SET ONLY WHEN ARCHIVING IS ON, so with the key off the slice is never
   * retained and W4 costs nothing.
   */
  private lastDropped: Message[] | null = null;

  // --- Abort plumbing for the summarization call (see `summarize-call.ts`) ---
  private callAbort: AbortController | null = null;
  private callAbortReason: 'timeout' | 'cancelled' | null = null;

  /** Guard 2's ceiling for this instance (hardening §3.4.2 mechanism B / DH-16). */
  private readonly maxPerRun: number;

  constructor(
    private readonly deps: CompactorDeps,
    opts?: CompactorOptions,
  ) {
    this.maxPerRun = opts?.maxPerRun ?? COMPACTION_LIMITS.maxPerRun;
  }

  // =========================================================================
  // Lifetime
  // =========================================================================

  /** `agent_start` — the per-run cap resets, the session totals do not. */
  onRunStart(): void {
    this.compactionsThisRun = 0;
    this.lastCompactionTurn = -Infinity;
  }

  /**
   * `turn_end` - recompute the calibration offset (D-23).
   *
   * A THIN FORWARDER since context-usage-gauge-accuracy W1. The meter subscribes
   * to `turn_end` itself, so BOTH PATHS MUST BE IDEMPOTENT: this one recomputes
   * exactly what the other one did from the same inputs, which it is.
   *
   * `messages` / `systemPrompt` stay in the signature and are ignored: the meter
   * reads them from its own lazy deps, and every existing caller and test keeps
   * compiling.
   */
  onTurnEnd(usage: TokenUsage, _messages: readonly Message[], _systemPrompt: string): void {
    this.meter().onTurnEnd(usage);
  }

  /*
   * `invalidateMeasurement()` IS GONE, DELIBERATELY (I-9 / RV-2 round two).
   *
   * It had exactly two production callers and their reset depths are now
   * OPPOSITE: `CompactionWiring.onHistoryReplaced` (a `/clear`, `/reset` or
   * `/resume`) must drop `estimateOffset`, while `settlePending`'s applied
   * branch (a splice) must KEEP it - the toolset and the model are unchanged, so
   * the calibration still holds and dropping it makes the gauge fall too far and
   * climb back (I-5 / I-8). The two used to share a method only because the one
   * field it cleared happened to be their intersection; that intersection no
   * longer exists. Both call sites now name the depth they mean, on the meter.
   *
   * Reinstating a forwarder here would hide "which caller gets which depth"
   * behind a name that mentions neither, and BOTH wrong choices are silent.
   */

  /**
   * The dropped messages, released as they are returned (W4 / RV-3).
   *
   * `take` RATHER THAN `get`: the reference is dropped on read, so a wiring that
   * declines to archive (key off, or `applied: false`) cannot pin it and a second
   * read cannot double-write. `settlePending` calls this on EVERY verdict and
   * discards on the ones that do not archive, which is what guarantees the array
   * cannot outlive one compaction regardless of which branch was taken.
   */
  takeLastDropped(): Message[] | null {
    const dropped = this.lastDropped;
    this.lastDropped = null;
    return dropped;
  }

  /** Cancel an in-flight summarization (Esc, `dispose`). */
  abort(): void {
    if (this.callAbort) {
      this.callAbortReason = 'cancelled';
      this.callAbort.abort();
    }
  }

  // =========================================================================
  // The manual queue (§4.4 / D-17)
  // =========================================================================

  /**
   * Ask for a compaction at the next turn boundary.
   *
   * THE BOUNDARY IS THE ONLY MOMENT THE ENGINE IS SINGLE-THREADED WITH RESPECT
   * TO THE HISTORY, by construction. Replacing `messages` under a live loop is a
   * race; a flag `shouldCompact` honours there is not.
   */
  queueManual(instructions?: string): void {
    this.pendingManual = instructions ? { instructions } : {};
  }

  hasPendingManual(): boolean {
    return this.pendingManual !== null;
  }

  clearPendingManual(): void {
    this.pendingManual = null;
  }

  // =========================================================================
  // ContextManager — the sync gate
  // =========================================================================

  /**
   * SYNCHRONOUS AND CHEAP. Two deliberate effects: the pressure cache, and
   * `deps.onPressure` (hardening DH-15).
   *
   * THE MEASUREMENT IS TAKEN ONCE, ABOVE THE GUARDS, AND REPORTED
   * UNCONDITIONALLY. Below them it is skipped on five paths — the per-run cap,
   * the cooldown, manual, overflow and guard 4 — and TWO OF THOSE NEVER CLEAR
   * WITHIN A RUN. A gauge fed from the measurement would therefore go dark
   * exactly when compaction is exhausted and the window is still filling, which
   * is the one state where the corrected number is the user's only warning. It
   * would silently revert to the measured base — the very figure W1 exists
   * because it under-reports.
   *
   * `!config.enabled` STAYS THE FIRST STATEMENT, so a session that turned the
   * feature off pays nothing at all and AC-1's byte-identity claim is untouched.
   */
  shouldCompact(probe: CompactionProbe): boolean {
    const config = this.deps.getConfig().compaction;
    if (!config.enabled) return false;

    // THE METER READS THE LIVE HISTORY ITSELF (W1), so the estimate branch can no
    // longer be handed an empty array by a caller that forgot - which used to be
    // a 0 % reading on precisely the session that most needs a trigger, the
    // resumed 180 k-token one where `lastUsage` is `undefined` by definition.
    // The probe's own usage is still passed, because it is the authority for
    // THIS checkpoint.
    const pressure = this.meter().measureWith(probe.lastUsage);
    this.deps.onPressure?.(pressure);

    const manual = this.pendingManual !== null;

    // Guard 2 — the per-run cap. BOTH TRIGGERS, HARD. It is the bound that makes
    // every other guard's failure mode "spends a little" rather than "spends
    // forever". Read from the INSTANCE, not the module: a child manager gets a
    // tighter one (W3 / DH-16).
    if (this.compactionsThisRun >= this.maxPerRun) return false;

    // Guard 1 — cooldown, in `turnIndex` units. A compaction that just ran needs
    // a real turn before its effect is measurable, because `lastUsage` is still
    // the pre-compaction number until the next `turn_end`.
    //
    // BYPASSED FOR OVERFLOW, and that is not a courtesy: the cooldown cannot be
    // allowed to block the only path that makes an already-refused request
    // sendable. A manual request is a user instruction and bypasses it too.
    const cooled =
      probe.turnIndex - this.lastCompactionTurn >= COMPACTION_LIMITS.minTurnsBetween;
    if (probe.trigger !== 'overflow' && !manual && !cooled) return false;

    // An explicit `/compact` is a user instruction: it does not consult the
    // threshold, and guard 4 does not suppress it.
    if (manual) return true;

    // The reactive path is answering a request the provider has ALREADY REFUSED,
    // so it never consults occupancy — and guard 4 must not be able to switch it
    // off, which is the entire answer to R-5 (D-24 / P1-13).
    if (probe.trigger === 'overflow') return true;

    // Guard 4 — self-disable suppresses the PRESSURE trigger only.
    if (this.selfDisabled) return false;

    return shouldCompactAt(pressure, config.threshold, {
      maxOutputTokens: this.effectiveMaxOutputTokens(),
    });
  }

  // =========================================================================
  // ContextManager — the work
  // =========================================================================

  async compact(ctx: CompactionContext): Promise<CompactionOutcome> {
    const manual = this.pendingManual;
    const instructions = manual?.instructions;
    this.pendingManual = null;

    const uiTrigger: CompactionUiTrigger = manual ? 'manual' : ctx.trigger;
    const config = this.deps.getConfig().compaction;
    const summarizer = this.resolveSummarizer();

    // GUARDS 1 AND 2 COUNT *ATTEMPTS*, NOT ANNOUNCEMENTS, and they stay here
    // (quiet-noop §3.3). A decline still consumed a checkpoint: it still has to
    // serve the cooldown and it still has to be charged to the per-run cap, or a
    // history that can never be compacted would re-attempt on every turn for the
    // whole run. `inFlight` stays for the same reason - the chip reports what the
    // compactor is DOING, not what it has decided to say.
    this.compactionsThisRun += 1;
    this.lastCompactionTurn = ctx.turnIndex;
    this.inFlight = true;

    const started = Date.now();
    try {
      return await this.runCompaction({
        ctx,
        uiTrigger,
        config,
        summarizer,
        ...(instructions ? { instructions } : {}),
        started,
      });
    } finally {
      this.inFlight = false;
      this.callAbort = null;
      this.callAbortReason = null;
    }
  }

  // =========================================================================
  // Internals
  // =========================================================================

  /**
   * Open the card (quiet-noop §3.2).
   *
   * THE ONLY EMITTER OF `compaction_start`, AND THE ONLY PLACE `this.compactions`
   * ADVANCES. A compaction that never reaches an announce point is a DECLINE: it
   * changed nothing, called nothing and spent nothing, and it is deliberately
   * indistinguishable - on every human surface except `/compact status`'s
   * `declined` count (D-9) - from a turn at which `shouldCompact` returned false.
   * `finish` is the other half of that rule.
   *
   * IT RETURNS THE ANNOUNCEMENT RATHER THAN STORING IT (P1-1), and the caller
   * keeps it in a LOCAL for the lifetime of one `runCompaction` call - the same
   * slot `index` occupied before this change. An instance field would have needed
   * a no-re-entrancy argument, and the obvious one is WRONG: guard 1 lives in
   * `shouldCompact`, while the idle `/compact` path calls `compact()` straight
   * through `wiring.compactNow()` without consulting it. What actually keeps two
   * compactions apart is that `command.ts` QUEUES instead of calling `compactNow`
   * while the loop runs - a property of a different file, which is exactly why
   * this one must not depend on it. A clobbered field would leave `finish` unable
   * to settle the card it opened, and a card that never settles pins
   * `Transcript`'s monotonic boundary for the rest of the session.
   */
  private announce(
    trigger: CompactionUiTrigger,
    summarizer: SummarizerChoice | null,
  ): Announcement {
    this.compactions += 1;
    this.deps.emit({
      type: 'compaction_start',
      index: this.compactions,
      trigger,
      model: summarizer?.ref.modelId ?? '',
    });
    return { index: this.compactions };
  }

  private async runCompaction(args: {
    ctx: CompactionContext;
    uiTrigger: CompactionUiTrigger;
    config: CliConfig['compaction'];
    summarizer: SummarizerChoice | null;
    instructions?: string;
    started: number;
  }): Promise<CompactionOutcome> {
    const { ctx, config, summarizer } = args;

    // THE ANNOUNCEMENT IS A LOCAL, NEVER A FIELD (quiet-noop §3.2 / P1-1), and
    // `??=` is what makes the eager path and the two commit points idempotent
    // with respect to each other.
    let announced: Announcement | null = null;
    const announce = (model: SummarizerChoice | null): void => {
      announced ??= this.announce(args.uiTrigger, model);
    };

    // A REQUESTED compaction and a REACTIVE one announce BEFORE they know the
    // answer, for two different reasons. `manual` is a user instruction, and its
    // QUEUED form (`/compact` typed mid-run) has NO other reporting surface - a
    // silent decline there would be a command that did nothing and said nothing.
    // `overflow` runs after the provider has ALREADY refused the request; if it
    // cannot recover, the card is the only place that says why the run is about
    // to die. Both paths stay byte-identical to the round before this one.
    if (args.uiTrigger !== 'pressure') announce(summarizer);

    const before = ctx.messages;
    const protectedPrefix = countProtectedPrefix(before);

    // THE ONE LEVER THE GUARDS DO NOT HAVE (D-24). A tail that alone exceeds the
    // window is the single failure mode none of the four guards can fix — they
    // can only stop spending on it. An overflow attempt halves `keepRecentTurns`
    // FOR ITSELF, in memory, never persisted: it is applied exactly where the
    // provider has PROVEN the request impossible.
    const keepRecentTurns =
      ctx.trigger === 'overflow'
        ? Math.max(1, Math.floor(config.keepRecentTurns / 2))
        : config.keepRecentTurns;

    const plan = planCompaction(before, { keepRecentTurns, protectedPrefix });
    if (!plan) {
      // THE CASE THAT KILLS A RUN TODAY (hardening §3.3.3 / W2). "Nothing to
      // drop" and "the tail is too big" are the SAME outcome in round 1, and both
      // are terminal: every rung of the ladder operates on the head, and there is
      // no head left. Relief is the one lever that still applies, so the
      // `plan === null` branch tries it before conceding.
      const reliefOnly = this.relieveInPlace(before, protectedPrefix, ctx.systemPrompt);
      if (reliefOnly) {
        // COMMIT POINT A (quiet-noop §3.4). Relief changes the history the run
        // continues from - a bounded, announced data loss - so it is announced
        // even though no model was called. `null` summarizer for the same reason
        // `finish` writes `model: ''` on a relief-only record: naming a model here
        // would claim a call that never ran.
        announce(null);
        this.checkProgress(ctx, args.uiTrigger, reliefOnly.messages);
        return this.finish(
          { ...args, tailRelief: reliefSummary(reliefOnly) },
          {
            action: 'replace',
            // `truncated` ACROSS THE PORT (DH-5 / DH-20). The engine's question
            // is only "was this history reduced without a summary", and the
            // answer is yes. `finish` maps this reason to the CLI's own
            // `'relieved'`, which is what stops the card claiming a summary that
            // never ran.
            mode: 'truncated',
            messages: reliefOnly.messages,
            reason: 'tail_relief_only',
          },
          { droppedMessages: 0 },
          keepRecentTurns,
          announced,
        );
      }
      this.noteNoProgress(args.uiTrigger, 'nothing_to_drop');
      return this.finish(
        args,
        { action: 'keep', reason: 'nothing_to_drop' },
        null,
        keepRecentTurns,
        announced,
      );
    }

    const anchor = buildAnchor(before);
    if (!anchor) {
      // A history with no `user` message at all cannot have a goal anchor, and
      // D-6 makes the anchor non-negotiable. Refusing is the honest outcome.
      //
      // STRUCTURALLY UNREACHABLE, AND KEPT ANYWAY (quiet-noop E-23 / §3.4). This
      // is reached only after `plan !== null`, and `planCompaction` returns a plan
      // only when some cut leaves `countTurns >= keep` behind it - `countTurns`
      // counts `user`-role messages and `keep` is at least 1, so a plan PROVES the
      // one thing `buildAnchor` looks for. A provably dead guard is worth strictly
      // more than the non-null assertion that would replace it. It stays ABOVE the
      // commit point on purpose: if the plan/anchor relationship ever changes, the
      // reason that appears is one decided before any work began, and silence is
      // what it should get - but any new PRE-COMMIT decline must then either
      // charge guard 4 (as `nothing_to_drop` does) or be proven unreachable in
      // turn, because guard 4 is what bounds how long a silent decline can repeat.
      return this.finish(
        args,
        { action: 'keep', reason: 'no_anchor' },
        null,
        keepRecentTurns,
        announced,
      );
    }

    // COMMIT POINT B (quiet-noop §3.4). Everything below this line either spends
    // money (`runLadder`), rewrites the history, or faults - and all three are the
    // user's business.
    //
    // BEFORE `buildDigest`, NOT AFTER. A throw inside the digest renderer reaches
    // the engine as `manager_threw`, and the engine settles the card from the
    // verdict alone; with no card open, that fault would be invisible on every
    // human surface. Announcing first costs one event on a path that is about to
    // spend seconds and dollars.
    //
    // WHAT IT STILL DOES NOT COVER (recorded, not closed - quiet-noop §12 / IF-2).
    // A throw in the SYNCHRONOUS region ABOVE this line - `countProtectedPrefix`,
    // `planCompaction`, `relieveInPlace`, `buildAnchor` - also reaches the engine
    // as `manager_threw`, and on `pressure` that fault now has no card, charges no
    // guard (`noteNoProgress` is never reached) and does not advance `declined`
    // (`finish` is never called) - so a host bug there would repeat at every
    // checkpoint for a whole run in silence. `manager_timeout` cannot land there:
    // that region holds no `await`, which is the property AC-Q12 pins. Closing it
    // means hoisting the announcement out of this function, which is precisely
    // what P1-1 decided against - so it is written down rather than fixed under
    // another change's name.
    announce(summarizer);

    const head = before.slice(protectedPrefix, plan.cutIndex);
    const priorBlock = before.slice(0, protectedPrefix).find((m) => isPriorSummaryBlock(m));
    // The prior block is carried into the DIGEST rather than the tail, so the
    // summarizer merges it forward (D-22).
    const digestHead = priorBlock ? [priorBlock, ...head] : head;
    const digest = buildDigest({
      head: digestHead,
      ...(summarizer
        ? { summarizerWindow: this.deps.getModelInfoFor(summarizer.ref).contextWindow }
        : {}),
    });

    const ladder = await this.runLadder({
      ctx,
      summarizer,
      digest: digest.text,
      hasPriorSummary: priorBlock !== undefined,
      ...(args.instructions ? { instructions: args.instructions } : {}),
    });

    if (ladder.kind === 'aborted') {
      return this.finish(
        args,
        { action: 'keep', reason: 'aborted' },
        null,
        keepRecentTurns,
        announced,
      );
    }

    if (ladder.kind === 'failed' && config.onFailure === 'stop') {
      // Rung 4. The run proceeds and will probably hit `context_overflow`, which
      // is what the user asked for by setting this.
      this.deps.notify(
        'error',
        `Context compaction failed (${ladder.reason}) and compaction.onFailure is "stop". ` +
          'The next request may exceed the context window. Try /compact again, or /clear, or /reset.',
      );
      return this.finish(
        args,
        { action: 'keep', reason: `summarize_failed: ${ladder.reason}` },
        null,
        keepRecentTurns,
        announced,
      );
    }

    const truncated = ladder.kind === 'failed';
    const mode: 'summarized' | 'truncated' = truncated ? 'truncated' : 'summarized';
    const generation = readGeneration(before) + 1;
    const block = buildCompactedBlock({
      summary: truncated ? truncationBody(plan.droppedMessages) : ladder.text,
      replaced: plan.droppedMessages,
      turns: countUserTurns(head),
      anchor: anchor.shape,
      generation,
      truncated,
    });

    const spliced: Message[] = [anchor.message, block, ...before.slice(plan.cutIndex)];

    // THE TAIL'S OWN SIZE IS ONLY KNOWABLE AFTER THE HEAD IS GONE. Projecting it
    // before the splice would be projecting against a number that is about to
    // change by 80 %. `from: 2` because the anchor and the block are never
    // eligible: the anchor is the user's own goal statement (D-6 makes it
    // non-negotiable) and the block is the summary this compaction just paid for.
    const relief = this.relieveInPlace(spliced, 2, ctx.systemPrompt);
    const messages: Message[] = relief ? relief.messages : spliced;

    // ARCHIVED BEFORE THE VERDICT, HELD UNTIL THE WIRING COLLECTS IT (W4 / RV-3).
    // `head` is the only place the dropped messages exist as an array, and this
    // function has returned long before `settlePending` runs. Retained ONLY when
    // the key is on, so `compaction.archive: false` never holds a reference.
    if (config.archive) this.lastDropped = [...head];

    if (truncated) {
      // Rung 3 is a VISIBLE, BOUNDED DEGRADATION rather than silent data loss:
      // it says so on the card, on the JSON event stream, and inside the block
      // the model itself reads.
      this.deps.notify(
        'warn',
        `Context compaction could not summarize (${ladder.reason}); ` +
          `${plan.droppedMessages} earlier messages were dropped without a summary.`,
      );
    }

    this.generation = generation;
    // GUARD 3 SEES THE RELIEVED HISTORY, so relief counts as progress for free -
    // `checkProgress` measures the final array, which is the one being adopted.
    // A test pins it (AC-H7), because "for free" is the kind of property a
    // refactor breaks silently.
    this.checkProgress(ctx, args.uiTrigger, messages);

    return this.finish(
      { ...args, ...(relief ? { tailRelief: reliefSummary(relief) } : {}) },
      {
        action: 'replace',
        mode,
        messages,
        ...(truncated ? {} : { summary: ladder.text }),
        ...(truncated ? { reason: `truncated: ${ladder.reason}` } : {}),
      },
      { droppedMessages: plan.droppedMessages, summary: truncated ? undefined : ladder.text },
      keepRecentTurns,
      announced,
    );
  }

  /** Tail relief against this session's window (hardening §3.3.3 / W2). */
  private relieveInPlace(
    messages: readonly Message[],
    from: number,
    systemPrompt: string,
  ): TailReliefResult | null {
    return attemptTailRelief({
      messages,
      from,
      systemPrompt,
      budget: tailBudgetTokens({
        contextWindow: this.modelInfo().contextWindow,
        maxOutputTokens: this.effectiveMaxOutputTokens(),
      }),
      log: (event, fields) => this.log.info(event, fields),
    });
  }

  /**
   * The failure ladder (§3.7).
   *
   * Rung 1 is the fast tier (or the main model); rung 2 is ONE retry on the MAIN
   * model when rung 1 used the fast tier, because "a fast model that cannot
   * summarize" is the most likely single failure. Rungs 3 and 4 are the caller's,
   * because they depend on `onFailure`.
   */
  private async runLadder(args: {
    ctx: CompactionContext;
    summarizer: SummarizerChoice | null;
    digest: string;
    hasPriorSummary: boolean;
    instructions?: string;
  }): Promise<
    | { kind: 'ok'; text: string }
    | { kind: 'failed'; reason: string }
    | { kind: 'aborted' }
  > {
    const { summarizer } = args;
    if (!summarizer) return { kind: 'failed', reason: 'no_summarizer_model' };

    const first = await this.callOnce(summarizer, args);
    if (first.kind === 'ok' || first.kind === 'aborted') return first;

    // Rung 2 — retry, on the MAIN model when rung 1 was the fast tier.
    const retryChoice: SummarizerChoice = summarizer.fromFastTier
      ? { ref: this.mainRef(), role: this.deps.mainRole ?? 'main', fromFastTier: false }
      : summarizer;
    this.log.warn('summarize_retry', { reason: first.reason, model: retryChoice.ref.modelId });
    const second = await this.callOnce(retryChoice, args);
    if (second.kind === 'ok' || second.kind === 'aborted') return second;
    return { kind: 'failed', reason: second.reason };
  }

  private async callOnce(
    choice: SummarizerChoice,
    args: {
      ctx: CompactionContext;
      digest: string;
      hasPriorSummary: boolean;
      instructions?: string;
    },
  ): Promise<{ kind: 'ok'; text: string } | { kind: 'failed'; reason: string } | { kind: 'aborted' }> {
    const { ref, role } = choice;
    const apiKey = this.deps.getApiKey(ref.providerId, role);
    if (!apiKey) return { kind: 'failed', reason: 'no_api_key' };
    if (args.ctx.signal.aborted) return { kind: 'aborted' };

    // The controller is owned HERE, not in `summarize-call.ts`, so the caller can
    // stamp WHICH of "timeout" and "cancelled" happened before aborting — the
    // distinction the retry layer flattens away (see that file's header).
    const controller = new AbortController();
    this.callAbort = controller;
    this.callAbortReason = null;
    const onRunAbort = (): void => {
      this.callAbortReason = 'cancelled';
      controller.abort();
    };
    args.ctx.signal.addEventListener('abort', onRunAbort, { once: true });

    try {
      const outcome = await runSummarizeCall({
        ref,
        apiKey,
        digest: args.digest,
        hasPriorSummary: args.hasPriorSummary,
        ...(args.instructions ? { instructions: args.instructions } : {}),
        signal: controller.signal,
        now: Date.now(),
        complete: (providerId, request) => this.deps.complete(providerId, request),
        onTimeout: () => {
          this.callAbortReason = 'timeout';
          controller.abort();
        },
      });

      if (!outcome.ok) {
        if (this.callAbortReason === 'cancelled' || args.ctx.signal.aborted) return { kind: 'aborted' };
        const reason = this.callAbortReason === 'timeout' ? 'timeout' : errorText(outcome.error);
        return { kind: 'failed', reason };
      }

      this.noteUsage(ref, outcome.usage);
      if (outcome.text.trim().length === 0) return { kind: 'failed', reason: 'empty_summary' };
      return { kind: 'ok', text: outcome.text.trim() };
    } finally {
      args.ctx.signal.removeEventListener('abort', onRunAbort);
    }
  }

  /**
   * Guard 3 — the progress requirement (§3.8).
   *
   * ADVISORY ON OVERFLOW, NEVER A VETO (D-24 / P1-13). The arithmetic that makes
   * this guard sensible for the proactive trigger INVERTS on the reactive one: a
   * pressure compaction that reclaims little has spent money to buy two turns and
   * should stop, while an overflow compaction that reclaims little is the
   * difference between a continuing run and a dead one, because the provider has
   * already refused the request.
   *
   * The projection is ESTIMATED — no usage exists for a history that has not been
   * sent yet — and is therefore CALIBRATED with `estimateOffset` (D-23).
   *
   * IT TAKES THE *UI* TRIGGER, not `ctx.trigger`. A queued `/compact` reaches the
   * loop as an ordinary `pressure` checkpoint (that is what the queue IS), so
   * charging its result to guard 4's counter would let a user who types
   * `/compact` twice on a short conversation self-disable the proactive trigger
   * for the rest of the session — and be told, wrongly, that their recent turns
   * exceed the threshold. `uiTrigger` is the only value that knows the difference.
   */
  private checkProgress(
    ctx: CompactionContext,
    uiTrigger: CompactionUiTrigger,
    after: readonly Message[],
  ): void {
    const config = this.deps.getConfig().compaction;
    const info = this.modelInfo();
    // THE OFFSET NOW LIVES ON THE METER (W1), and it is read from the last
    // PUBLISHED pressure rather than re-derived: `Pressure.estimateOffset` is
    // carried on every measurement, so this is the same number the field used to
    // hold, without the compactor owning a second copy of it.
    const estimateOffset = this.meter().lastPublished()?.estimateOffset;
    const projected = computePressure({
      messages: after,
      systemPrompt: ctx.systemPrompt,
      contextWindow: info.contextWindow,
      windowKnown: true,
      ...(estimateOffset !== undefined ? { estimateOffset } : {}),
    });

    const target = config.threshold - COMPACTION_LIMITS.minReclaimRatio;
    const madeProgress = projected.ratio < target;
    this.log.info('compaction_progress', {
      trigger: uiTrigger,
      projectedRatio: Number(projected.ratio.toFixed(3)),
      target: Number(target.toFixed(3)),
      madeProgress,
    });

    if (madeProgress) {
      this.consecutiveNoProgress = 0;
      return;
    }
    this.noteNoProgress(uiTrigger, 'insufficient_reclaim');
  }

  /**
   * Guard 4 — stuck detection (§3.8).
   *
   * PRESSURE ONLY, AND `pressure` HERE MEANS THE *UI* TRIGGER. A session that
   * self-disables still survives an overflow rather than dying at the next
   * request, and if the tail really is too large the overflow attempt is the one
   * that can do something about it (D-24). A `manual` compaction is excluded for
   * a different reason: this guard exists to stop UNREQUESTED spend, and
   * `/compact` on a conversation with nothing worth dropping is a user who asked
   * — twice — not a runaway loop.
   */
  private noteNoProgress(trigger: CompactionUiTrigger, reason: string): void {
    if (trigger !== 'pressure') return;
    this.consecutiveNoProgress += 1;
    if (this.consecutiveNoProgress < COMPACTION_LIMITS.stuckLimit || this.selfDisabled) return;

    this.selfDisabled = true;
    this.selfDisabledReason = reason;
    this.log.warn('compaction_self_disabled', { reason });
    // THE WORDING NAMES THE ACTUAL CAUSE AND THE ACTUAL REMEDIES. A notice that
    // says only "compaction is off" teaches the user that the feature is broken;
    // this one tells them which number to change.
    this.deps.notify(
      'warn',
      'Auto-compaction is off for this session: the most recent ' +
        `${this.deps.getConfig().compaction.keepRecentTurns} turns alone exceed the threshold. ` +
        'Lower compaction.keepRecentTurns, or use /clear or /reset.',
    );
  }

  private finish(
    args: {
      ctx: CompactionContext;
      uiTrigger: CompactionUiTrigger;
      summarizer: SummarizerChoice | null;
      started: number;
      tailRelief?: { messages: number; charsRemoved: number };
    },
    outcome: CompactionOutcome,
    applied: { droppedMessages: number; summary?: string } | null,
    keepRecentTurnsUsed: number,
    announced: Announcement | null,
  ): CompactionOutcome {
    const before = args.ctx.messages.length;
    const after = outcome.action === 'replace' ? outcome.messages.length : before;
    // THE OCCUPANCY BEFORE THE SPLICE (I-10). `lastMeasured()` is the pure cache
    // read on purpose; anything that re-measures here reports 0 reclaimed.
    const tokensBefore = this.lastMeasured()?.occupied ?? 0;
    // `'relieved'` IS A CLI-ONLY WORD (RV-5 / DH-20). The port reports
    // `'truncated'` for a relief-only compaction, which is accurate for the
    // engine's narrower question; the card's `summarized N messages with
    // <model>` line would otherwise render "summarized 0 messages with
    // claude-haiku-4-5" for a compaction in which no model was called.
    const mode: CompactionMode = reliefOnly(outcome)
      ? 'relieved'
      : outcome.action === 'replace'
      ? outcome.mode
      : 'none';
    // NO MODEL ON A RELIEF-ONLY RECORD, because no model was called. The card
    // names the summarizer from this field, and naming one here would be the
    // same claim `mode: 'relieved'` exists to stop making.
    const model = reliefOnly(outcome) ? '' : args.summarizer?.ref.modelId ?? '';
    const durationMs = Date.now() - args.started;

    // THE ON-DISK RECORD OF EVERY ATTEMPT IS UNCHANGED (quiet-noop §9). This
    // feature makes the TRANSCRIPT quiet, not the logs: a declined compaction is
    // still one `compaction` line here, still one `compaction_start` /
    // `compaction_end` pair from CORE in the JSONL sink, and still reflected in
    // `/compact status`.
    this.log.info('compaction', {
      trigger: args.uiTrigger,
      announced: announced !== null,
      before,
      after,
      droppedMessages: applied?.droppedMessages ?? 0,
      mode,
      model,
      durationMs,
    });

    // A SILENT DECLINE (quiet-noop §3.1). No card was opened, so there is nothing
    // to settle and nothing to say IN THE TRANSCRIPT. Returning here is what makes
    // a declined checkpoint indistinguishable from one at which `shouldCompact`
    // said no.
    //
    // `declined` IS THE ONE THING THAT STILL SPEAKS (D-9). Quiet is the goal;
    // invisible is not, and `/compact status` is a published guaranteed surface
    // (`context-auto-compaction` §6.5). One integer here is what keeps that
    // promise true while the card goes away.
    if (!announced) {
      this.declined += 1;
      return outcome;
    }

    const record: CompactionRecord = {
      index: announced.index,
      trigger: args.uiTrigger,
      mode,
      // OPTIMISTIC AND CORRECTED BY THE WIRING (§3.2.1). Only the ENGINE knows
      // whether the splice passed the structural gate, and it says so on
      // `compaction_end`; the wiring rewrites this before the card settles.
      applied: outcome.action === 'replace',
      ...(outcome.action === 'keep' ? { reason: outcome.reason } : {}),
      ...(outcome.action === 'replace' && outcome.reason ? { reason: outcome.reason } : {}),
      messagesBefore: before,
      messagesAfter: after,
      tokensBefore,
      tokensAfter: 0, // filled by the wiring from the engine's own estimator
      ...(applied?.summary ? { summary: applied.summary } : {}),
      model,
      durationMs,
      ...(args.ctx.trigger === 'overflow' ? { keepRecentTurnsUsed } : {}),
      ...(args.tailRelief ? { tailRelief: args.tailRelief } : {}),
    };

    this.deps.emit({ type: 'compaction_end', record });
    return outcome;
  }

  // =========================================================================
  // Reporting helpers
  // =========================================================================

  /**
   * The pressure the trigger and the gauge both read - MEASURED NOW.
   *
   * A FORWARDER since W1: the decision point supplies its own authoritative
   * `lastUsage` (the probe's), and the meter owns everything else. `messages` /
   * `systemPrompt` stay in the signature and are ignored, because the meter
   * reads the LIVE history through its own deps - which is strictly better than
   * a caller that could pass `[]` and get a 0 % reading (the old default here).
   */
  measure(
    probe: Pick<CompactionProbe, 'lastUsage'> & {
      messages?: readonly Message[];
      systemPrompt?: string;
    },
  ): Pressure {
    return this.meter().measureWith(probe.lastUsage);
  }

  /**
   * The last pressure PUBLISHED. NEVER re-measured - `lastPublished`, not
   * `current` (I-10 / RV-3).
   *
   * `finish()` below reads this for `tokensBefore`, which is the sole upstream of
   * `tokensReclaimed`, the card's "reclaimed N tokens" and `/compact status`'s
   * session total. All three want the occupancy BEFORE the splice. Point this at
   * `meter.current()` and the moment the meter is dirty - which after a splice it
   * always is - `tokensBefore` becomes the POST-compaction figure, `reclaimed`
   * collapses to 0, and the card renders that with nothing logging a fault.
   */
  lastMeasured(): Pressure | null {
    return this.meter().lastPublished();
  }

  /** Written by the wiring once the engine has reported its verdict. */
  recordApplied(tokensBefore: number, tokensAfter: number): void {
    const reclaimed = Math.max(0, tokensBefore - tokensAfter);
    this.tokensReclaimed += reclaimed;
  }

  sessionTotals(): {
    compactions: number;
    /** Checkpoints that declined before committing to any work (quiet-noop D-9). */
    declined: number;
    tokensReclaimed: number;
    usage: TokenUsage;
    pricingUnknown: boolean;
    inFlight: boolean;
    selfDisabled: boolean;
    selfDisabledReason?: string;
    generation: number;
  } {
    return {
      compactions: this.compactions,
      declined: this.declined,
      tokensReclaimed: this.tokensReclaimed,
      usage: this.sessionUsage,
      pricingUnknown: this.pricingUnknown,
      inFlight: this.inFlight,
      selfDisabled: this.selfDisabled,
      ...(this.selfDisabledReason ? { selfDisabledReason: this.selfDisabledReason } : {}),
      generation: this.generation,
    };
  }

  /** `/compact on` after a self-disable — the user overriding the guard. */
  clearSelfDisable(): void {
    this.selfDisabled = false;
    this.selfDisabledReason = undefined;
    this.consecutiveNoProgress = 0;
  }

  isSelfDisabled(): boolean {
    return this.selfDisabled;
  }

  /**
   * Which model summarizes (§3.6.4).
   *
   * SAY THE DEFAULT OUT LOUD (P2-8): FOR ALMOST EVERYONE THIS IS THE MAIN MODEL.
   * `resolveFastTier` returns `{ok: false, reason: 'disabled'}` on
   * `fast.enabled !== true` alone, and `fast.enabled` defaults to `false` — so
   * `useFastTier: true` describes a PREFERENCE, not the common path, and the
   * out-of-the-box first compaction is a ~30 k-token call on the session's own
   * model. Three things make that the right trade rather than a hidden cost: it
   * happens at most `maxPerRun` times per run, the alternative is losing the
   * entire run, and the spend is on the card with the summarizer's own price.
   */
  resolveSummarizer(): SummarizerChoice | null {
    const config = this.deps.getConfig();
    if (config.compaction.useFastTier) {
      const tier = this.deps.resolveFastCandidate?.() ?? resolveFastTier(config, this.deps.hasKey);
      if (tier.ok) return { ref: tier.ref, role: 'fast', fromFastTier: true };
    }
    const ref = this.mainRef();
    if (!this.deps.hasKey(ref.providerId, this.deps.mainRole ?? 'main')) return null;
    return { ref, role: this.deps.mainRole ?? 'main', fromFastTier: false };
  }

  /**
   * The meter this compactor reads, injected or private (R-1).
   *
   * MEMOIZED, because a fresh meter on every call would have no `estimateOffset`
   * and no cached pressure - `lastMeasured()` would answer `null` forever and
   * `tokensReclaimed` would sit at 0. The fallback exists so the ten existing
   * `compaction-*.test.ts` construction sites compile unchanged; production
   * injects, and `context-gauge-wiring.test.ts` asserts the single instance.
   */
  private meter(): ContextMeter {
    if (this.deps.meter) return this.deps.meter;
    if (!this.ownMeter) {
      this.ownMeter = new ContextMeter({
        getMessages: () => this.deps.getMessages(),
        getSystemPrompt: () => this.deps.getSystemPrompt(),
        getModelInfo: () => this.modelInfo(),
        isWindowKnown: () => this.deps.isPricedModel(this.mainRef()),
        getWindowOverride: () => this.deps.getConfig().contextWindow,
      });
    }
    return this.ownMeter;
  }

  private mainRef(): ModelRef {
    const config = this.deps.getConfig();
    return {
      providerId: config.provider,
      modelId: config.model,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    };
  }

  private modelInfo(): ModelInfo {
    return this.deps.getModelInfoFor(this.mainRef());
  }

  private effectiveMaxOutputTokens(): number {
    const config = this.deps.getConfig();
    // `undefined` means AUTO; the model's own ceiling is the honest bound then.
    return config.maxTokens ?? this.modelInfo().maxOutputTokens;
  }

  private noteUsage(ref: ModelRef, usage: TokenUsage): void {
    this.sessionUsage = accumulateUsage(this.sessionUsage, usage);
    // UNKNOWN PRICING IS NOT ZERO PRICING. It is sticky: once a summarization has
    // run on an unpriced model the session total is no longer a complete figure,
    // and a later priced call does not make it one again.
    if (!this.deps.isPricedModel(ref)) this.pricingUnknown = true;
    this.deps.emit({ type: 'usage', usage });
  }
}

/** A "turn" is a `user`-role message; `tool_result` is a separate role. */
function countUserTurns(messages: readonly Message[]): number {
  return messages.reduce((acc, m) => (m.role === 'user' ? acc + 1 : acc), 0);
}

/**
 * The relief-only outcome, recognized by the one reason string that produces it.
 *
 * A REASON RATHER THAN A NEW `mode` ON THE PORT (DH-5): `CompactionOutcome.mode`
 * is a public contract with two members, and widening it to carry a distinction
 * only the CLI's card acts on would be a breaking change for a reporting nicety.
 */
function reliefOnly(outcome: CompactionOutcome): boolean {
  return outcome.action === 'replace' && outcome.reason === 'tail_relief_only';
}
