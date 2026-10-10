/**
 * Context occupancy and the trigger (context-auto-compaction §3.4).
 *
 * ASCII ONLY: `src/compaction/**` is inside the glyph scanner's scope.
 *
 * PURE. No clock, no config read, no I/O - every input arrives as an argument,
 * which is what lets the trigger and the status-bar gauge share one function and
 * be tested without a live session.
 */

import {
  CONTEXT_SAFETY_MARGIN_TOKENS,
  THINKING_HEADROOM_TOKENS,
  estimatePromptTokens,
  type Message,
  type TokenUsage,
} from '@aragon-agent/core';
import type { Pressure } from './types.js';

/**
 * How much of the window the conversation occupies, from ONE reported usage.
 *
 * THE CACHE TERMS ARE NOT DECORATION. Anthropic's `message_start` reports
 * `input_tokens` EXCLUDING cached tokens and puts them in
 * `cache_read_input_tokens` / `cache_creation_input_tokens`. This CLI never sends
 * `cache_control`, so on a direct connection they are absent and the sum is
 * unchanged - but any gateway or proxy that caches on the user's behalf makes
 * them non-zero, and the status bar's old formula
 * (`usage.inputTokens + usage.outputTokens`) silently UNDER-reports occupancy for
 * exactly those users. That is a live, pre-existing defect in the number this
 * feature triggers on.
 *
 * THIS SUM IS ONLY VALID FOR *ADDITIVE* CACHE FIELDS, AND THAT IS A PROVIDER-SIDE
 * INVARIANT RATHER THAN A PROPERTY OF `TokenUsage` (C-14 / P1-10). It holds today
 * because exactly one adapter writes those fields: `openai.ts` sets
 * `inputTokens = prompt_tokens` and `google.ts` sets it from `promptTokenCount`,
 * and NEITHER ever mentions `cacheReadTokens` / `cacheWriteTokens`. OpenAI's
 * `prompt_tokens` ALREADY INCLUDES cached tokens, so mapping
 * `prompt_tokens_details.cached_tokens` onto the existing field - a change that
 * reads as a pure improvement and would sail through review - turns this into a
 * double-count and fires compaction early on every OpenAI session, with the gauge
 * agreeing with it and nothing reporting a fault. A provider that reports an
 * INCLUSIVE total must add a DIFFERENTLY NAMED field. `compaction-pressure.test.ts`
 * scans the adapters so the trap fails loudly at the moment someone opens it.
 *
 * THE GAUGE AND THE TRIGGER MUST READ THIS SAME FUNCTION (R-11 / AC-3). If they
 * diverge, a user watching 78 % on the status bar sees compaction fire, concludes
 * the feature is broken, and turns it off.
 */
export function occupiedTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0) +
    usage.outputTokens
  );
}

/**
 * Whether a usage measured ANYTHING on the input side
 * (context-usage-zero-input-tokens B).
 *
 * THE EMPTY MEASUREMENT THIS EXISTS FOR. A turn that billed output tokens
 * while reporting inputTokens 0 AND no cache terms did not measure the
 * request - no real request is free of input. Anthropic-COMPATIBLE relays
 * emit exactly this shape (bigmodel on every turn, Kimi intermittently),
 * and the meter used to arm its measured branch with it: occupancy collapsed
 * to the turn's own outputTokens, the `~` honesty marker vanished with
 * `source: 'usage'`, and the trigger - which reads the same number - never
 * fired. The defense is to not trust such a usage as a measurement.
 *
 * THE CACHE TERMS ARE PART OF THE INPUT SIDE, DELIBERATELY. Anthropic's real
 * `input_tokens` EXCLUDES cached tokens, so a deeply cached turn reports a
 * tiny `input_tokens` next to a huge `cache_read_input_tokens`. That IS a
 * valid measurement (C-14), and judging on `inputTokens === 0` alone would
 * reject it and strand a correct gauge on the estimator.
 *
 * `outputTokens > 0` separates "the stream ran, billed output, and disclosed
 * no input" from a degenerate all-zero usage, which the reviewed predicate
 * deliberately does not speak for.
 *
 * SINGLE AUTHORITY. The meter consumes this, and any future observability
 * hint (fix C) must too: two inline copies of "did the gateway disclose
 * input" would drift apart exactly the way the gauge and the trigger once
 * could (R-11).
 */
export function isInputSideUnmeasured(usage: TokenUsage): boolean {
  const inputSide =
    usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return inputSide === 0 && usage.outputTokens > 0;
}

/**
 * The calibration offset for this turn (D-23 / P1-11).
 *
 * Clamped at 0: a NEGATIVE offset would mean the estimator over-counted, which
 * is possible for a tool-free session on a verbose model, and applying it would
 * make the fallback read LOWER than the raw estimate - moving the one number
 * that is already biased low further in the wrong direction.
 */
export function computeEstimateOffset(
  usage: TokenUsage,
  messages: readonly Message[],
  systemPrompt: string,
): number {
  const measured = occupiedTokens(usage);
  const estimated = estimatePromptTokens(messages as Message[], systemPrompt);
  return Math.max(0, measured - estimated);
}

export interface PressureInput {
  windowSource?: Pressure['windowSource'];
  /** Authoritative usage of the last completed turn, or `undefined` (§3.4.2). */
  lastUsage?: TokenUsage;
  messages: readonly Message[];
  systemPrompt: string;
  contextWindow: number;
  /** False when the window is `buildRuntimeModel`'s 128k placeholder. */
  windowKnown: boolean;
  /**
   * Whether `contextWindow` came from the user's `contextWindow` override
   * (context-usage-gauge-accuracy I-6). Defaults to `false`, so every existing
   * construction site is unchanged and the arithmetic below is untouched.
   */
  windowOverridden?: boolean;
  /** Carried from the last `turn_end`; applied to every ESTIMATED figure. */
  estimateOffset?: number;
  /**
   * The history LENGTH the measurement in `lastUsage` covered - i.e.
   * `messages.length` at the `turn_end` that produced it, BEFORE the assistant
   * message was pushed.
   *
   * `undefined` DISABLES THE DELTA ENTIRELY and reproduces round 1's behaviour
   * exactly, which is what makes a missed invalidation cost accuracy rather than
   * correctness.
   */
  measuredPrefixLength?: number;
}

/**
 * Tokens appended to the history since the measurement that produced `lastUsage`
 * (context-auto-compaction-hardening §3.2.2 / W1).
 *
 * `+ 1` SKIPS THE ASSISTANT MESSAGE, and that is not an off-by-one to tidy away:
 * `turn_end` is emitted BEFORE the push (`agent-loop.ts:478` / `:497`, and
 * `Agent.emit` is synchronous), so the message at index `measuredPrefixLength` is
 * the assistant turn whose cost is ALREADY inside `usage.outputTokens`. Counting
 * it again double-charges every turn.
 *
 * NO `estimateOffset` IS APPLIED HERE. That offset is the systematic difference
 * between what `estimatePromptTokens` counts and what the provider bills for a
 * WHOLE REQUEST - chiefly the tool schemas, which are sent once per request and
 * are already inside the measured base. It is a per-request constant, not a
 * per-message rate; adding it to a slice would inflate occupancy by several
 * thousand tokens on every turn and fire compaction early on short
 * conversations.
 *
 * BOUNDS-CHECKED RATHER THAN TRUSTED. If the recorded prefix no longer indexes
 * this array - a `/clear`, a `/resume`, a splice whose invalidation call was
 * missed - the delta is 0 and the function degrades to round 1's number.
 */
export function estimateAppendedTokens(
  messages: readonly Message[],
  measuredPrefixLength: number | undefined,
): number {
  if (measuredPrefixLength === undefined) return 0;
  const start = measuredPrefixLength + 1;
  if (start < 0 || start >= messages.length) return 0;
  return estimatePromptTokens(messages.slice(start) as Message[]);
}

/**
 * THE ONE RULE FOR "PART OF THIS NUMBER IS A GUESS" (§6.3).
 *
 * `Pressure.source` deliberately keeps two members: it answers "where did the
 * BASE come from", and a third member would force every existing consumer of the
 * union to be revisited for a distinction none of them acts on. The `~` question
 * is this function, and it has one test.
 */
export function isApproximate(p: Pressure): boolean {
  return p.source === 'estimate' || p.deltaTokens > 0;
}

/**
 * Occupancy right now, measured when there is a measurement and calibrated when
 * there is not.
 *
 * `source` is CARRIED, never re-derived, and it reaches the UI: the status bar
 * already renders a leading `~` when the window is unknown, and this widens that
 * to "the NUMBER is approximate too". Honesty about a guess is cheaper than a
 * support thread about a wrong percentage.
 */
export function computePressure(input: PressureInput): Pressure {
  const window = input.contextWindow > 0 ? input.contextWindow : 0;
  let occupied: number;
  let source: Pressure['source'];
  let deltaTokens = 0;

  if (input.lastUsage) {
    // THE MEASURED FIGURE STAYS AUTHORITATIVE FOR WHAT IT COVERS, and only the
    // messages appended since are estimated (W1 / DH-1). Mixing two units is the
    // trap D-23 warned about; this does not mix them, it adds a second term for
    // a range the first one demonstrably does not describe.
    const base = occupiedTokens(input.lastUsage);
    deltaTokens = estimateAppendedTokens(input.messages, input.measuredPrefixLength);
    occupied = base + deltaTokens;
    source = 'usage';
  } else {
    // Before the first turn_end there is no calibration. Keep the estimate
    // explicit: output reservations never authorize automatic compaction.
    const raw = estimatePromptTokens(input.messages as Message[], input.systemPrompt);
    occupied = raw + (input.estimateOffset ?? 0);
    source = 'estimate';
  }

  const ratio = window > 0 ? Math.max(0, Math.min(1, occupied / window)) : 0;
  return {
    occupied,
    ...(input.windowSource ? { windowSource: input.windowSource } : {}),
    contextWindow: window,
    ratio,
    headroom: Math.max(0, window - occupied),
    source,
    windowKnown: input.windowKnown,
    // PURE PASS-THROUGH. This function's arithmetic is unchanged by
    // context-usage-gauge-accuracy; the flag only travels with the number so
    // `/context` can name the denominator's source (I-6).
    windowOverridden: input.windowOverridden ?? false,
    ...(input.estimateOffset !== undefined ? { estimateOffset: input.estimateOffset } : {}),
    deltaTokens,
  };
}

/** Only actual occupancy authorizes automatic compaction. */
export function shouldCompactAt(p: Pressure, threshold: number): boolean {
  if (!Number.isFinite(p.occupied) || p.occupied < 0) return false;
  if (!Number.isFinite(p.contextWindow) || p.contextWindow <= 0) return false;
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 0.95) return false;
  return p.occupied / p.contextWindow >= threshold;
}

/** Capacity helper retained for the standalone tail-budget API, never a trigger. */
export function requiredHeadroom(req: { maxOutputTokens: number }): number {
  return req.maxOutputTokens + THINKING_HEADROOM_TOKENS + CONTEXT_SAFETY_MARGIN_TOKENS;
}
