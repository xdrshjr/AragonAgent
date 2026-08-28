/**
 * `FastReviewer` — the injection window and everything that guards it
 * (fast-model-tier §3.5 / §8.1).
 *
 * THESE ARE THE P0 REGRESSION TESTS (RV-1). The interleaving AC-26 and AC-31
 * cover needs an abort landing inside a specific `await`, which is reproducible
 * in a replay test and effectively not by hand — so `steer()` being called ONLY
 * from the `tool_execution_end` that empties the batch, and a steered block
 * being RECOVERED when the loop never drains it, are asserted here and nowhere
 * else. A refactor that moves `steer()` into the `complete()` callback will look
 * tidier and will reintroduce R-1; this file is what stops it.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, AssistantMessage, LLMRequest, TokenUsage } from '@aragon-agent/core';
import { DEFAULT_FAST_CONFIG, type FastConfig } from '../config/schema.js';
import { FAST_LIMITS } from '../fast/limits.js';
import { FastReviewer } from '../fast/reviewer.js';
import type { FastEvent, FastReview, FastTier } from '../fast/types.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TIER: FastTier = {
  ok: true,
  ref: { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
  thinkingLevel: 'off',
  sameAsMain: false,
};

const USAGE: TokenUsage = { inputTokens: 40, outputTokens: 10 };

function answer(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], usage: USAGE };
}

interface Harness {
  reviewer: FastReviewer;
  emit(event: AgentEvent): void;
  steer: ReturnType<typeof vi.fn>;
  clearAllQueues: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
  notices: Array<[string, string]>;
  events: FastEvent[];
  reviews(): FastReview[];
  setAbortRequested(v: boolean): void;
  setUserSteerCount(n: number): void;
  setRunning(v: boolean): void;
  setTier(t: FastTier): void;
  now: { value: number };
}

function harness(
  opts: {
    fast?: Partial<FastConfig>;
    complete?: (providerId: string, request: LLMRequest) => Promise<AssistantMessage>;
  } = {},
): Harness {
  const listeners = new Set<(e: AgentEvent) => void>();
  const events: FastEvent[] = [];
  const notices: Array<[string, string]> = [];
  const state = {
    abortRequested: false,
    userSteerCount: 0,
    running: true,
    tier: TIER,
  };
  const now = { value: 1_000_000 };

  const steer = vi.fn();
  const clearAllQueues = vi.fn();
  const complete = vi.fn(
    opts.complete ?? (async () => answer('You edited schema.ts three times without testing.')),
  );

  const reviewer = new FastReviewer({
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    complete,
    steer,
    isRunning: () => state.running,
    isAbortRequested: () => state.abortRequested,
    userSteerCount: () => state.userSteerCount,
    clearAllQueues,
    getTier: () => state.tier,
    getConfig: () => ({ ...DEFAULT_FAST_CONFIG, enabled: true, model: 'claude-haiku-4-5', ...opts.fast }),
    available: () => state.tier.ok,
    getApiKey: () => 'k',
    emit: (e) => events.push(e),
    notify: (level, text) => notices.push([level, text]),
    now: () => now.value,
  });

  return {
    reviewer,
    emit: (event) => {
      for (const l of [...listeners]) l(event);
    },
    steer,
    clearAllQueues,
    complete,
    notices,
    events,
    reviews: () =>
      events.filter((e): e is Extract<FastEvent, { type: 'review_end' }> => e.type === 'review_end')
        .map((e) => e.review),
    setAbortRequested: (v) => {
      state.abortRequested = v;
    },
    setUserSteerCount: (n) => {
      state.userSteerCount = n;
    },
    setRunning: (v) => {
      state.running = v;
    },
    setTier: (t) => {
      state.tier = t;
    },
    now,
  };
}

/** An assistant message announcing `n` tool calls, as `turn_end` carries it. */
function turnEnd(n: number): AgentEvent {
  return {
    type: 'turn_end',
    message: {
      role: 'assistant',
      content: Array.from({ length: n }, (_, i) => ({
        type: 'tool_call' as const,
        toolCallId: `c${i}`,
        toolName: 'read_file',
        args: {},
      })),
    },
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function toolEnd(id: string): AgentEvent {
  return {
    type: 'tool_execution_end',
    toolCallId: id,
    toolName: 'read_file',
    result: { content: [] },
    isError: false,
    duration: 5,
  };
}

/** Let the stubbed `complete()` promise and its `.then` chain settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Replay `n` complete turns, each with one tool call, at cadence 1. */
async function runTurns(h: Harness, n: number): Promise<void> {
  h.emit({ type: 'agent_start' });
  for (let i = 0; i < n; i += 1) {
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();
  }
}

// ---------------------------------------------------------------------------
// The injection window (§3.5.4 / AC-20)
// ---------------------------------------------------------------------------

describe('the injection window - AC-20', () => {
  it('steers ONLY from the tool_execution_end that empties the batch', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 } });
    h.emit({ type: 'agent_start' });

    // Turn 1: two tool calls. The review resolves between them.
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(2));
    h.emit(toolEnd('c0'));
    await settle();
    // Nothing yet: the batch is not finished, so checkpoint 1 is not next.
    expect(h.steer).not.toHaveBeenCalled();

    h.emit(toolEnd('c1'));
    await settle();
    // Turn 1 sealed at the SECOND tool end, which both triggered the review and
    // — one turn later — is the window it will be delivered through.
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();

    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(h.steer.mock.calls[0]![0]).toContain('<fast_review');
  });

  it('wraps the block with the turn and model, because it arrives in the USER role', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 } });
    await runTurns(h, 3);
    expect(h.steer).toHaveBeenCalled();
    const block = h.steer.mock.calls[0]![0] as string;
    expect(block).toMatch(/^<fast_review turn="\d+" model="claude-haiku-4-5">/);
    expect(block.endsWith('</fast_review>')).toBe(true);
  });

  it('AC-25: an `ok` critique produces a card and NO steer', async () => {
    const h = harness({
      fast: { reviewEveryTurns: 1 },
      complete: async () => answer('OK - on track.'),
    });
    await runTurns(h, 3);
    expect(h.steer).not.toHaveBeenCalled();
    expect(h.reviews().some((r) => r.kind === 'ok')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The two abort guards (§3.5.4a / AC-26 / AC-31) - THE P0 PAIR
// ---------------------------------------------------------------------------

describe('guard 1 - do not steer into a requested abort (AC-26)', () => {
  it('drops the pending critique instead of queueing it', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 } });
    h.emit({ type: 'agent_start' });
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();

    // Esc lands inside the last tool's `await`: `AgentController.abort()` sets
    // the flag SYNCHRONOUSLY before `agent.abort()`, so the reviewer sees it
    // even though the loop has not broken yet.
    h.setAbortRequested(true);
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();

    expect(h.steer).not.toHaveBeenCalled();
    const dropped = h.reviews().filter((r) => r.kind === 'dropped');
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0]!.injected).toBe(false);
  });
});

describe('guard 2 - confirm the drain (AC-31)', () => {
  it('recovers a stranded block when it can prove it owns the queue', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 } });
    h.emit({ type: 'agent_start' });
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();

    // Second batch: the reviewer steers here...
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();
    expect(h.steer).toHaveBeenCalledTimes(1);

    // ...and the run ends WITHOUT an intervening `turn_start`. That is the
    // watchdog path: `Agent.abort()` is called directly, so guard 1 cannot see
    // it, and nothing clears the queues at `agent_end` (C-10).
    h.emit({ type: 'agent_end', messages: [] });

    expect(h.clearAllQueues).toHaveBeenCalledTimes(1);
    const stranded = h.reviews().find((r) => r.kind === 'dropped');
    expect(stranded).toBeDefined();
    expect(stranded!.detail).toContain('missed its window');
  });

  it('clears NOTHING when a user steer is queued, and warns instead (D-21)', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 } });
    h.emit({ type: 'agent_start' });
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();

    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();
    expect(h.steer).toHaveBeenCalledTimes(1);

    // The user typed something mid-run. `Agent` cannot remove ONE message, so
    // clearing would destroy what the user typed to tidy up after the harness.
    h.setUserSteerCount(1);
    h.emit({ type: 'agent_end', messages: [] });

    expect(h.clearAllQueues).not.toHaveBeenCalled();
    expect(h.reviews().some((r) => r.kind === 'dropped')).toBe(true);
  });

  it('`turn_start` IS the receipt: a delivered block is never recovered', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 } });
    await runTurns(h, 2);
    expect(h.steer).toHaveBeenCalledTimes(1);

    // The loop reached `turn_start`, which it cannot do without having passed
    // checkpoint 1 — so the block WAS drained.
    h.emit({ type: 'turn_start' });
    h.emit({ type: 'agent_end', messages: [] });
    expect(h.clearAllQueues).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Staleness, budgets, single-flight, failure policy
// ---------------------------------------------------------------------------

describe('staleness', () => {
  it('drops a critique that resolves after the run ended (R-4)', async () => {
    let release: ((m: AssistantMessage) => void) | null = null;
    const h = harness({
      fast: { reviewEveryTurns: 1 },
      complete: () => new Promise<AssistantMessage>((r) => (release = r)),
    });
    h.emit({ type: 'agent_start' });
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();

    h.emit({ type: 'agent_end', messages: [] });
    h.setRunning(false);
    release!(answer('too late'));
    await settle();

    expect(h.steer).not.toHaveBeenCalled();
    expect(h.reviews().some((r) => r.kind === 'dropped')).toBe(true);
  });

  it('discards a pending critique past `pendingMaxAgeMs` (RV-12)', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 } });
    h.emit({ type: 'agent_start' });
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();

    // One `task` dispatch is a single tool call that can run for minutes.
    h.now.value += FAST_LIMITS.pendingMaxAgeMs + 1;
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();

    expect(h.steer).not.toHaveBeenCalled();
    expect(h.reviews().some((r) => r.kind === 'dropped')).toBe(true);
  });

  it('discards a pending critique the run has overtaken by turns', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 } });
    h.emit({ type: 'agent_start' });
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();

    // Batches that end with the window closed (an aborted batch) still advance
    // `turns`; past `pendingMaxTurnsBehind` the advice describes a state that
    // has been rewritten.
    h.setAbortRequested(true);
    for (let i = 0; i < FAST_LIMITS.pendingMaxTurnsBehind + 1; i += 1) {
      h.emit({ type: 'turn_start' });
      h.emit(turnEnd(1));
      h.emit(toolEnd('c0'));
      await settle();
    }
    expect(h.steer).not.toHaveBeenCalled();
  });
});

describe('budgets and single-flight', () => {
  it('AC-22: at most ONE review call is in flight at a time', async () => {
    const h = harness({
      fast: { reviewEveryTurns: 1 },
      complete: () => new Promise<AssistantMessage>(() => {}),
    });
    await runTurns(h, 6);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('AC-23: at most `maxReviewsPerRun` reviews are STARTED per run', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 } });
    await runTurns(h, 40);
    expect(h.complete.mock.calls.length).toBe(FAST_LIMITS.maxReviewsPerRun);
  });

  it('AC-19: a review starts on turn `reviewEveryTurns` and not before', async () => {
    const h = harness({ fast: { reviewEveryTurns: 3 } });
    h.emit({ type: 'agent_start' });
    for (let turn = 1; turn <= 3; turn += 1) {
      h.emit({ type: 'turn_start' });
      h.emit(turnEnd(1));
      h.emit(toolEnd('c0'));
      await settle();
      expect(h.complete.mock.calls.length).toBe(turn === 3 ? 1 : 0);
    }
  });

  it('the budget resets per RUN, not per session', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 } });
    await runTurns(h, 40);
    h.emit({ type: 'agent_end', messages: [] });
    await runTurns(h, 2);
    expect(h.complete.mock.calls.length).toBeGreaterThan(FAST_LIMITS.maxReviewsPerRun);
  });

  it('does not review at all when `fast.review` is off', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1, review: false } });
    await runTurns(h, 5);
    expect(h.complete).not.toHaveBeenCalled();
  });
});

describe('failure policy (§3.5.5)', () => {
  it('AC-24: three NON-transient failures self-disable with exactly one warn', async () => {
    const h = harness({
      fast: { reviewEveryTurns: 1 },
      complete: async () => {
        throw Object.assign(new Error('no such model'), { errorType: 'invalid_request' });
      },
    });
    await runTurns(h, 6);

    expect(h.complete.mock.calls.length).toBe(FAST_LIMITS.maxConsecutiveFailures);
    expect(h.notices.filter(([level]) => level === 'warn')).toHaveLength(1);
    expect(h.notices[0]![1]).toContain('no such model');
  });

  it('AC-36: a busy provider (`rate_limit`) NEVER self-disables the reviewer (D-24)', async () => {
    const h = harness({
      fast: { reviewEveryTurns: 1 },
      complete: async () => {
        throw Object.assign(new Error('429'), { errorType: 'rate_limit' });
      },
    });
    await runTurns(h, 6);

    // Retry now lives inside `complete()`, so three "failures" can arrive from
    // one busy minute. Counting them equally would kill the reviewer for the
    // rest of the session over a condition that resolved on its own.
    expect(h.notices).toHaveLength(0);
    expect(h.complete.mock.calls.length).toBe(FAST_LIMITS.maxReviewsPerRun);
  });

  it('`overloaded` is transient for the same reason', async () => {
    const h = harness({
      fast: { reviewEveryTurns: 1 },
      complete: async () => {
        throw Object.assign(new Error('529'), { errorType: 'overloaded' });
      },
    });
    await runTurns(h, 6);
    expect(h.notices).toHaveLength(0);
  });

  it('a failure never aborts the run and always leaves a card (R-8)', async () => {
    const h = harness({
      fast: { reviewEveryTurns: 1 },
      complete: async () => {
        throw Object.assign(new Error('boom'), { errorType: 'server_error' });
      },
    });
    await runTurns(h, 2);
    expect(h.reviews().some((r) => r.kind === 'failed')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // A CANCELLATION IS NOT A FAILURE.
  //
  // The reviewer aborts its own in-flight `complete()` from three places that
  // mean "never mind" rather than "this is broken": `endRun()` (the run ended
  // first), `abort()` (the user pressed Esc) and `dispose()`. None of them is
  // evidence of a misconfigured tier, which is the ONLY thing self-disable
  // exists for (§3.5.5 / D-24).
  //
  // What makes this a live hazard rather than a theoretical one is the shape of
  // the error the abort produces. The retry layer returns SILENTLY on abort
  // (`retry.ts` G3 - deliberately, so a user Esc is not blamed on the network),
  // so the stream ends with no `done` and no `error`, and `consumeStream` throws
  // a BARE `Error('Stream ended without a done event')` carrying no `errorType`.
  // That is indistinguishable from a transport fault by inspection, so it used
  // to score a full strike.
  // -------------------------------------------------------------------------

  /** What `consumeStream` really throws once the retry layer swallows an abort. */
  const abortAsStreamEnd =
    () =>
    (_providerId: string, request: LLMRequest): Promise<AssistantMessage> =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          reject(new Error('Stream ended without a done event'));
        });
      });

  it('a review cancelled by the run ending is `dropped`, not `failed`', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 }, complete: abortAsStreamEnd() });

    h.emit({ type: 'agent_start' });
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();
    expect(h.complete).toHaveBeenCalledTimes(1);

    // The run finishes while the review is still open.
    h.emit({ type: 'agent_end', messages: [] });
    await settle();

    const reviews = h.reviews();
    expect(reviews.some((r) => r.kind === 'failed')).toBe(false);
    const dropped = reviews.find((r) => r.kind === 'dropped');
    expect(dropped).toBeDefined();
    expect(dropped!.detail).toBe('cancelled');
    // Never a card whose text is an internal stream message.
    expect(dropped!.detail).not.toContain('done event');
  });

  it('run-ends with a review open never self-disable the reviewer', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 }, complete: abortAsStreamEnd() });

    // Three separate runs, each ending while its review is still in flight -
    // ordinary behaviour for any run whose last turn answers without tools.
    for (let i = 0; i < FAST_LIMITS.maxConsecutiveFailures; i += 1) {
      h.emit({ type: 'agent_start' });
      h.emit({ type: 'turn_start' });
      h.emit(turnEnd(1));
      h.emit(toolEnd('c0'));
      await settle();
      h.emit({ type: 'agent_end', messages: [] });
      await settle();
    }

    // Self-disable is for a tier that will never work again on its own. A run
    // that simply ended is the opposite, and silently losing the reviewer for
    // the rest of the session over it - with a warn naming an internal stream
    // message - is the failure this asserts against.
    expect(h.notices).toHaveLength(0);

    // ... and the reviewer is still alive on the next run.
    h.emit({ type: 'agent_start' });
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();
    expect(h.complete).toHaveBeenCalledTimes(FAST_LIMITS.maxConsecutiveFailures + 1);
  });

  it('a TIMEOUT is still a strike, because the tier really is not answering', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ fast: { reviewEveryTurns: 1 }, complete: abortAsStreamEnd() });
      h.emit({ type: 'agent_start' });
      h.emit({ type: 'turn_start' });
      h.emit(turnEnd(1));
      h.emit(toolEnd('c0'));
      await vi.advanceTimersByTimeAsync(FAST_LIMITS.reviewTimeoutMs + 10);

      // The same `controller.abort()` and the same bare Error as above - only
      // the REASON differs, which is why the reason has to be recorded rather
      // than inferred from the error.
      expect(h.reviews().some((r) => r.kind === 'failed')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The cancellation protocol, pinned ACROSS the module split
// (fast-model-tier-hardening RV-H1 / AC-H16 / tests 14 and 15)
//
// WRITTEN BEFORE THE SPLIT AND CONFIRMED GREEN ON THE PRE-SPLIT CODE, per the
// repo's TDD rule and the round-2 review's first condition: a test authored
// after a refactor is written to match whatever the refactor produced.
//
// WHAT THEY GUARD. `review-call.ts` is the natural home for the
// `new AbortController()` the call aborts, and encapsulating it there is the
// obvious tidy-up. It is also the bug: once the controller is private to the
// call module, `cancelCall()` can no longer stamp `'cancelled'` BEFORE
// aborting, every cancelled review falls into the failure branch, and three
// ordinary runs self-disable the tier for the session behind a warn naming an
// internal stream message. That is round 1's IF-7, verbatim. It cannot be
// recovered from the error object - the retry layer returns silently on abort,
// so a cancel and a timeout arrive as byte-identical bare `Error`s - so the
// reason has to be RECORDED at the call site, in state the lifecycle can reach.
// ---------------------------------------------------------------------------

describe('a cancellation is never a strike, across the split (RV-H1 / AC-H16)', () => {
  /**
   * A `complete()` that either hangs until it is aborted - rejecting the way
   * the retry layer leaves it - or fails outright, switchable mid-test.
   */
  function cancellableHarness(): { h: Harness; mode: { value: 'hang' | 'fail' } } {
    const mode = { value: 'hang' as 'hang' | 'fail' };
    const h = harness({
      fast: { reviewEveryTurns: 1 },
      complete: (_providerId: string, request: LLMRequest): Promise<AssistantMessage> =>
        mode.value === 'fail'
          ? Promise.reject(Object.assign(new Error('boom'), { errorType: 'server_error' }))
          : new Promise<AssistantMessage>((_resolve, reject) => {
              request.signal?.addEventListener('abort', () => {
                reject(new Error('Stream ended without a done event'));
              });
            }),
    });
    return { h, mode };
  }

  /** One cadence-1 turn: starts a review that never answers on its own. */
  async function openReview(h: Harness): Promise<void> {
    h.emit({ type: 'turn_start' });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();
  }

  const CANCELLERS: Array<[string, (h: Harness) => void]> = [
    ['abort() - the user pressed Esc', (h) => h.reviewer.abort()],
    ['endRun() - the run finished first', (h) => h.emit({ type: 'agent_end', messages: [] })],
    ['dispose() - the session is going away', (h) => h.reviewer.dispose()],
  ];

  for (const [name, cancel] of CANCELLERS) {
    it(`${name} produces a dropped card and no warn`, async () => {
      const { h } = cancellableHarness();
      h.emit({ type: 'agent_start' });
      await openReview(h);
      expect(h.complete).toHaveBeenCalledTimes(1);

      cancel(h);
      await settle();

      const reviews = h.reviews();
      expect(reviews.some((r) => r.kind === 'failed')).toBe(false);
      const dropped = reviews.find((r) => r.kind === 'dropped');
      expect(dropped).toBeDefined();
      // Never a card whose text is an internal stream message.
      expect(dropped!.detail).not.toContain('done event');
      expect(h.notices).toHaveLength(0);
    });
  }

  it('three cancellations leave the strike count at ZERO (test 14)', async () => {
    const { h, mode } = cancellableHarness();

    // Three runs that each end with a review still open - the ordinary shape,
    // since a turn that answers without tools ends the run.
    for (let i = 0; i < FAST_LIMITS.maxConsecutiveFailures; i += 1) {
      h.emit({ type: 'agent_start' });
      await openReview(h);
      h.emit({ type: 'agent_end', messages: [] });
      await settle();
    }
    expect(h.notices).toHaveLength(0);

    // Now genuine transport faults. If the cancellations had scored, the FIRST
    // of these would trip the threshold; the count has to start from zero.
    mode.value = 'fail';
    h.emit({ type: 'agent_start' });
    await openReview(h);
    await openReview(h);
    expect(h.notices).toHaveLength(0);

    await openReview(h);
    expect(h.notices.filter(([level]) => level === 'warn')).toHaveLength(1);
    expect(h.notices[0]![1]).toContain('boom');
  });

  it('a TIMEOUT still scores exactly one strike (test 15)', async () => {
    vi.useFakeTimers();
    try {
      const { h, mode } = cancellableHarness();
      h.emit({ type: 'agent_start' });
      h.emit({ type: 'turn_start' });
      h.emit(turnEnd(1));
      h.emit(toolEnd('c0'));
      await vi.advanceTimersByTimeAsync(FAST_LIMITS.reviewTimeoutMs + 10);
      expect(h.reviews().some((r) => r.kind === 'failed')).toBe(true);
      expect(h.notices).toHaveLength(0);

      // One timeout plus two transport faults is three: the pair with the test
      // above is what proves the two paths are still DISTINGUISHABLE, which the
      // retry layer's silent-on-abort return makes impossible to recover from
      // the error object alone.
      mode.value = 'fail';
      for (let i = 0; i < 2; i += 1) {
        h.emit({ type: 'turn_start' });
        h.emit(turnEnd(1));
        h.emit(toolEnd('c0'));
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(h.notices.filter(([level]) => level === 'warn')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Structural containment (AC-H11 / AC-H16)
//
// The behavioural cases above prove the invariant HOLDS; these prove it is still
// LOCATED where the design puts it. Both are needed, because a split that
// threads the abort controller out through a callback could keep the behaviour
// and still hand the next author a protocol spread across two modules - which is
// the state the P0 came out of. This is the same mechanism `glyphs.test.ts` uses
// on this tree: scan the source, assert the property, fail loudly.
// ---------------------------------------------------------------------------

describe('the protocol stays in reviewer.ts (AC-H11 / AC-H16)', () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8');

  it('keeps the drain-confirmation guards', () => {
    const source = read('fast/reviewer.ts');
    for (const symbol of ['awaitingDrain', 'awaitingReviewIndex', 'recoverStranded']) {
      expect(source).toContain(symbol);
    }
  });

  it('keeps the cancellation protocol, and `review-call.ts` constructs no controller', () => {
    const reviewer = read('fast/reviewer.ts');
    for (const symbol of ['callAbort', 'callAbortReason', 'cancelCall', 'new AbortController()']) {
      expect(reviewer).toContain(symbol);
    }
    // The single highest-value line of round 2: encapsulating a controller with
    // the call it aborts is correct everywhere else in this codebase, and here
    // it silently reclassifies every cancelled review as a strike.
    expect(read('fast/review-call.ts')).not.toContain('new AbortController');
  });
});

describe('usage accounting', () => {
  it('emits the review`s spend, defaulting a missing `usage` to zeros (RV-11)', async () => {
    const withUsage = harness({ fast: { reviewEveryTurns: 1 } });
    await runTurns(withUsage, 1);
    expect(withUsage.events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: USAGE,
    });

    const without = harness({
      fast: { reviewEveryTurns: 1 },
      complete: async () => ({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }),
    });
    await runTurns(without, 1);
    // `computeCost(undefined, cost)` is a NaN that reaches the status bar and
    // stays there for the session, so the reviewer defaults rather than passing
    // the optional field through.
    expect(without.events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});

describe('the review request (§3.5.3)', () => {
  it('sends no tools, no thinking, temperature 0 and a hard output cap', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 } });
    await runTurns(h, 1);
    const request = h.complete.mock.calls[0]![1] as LLMRequest;
    expect(request.tools).toBeUndefined();
    // `thinkingLevel: 'off'` and `temperature: 0` are ONE choice: the Anthropic
    // adapter deletes `temperature` whenever a thinking budget is set.
    expect(request.thinkingLevel).toBe('off');
    expect(request.temperature).toBe(0);
    expect(request.maxTokens).toBe(FAST_LIMITS.reviewOutputTokens);
    expect(request.model).toBe('claude-haiku-4-5');
    expect(request.signal).toBeDefined();
  });
});

describe('the frame recorder is gated (RV-10 / AC-37)', () => {
  it('ignores every StreamEvent type other than `text_delta`', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 } });
    h.emit({ type: 'agent_start' });
    h.emit({ type: 'turn_start' });
    // An ALLOW-test, not a deny-list: `llm-api-retry-backoff` added two members
    // to `StreamEvent`, and a deny-list would have silently started recording
    // them. These are all forwarded through `message_update` by
    // `agent-loop.ts:170`.
    h.emit({ type: 'message_update', streamEvent: { type: 'thinking_delta', delta: 'SECRET' } });
    h.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'VISIBLE' } });
    h.emit(turnEnd(1));
    h.emit(toolEnd('c0'));
    await settle();

    const digest = (h.complete.mock.calls[0]![1] as LLMRequest).messages[0]!.content as string;
    expect(digest).toContain('VISIBLE');
    expect(digest).not.toContain('SECRET');
  });
});

describe('lifecycle', () => {
  it('`dispose()` is idempotent and unsubscribes', () => {
    const h = harness();
    h.reviewer.dispose();
    h.reviewer.dispose();
    h.emit({ type: 'agent_start' });
    expect(h.events).toHaveLength(0);
  });

  it('`setGoal` clamps to `goalChars`', async () => {
    const h = harness({ fast: { reviewEveryTurns: 1 } });
    h.reviewer.setGoal('g'.repeat(5000));
    await runTurns(h, 1);
    const digest = (h.complete.mock.calls[0]![1] as LLMRequest).messages[0]!.content as string;
    expect(digest.length).toBeLessThanOrEqual(FAST_LIMITS.digestMaxChars);
  });
});
