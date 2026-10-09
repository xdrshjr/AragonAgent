/**
 * `ContextMeter` - the ONE owner of "how full is the context right now"
 * (context-usage-gauge-accuracy §3.2 / W1).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts::inScope`). If this module is ever moved to a new tree, the
 * scanner's hardcoded directory list must be widened IN THE SAME COMMIT - a
 * scanner that silently stops scanning is worse than no scanner, and this
 * package has paid for that edit eleven times (I-7).
 *
 * IT LIVES HERE BUT IT IS NOT PART OF COMPACTION, and that is deliberate. The
 * whole point of this class is that occupancy is measurable when compaction is
 * OFF: `AgentController` builds a `CompactionWiring` only when
 * `compaction.enabled` is true, so a measurement owned by the compactor is
 * unreachable for exactly the sessions that most need a working gauge. It sits
 * in this directory because `pressure.ts` - the arithmetic it drives - already
 * does, and because moving it would cost a scanner edit for no gain (R-10).
 *
 * THE STATE MACHINE IN ONE PARAGRAPH. Every mutation of the history marks the
 * meter DIRTY; every read that finds it dirty re-measures SYNCHRONOUSLY. That
 * ordering is what removes the subscription-order dependency in the APPEND
 * direction: it does not matter whether this class or the compaction wiring
 * hears `tool_execution_end` first, because whoever reads gets a number that
 * includes the appended message either way (I-2). It does NOT remove the
 * dependency in the REPLACE direction - a splice does not announce itself to a
 * listener that has not run yet - which is why the splice marks this dirty from
 * `CompactionWiring.settlePending`'s own synchronous code (I-9), and why
 * `current()` carries a structural belt for a missed invalidation site.
 */

import type { AgentEvent, Message, ModelInfo, TokenUsage } from '@aragon-agent/core';
import { computeEstimateOffset, computePressure } from './pressure.js';
import type { ContextUsageSnapshot, Pressure } from './types.js';

/**
 * How long a scheduled publish waits.
 *
 * IT MUST BE A DELAY, NOT ZERO, AND NOT A SYNCHRONOUS MEASUREMENT (I-3). The
 * loop emits `tool_execution_end` BEFORE it pushes the `tool_result` message, so
 * anything that measures inside that event measures a history missing the single
 * largest message of the turn - silently, and every turn. A `setTimeout` is
 * necessarily later than that synchronous push.
 *
 * 400 ms also caps the publish rate at 2.5 Hz, which together with the reducer's
 * identity short-circuit keeps a permanently visible row from becoming a
 * re-render source (R-3).
 */
export const CONTEXT_METER_TICK_MS = 400;

export interface ContextMeterDeps {
  /**
   * The engine's live history and system prompt.
   *
   * LAZY, and they must be: the controller constructs this before the `Agent`
   * exists, so a closure that touches `this.agent` is only valid from inside a
   * call made later.
   */
  getMessages(): readonly Message[];
  getSystemPrompt(): string;
  /** `ModelInfo` for the MAIN model. Re-read on every measurement - `/model` exists. */
  getModelInfo(): ModelInfo;
  /** Whether the STATIC model table knows this model, i.e. the window is real. */
  isWindowKnown(): boolean;
  /**
   * The user's `contextWindow` override, or `null` for AUTO. Re-read on every
   * measurement, so a live settings edit moves the denominator without a relaunch.
   */
  getWindowOverride(): number | null;
  getRequestVersion?(): number;
}

export type ContextUsageListener = (usage: ContextUsageSnapshot) => void;

/** A `setTimeout` handle in either host shape. */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * The projection `ViewState` and `/context` read (§4.1).
 *
 * THE ONLY CONVERTER between `Pressure` and `ContextUsageSnapshot`. Two of them
 * would eventually round the percentage differently, and "the status bar says 43
 * and `/context` says 44" is the exact class of disagreement this whole feature
 * exists to remove.
 */
export function toContextUsage(p: Pressure): ContextUsageSnapshot {
  return {
    occupied: p.occupied,
    ...(p.windowSource ? { windowSource: p.windowSource } : {}),
    window: p.contextWindow,
    // FROM `ratio`, NOT FROM A SECOND DIVISION. `computePressure` already
    // clamped it to [0, 1] and already decided what a zero window means.
    pct: Math.max(0, Math.min(100, Math.round(p.ratio * 100))),
    source: p.source,
    deltaTokens: p.deltaTokens,
    windowKnown: p.windowKnown,
    windowOverridden: p.windowOverridden,
  };
}

/** The reading a meter with nothing measured yet reports. */
export function emptyContextUsage(): ContextUsageSnapshot {
  return {
    occupied: 0,
    window: 0,
    pct: 0,
    source: 'estimate',
    deltaTokens: 0,
    windowKnown: false,
    windowOverridden: false,
  };
}

export class ContextMeter {
  private readonly listeners = new Set<ContextUsageListener>();
  private unsubscribe: (() => void) | null = null;
  private timer: TimerHandle | null = null;
  private disposed = false;

  /**
   * The authoritative usage of the last completed turn.
   *
   * Its presence is what selects `computePressure`'s MEASURED branch, so
   * dropping it is how every reset degrades to an estimate rather than to a
   * number describing a history that no longer exists.
   */
  private lastUsage: TokenUsage | undefined;
  /**
   * The systematic difference between what `estimatePromptTokens` counts and
   * what the provider bills (D-23) - chiefly the tool schemas.
   *
   * SURVIVES A SPLICE AND NOT A SESSION CHANGE (I-8). See `onHistorySpliced`.
   */
  private estimateOffset: number | undefined;
  /** `messages.length` at the `turn_end` that produced `lastUsage`. */
  private measuredPrefixLength: number | undefined;
  /** The last pressure PUBLISHED. Never re-derived on read - see `lastPublished`. */
  private last: Pressure | null = null;
  /** Whether the history has changed since the last measurement. */
  private dirty = true;
  private prefixLast: Message | undefined;
  private sampledPrompt: string | undefined;
  private sampledVersion: number | undefined;
  private publishedLength = -1;
  private publishedLast: Message | undefined;
  private publishedPrompt: string | undefined;
  private publishedVersion: number | undefined;


  constructor(private readonly deps: ContextMeterDeps) {}

  // =========================================================================
  // Reading
  // =========================================================================

  /**
   * Occupancy right now. FOR THE SCREEN.
   *
   * Re-measures synchronously when dirty (I-2), and publishes when it does - the
   * gauge has to fall in the SAME FRAME as the compaction that caused it (AC-1),
   * and the caller that triggers this re-measurement is `CompactionWiring`'s own
   * synchronous `snapshot()` inside `settlePending`. Leaving the publish to the
   * scheduled tick instead would be worse than slow: the tick fires only when
   * `dirty`, and this call is what clears it.
   *
   * NEVER THROWS. A meter that can throw is a status bar that can take the
   * process down.
   */
  current(): Pressure {
    // THE BELT (I-9), AND IT RUNS EVEN WHEN NOT DIRTY. The case it exists for is
    // a splice that NOBODY announced, and in that case a missing `dirty` flag is
    // precisely the symptom. `estimateAppendedTokens` bounds-checks too, but it
    // only zeroes the DELTA and keeps the wrong measured base, so that belt does
    // not cover this.
    this.refreshValidity();
    if (!this.dirty && this.last) return this.last;
    return this.measureAndPublish(this.lastUsage);
  }

  /**
   * The last pressure this meter PUBLISHED. FOR THE BOOKS. Never re-measures.
   *
   * `Compactor.lastMeasured()` forwards here and not to `current()`, and the
   * distinction is load-bearing (I-10): `compactor.ts`'s `tokensBefore` is the
   * sole upstream of `tokensReclaimed`, the card's "reclaimed N tokens" line and
   * `/compact status`'s session total. It wants the occupancy BEFORE the splice.
   * Wired to `current()` it would re-measure the already-spliced history, report
   * `reclaimed 0`, and render that number without a single log line about it.
   */
  lastPublished(): Pressure | null {
    return this.last;
  }

  /** The published projection, or a zeroed one before the first measurement. */
  currentUsage(): ContextUsageSnapshot {
    return toContextUsage(this.current());
  }

  // =========================================================================
  // Writing
  // =========================================================================

  /** Compatibility reads cannot establish or resurrect a provider sample. */
  measureWith(_lastUsage: TokenUsage | undefined): Pressure {
    return this.current();
  }

  /**
   * `turn_end` - the one moment in the whole flow that is FULLY measured.
   *
   * The loop emits it BEFORE pushing the assistant message, so the history right
   * now is exactly the history the reported `usage` was billed for: the offset
   * and the prefix length describe the same array by construction, and
   * `deltaTokens` is 0. Published immediately for that reason - there is no
   * better number to wait for.
   */
  onTurnEnd(usage: TokenUsage): void {
    const messages = this.deps.getMessages();
    const systemPrompt = this.readSystemPrompt();
    this.lastUsage = usage;
    this.estimateOffset = computeEstimateOffset(usage, messages, systemPrompt);
    this.measuredPrefixLength = messages.length;
    this.prefixLast = messages[messages.length - 1];
    this.sampledPrompt = systemPrompt;
    this.sampledVersion = this.deps.getRequestVersion?.() ?? 0;
    this.measureAndPublish(usage);
  }

  /**
   * A compaction spliced the history (I-8, the SHALLOW reset).
   *
   * `estimateOffset` IS KEPT, and that is the whole reason this method is not
   * `onHistoryReplaced`. The offset describes "what this toolset costs on this
   * model above what the estimator counts"; a splice changes neither the toolset
   * nor the model, so it is still valid - and it is the only calibration the
   * estimate branch has until the next `turn_end`. Dropping it makes the gauge
   * fall several thousand tokens too far and then visibly climb back on the next
   * turn, for no reason the user can see (I-5).
   *
   * IDEMPOTENT. Both `settlePending` (the authority, I-9) and this meter's own
   * `compaction_end` handler reach it, and the second one must cost nothing.
   */
  onHistorySpliced(): void {
    this.lastUsage = undefined;
    this.measuredPrefixLength = undefined;
    this.prefixLast = undefined;
    if (this.dirty) return;
    this.dirty = true;
    this.scheduleTick();
  }

  /**
   * The history came from somewhere else entirely (I-8, the DEEP reset):
   * `/clear`, `/reset`, `/resume`.
   *
   * `estimateOffset` GOES TOO, unlike the shallow reset above. `/resume` can
   * change the model in the same breath (`builtins.ts`'s restore path does), and
   * an offset carried across that is a calibration constant applied to something
   * it never calibrated. The first reading afterwards is therefore a bare
   * estimate - biased LOW, and corrected by the very next `turn_end`. Biased low
   * and self-correcting beats biased high and permanent.
   */
  onHistoryReplaced(): void {
    this.lastUsage = undefined;
    this.measuredPrefixLength = undefined;
    this.prefixLast = undefined;
    this.estimateOffset = undefined;
    this.sampledPrompt = undefined;
    this.sampledVersion = undefined;
    this.dirty = true;
    this.scheduleTick();
  }

  /**
   * Only the denominator moved (window override or model metadata refresh).
   *
   * DELIBERATELY NOT A RESET. The measured base is still a true statement about
   * the history, so throwing it away would trade a correct numerator for a whole
   * history estimate and produce a visible jump on a common operation. The
   * Changing the model connection or request environment requires the deep
   * invalidation path instead; its measurement is no longer transferable.
   */
  onWindowChanged(): void {
    this.dirty = true;
    this.current();
  }

  /**
   * Something was appended. Mark dirty, arrange a throttled publish, MEASURE
   * NOTHING (I-3).
   */
  scheduleTick(): void {
    this.dirty = true;
    // NO SUBSCRIBERS, NO TIMER (I-11). `AgentController` is shared with
    // `aragon exec`, where nothing reads this number; a headless run must not
    // pay a timer per tool call, and a pending tick must never be able to hold
    // the process open for an extra 400 ms. `current()` is unaffected - it
    // measures on demand, so `wiring.snapshot()` and `/context` still work in a
    // host with no UI.
    if (this.listeners.size === 0) return;
    if (this.timer !== null || this.disposed) return;
    const handle = setTimeout(() => {
      this.timer = null;
      if (!this.dirty || this.disposed) return;
      this.current();
    }, CONTEXT_METER_TICK_MS);
    // The other half of I-11: an armed tick must not keep the event loop alive.
    const unrefable = handle as unknown as { unref?: () => void };
    if (typeof unrefable.unref === 'function') unrefable.unref();
    this.timer = handle;
  }

  // =========================================================================
  // Plumbing
  // =========================================================================

  /** Publish to this meter's own subscribers. Returns an unsubscribe function. */
  subscribe(listener: ContextUsageListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribe to the lead agent's stream. IDEMPOTENT.
   *
   * THIS TABLE IS NOT THE SOURCE OF COMPACTION CORRECTNESS (I-9). The splice is
   * marked dirty by `CompactionWiring.settlePending` inside its own synchronous
   * code, BEFORE it emits either event, so a reader is correct regardless of
   * which listener the emitter reaches first. The `compaction_end` row below is
   * a second, idempotent path that serves the manual `/compact` route and any
   * future splicer.
   */
  attach(subscribe: (listener: (event: AgentEvent) => void) => () => void): void {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribe((event) => this.onAgentEvent(event));
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private onAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'turn_end':
        this.onTurnEnd(event.usage);
        return;
      case 'tool_execution_end':
        // DELAYED, NEVER SYNCHRONOUS. See `CONTEXT_METER_TICK_MS` (I-3).
        this.scheduleTick();
        return;
      case 'compaction_end':
        // The engine's verdict. `applied` means the history really was replaced.
        if (event.applied) this.onHistorySpliced();
        else this.scheduleTick();
        return;
      case 'agent_end':
        this.scheduleTick();
        return;
      default:
        // `message_update` is a STREAM event and is deliberately ignored (N-2):
        // the output tokens of an in-flight reply are not knowable until `done`,
        // and guessing them would add a third approximation to a number that
        // already carries two.
        return;
    }
  }

  /**
   * The structural belt for a missed invalidation site (I-9).
   *
   * A recorded prefix that is LONGER than the history it indexes describes an
   * array that no longer exists. Rather than merely zeroing the delta - which is
   * what `estimateAppendedTokens` does, keeping the wrong measured base - this
   * drops the base too and forces the estimate branch.
   *
   * THE COMPARISON IS STRICT, AND THAT BOUNDARY IS LOAD-BEARING (IF-1). The
   * design document wrote `length <= measuredPrefixLength`, which is off by one:
   * `turn_end` is emitted BEFORE the assistant message is pushed, so the instant
   * `onTurnEnd` records the prefix the history is EXACTLY that long. An
   * inclusive test therefore discards a measurement one statement after taking
   * it - but only when this meter's listener runs before the compaction wiring's,
   * because the wiring's `snapshot()` is what reads in that window. That is a
   * silent, subscription-order-dependent fallback to the estimate branch on
   * every single turn, which is the exact class of bug this feature exists to
   * remove. A measurement taken at length N describes every history of length
   * >= N; only a SHORTER one is impossible.
   *
   * Returns whether anything was discarded.
   */
  private discardStalePrefix(): boolean {
    if (this.measuredPrefixLength === undefined) return false;
    const messages = this.deps.getMessages();
    if (messages.length >= this.measuredPrefixLength &&
        messages[this.measuredPrefixLength - 1] === this.prefixLast) return false;
    this.lastUsage = undefined;
    this.measuredPrefixLength = undefined;
    this.prefixLast = undefined;
    return true;
  }

  /**
   * Measure, cache, clear the dirty flag, publish. The ONE write path.
   *
   * Every public mutator funnels through here so "what was published" and "what
   * is cached" cannot drift, which is what makes `lastPublished()` a meaningful
   * answer rather than a stale one.
   */
  private refreshValidity(): void {
    const messages = this.deps.getMessages();
    const prompt = this.readSystemPrompt();
    const version = this.deps.getRequestVersion?.() ?? 0;
    if (this.sampledPrompt !== undefined &&
        (prompt !== this.sampledPrompt || version !== this.sampledVersion)) {
      this.onHistoryReplaced();
    }
    if (this.discardStalePrefix()) this.dirty = true;
    const window = this.resolveWindow();
    const last = this.last;
    if (messages.length !== this.publishedLength ||
        messages[messages.length - 1] !== this.publishedLast ||
        prompt !== this.publishedPrompt || version !== this.publishedVersion ||
        window.contextWindow !== last?.contextWindow ||
        window.windowKnown !== last?.windowKnown ||
        window.windowOverridden !== last?.windowOverridden ||
        this.deps.getModelInfo().contextWindowSource !== last?.windowSource) this.dirty = true;
  }

  private measureAndPublish(lastUsage: TokenUsage | undefined): Pressure {
    const pressure = this.compute(lastUsage);
    const messages = this.deps.getMessages();
    this.publishedLength = messages.length;
    this.publishedLast = messages[messages.length - 1];
    this.publishedPrompt = this.readSystemPrompt();
    this.publishedVersion = this.deps.getRequestVersion?.() ?? 0;
    this.last = pressure;
    this.dirty = false;
    this.publish(pressure);
    return pressure;
  }

  private compute(lastUsage: TokenUsage | undefined): Pressure {
    const window = this.resolveWindow();
    return computePressure({
      ...(lastUsage ? { lastUsage } : {}),
      messages: this.deps.getMessages(),
      systemPrompt: this.readSystemPrompt(),
      contextWindow: window.contextWindow,
      windowSource: this.deps.getModelInfo().contextWindowSource,
      windowKnown: window.windowKnown,
      windowOverridden: window.windowOverridden,
      ...(this.estimateOffset !== undefined ? { estimateOffset: this.estimateOffset } : {}),
      ...(this.measuredPrefixLength !== undefined
        ? { measuredPrefixLength: this.measuredPrefixLength }
        : {}),
    });
  }

  /**
   * Where the denominator comes from, and whether it can be trusted.
   *
   * AN OVERRIDE MAKES THE WINDOW KNOWN (I-6): the user asserted it, so the `~`
   * that means "this denominator is a guess" has no business staying on the
   * percentage. `windowOverridden` travels separately so `/context` can still
   * name the source - a hand-typed window that is wrong is exactly the case that
   * most needs to be visible.
   */
  private resolveWindow(): {
    contextWindow: number;
    windowKnown: boolean;
    windowOverridden: boolean;
  } {
    const override = this.deps.getWindowOverride();
    if (override !== null && Number.isFinite(override) && override > 0) {
      return { contextWindow: override, windowKnown: true, windowOverridden: true };
    }
    return {
      contextWindow: this.deps.getModelInfo().contextWindow,
      windowKnown: this.deps.isWindowKnown(),
      windowOverridden: false,
    };
  }

  private readSystemPrompt(): string {
    return this.deps.getSystemPrompt();
  }

  private publish(pressure: Pressure): void {
    if (this.listeners.size === 0) return;
    const usage = toContextUsage(pressure);
    for (const listener of [...this.listeners]) {
      try {
        listener(usage);
      } catch {
        // One bad subscriber must not take the run down with it - the rule
        // `CompactionWiring.emit` and `TeamRuntime.emit` both already state.
      }
    }
  }
}
