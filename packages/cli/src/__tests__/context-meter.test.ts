/**
 * `ContextMeter`'s state machine (context-usage-gauge-accuracy §7.1, T1-T5 /
 * T9b / T9c).
 *
 * EVERY ASSERTION HERE GUARDS A SILENT FAILURE. None of the bugs this class was
 * written for produce an error, a log line or a crash: they produce a plausible
 * wrong number on a permanently visible row. So several of these tests assert
 * BOTH directions on purpose, and the ones that do say why - a one-directional
 * assertion passes just as happily against the implementation that has the bug.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Message, ModelInfo, TokenUsage } from '@aragon-agent/core';
import { CONTEXT_METER_TICK_MS, ContextMeter, toContextUsage } from '../compaction/meter.js';
import { getLogger } from '../logging/logger.js';

const MODEL: ModelInfo = {
  id: 'claude-sonnet-4-5',
  name: 'Sonnet',
  provider: 'anthropic',
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  supportsThinking: true,
  supportsTools: true,
  supportsImages: true,
  cost: { input: 3, output: 15 },
};

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 0 };
}

function assistant(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function toolResult(id: string, chars: number): Message {
  return { role: 'tool_result', toolCallId: id, content: 'r'.repeat(chars) };
}

/**
 * The history as it looks after the turn boundary.
 *
 * `+ 1` IS NOT AN OFF-BY-ONE TO TIDY AWAY (`pressure.ts::estimateAppendedTokens`):
 * `turn_end` is emitted before the assistant message is pushed, so the message
 * AT `measuredPrefixLength` is that assistant turn and its cost is already inside
 * `usage.outputTokens`. The delta therefore starts one past it, and a fixture
 * that appends a tool result without the assistant message in between measures a
 * delta of zero and looks like a bug in the meter.
 */
function afterTurn(measured: Message[], ...appended: Message[]): Message[] {
  return [...measured, assistant('the answer'), ...appended];
}

interface HarnessOpts {
  messages?: Message[];
  systemPrompt?: string;
  windowKnown?: boolean;
  windowOverride?: number | null;
}

function harness(opts: HarnessOpts = {}) {
  let messages: readonly Message[] = opts.messages ?? [];
  let windowOverride = opts.windowOverride ?? null;
  const meter = new ContextMeter({
    getMessages: () => messages,
    getSystemPrompt: () => opts.systemPrompt ?? '',
    getModelInfo: () => MODEL,
    isWindowKnown: () => opts.windowKnown !== false,
    getWindowOverride: () => windowOverride,
  });

  /** The agent-stream injector `attach` hands out. */
  let agent: ((event: never) => void) | null = null;
  const attach = (): void => {
    meter.attach((listener) => {
      agent = listener as (event: never) => void;
      return (): void => {
        agent = null;
      };
    });
  };

  return {
    meter,
    attach,
    emit: (event: unknown): void => (agent as ((e: unknown) => void) | null)?.(event),
    setMessages: (next: readonly Message[]): void => {
      messages = next;
    },
    setWindowOverride: (next: number | null): void => {
      windowOverride = next;
    },
  };
}

const USAGE: TokenUsage = { inputTokens: 100_000, outputTokens: 500 };

describe('history-bound measurements', () => {
  it('refreshes metadata without a timer and deeply invalidates request versions', () => {
    let model: ModelInfo = { ...MODEL, contextWindowSource: 'catalog' };
    let version = 0;
    const messages = [user('task')];
    const meter = new ContextMeter({ getMessages: () => messages,
      getSystemPrompt: () => 'sys', getModelInfo: () => model,
      isWindowKnown: () => true, getWindowOverride: () => null,
      getRequestVersion: () => version });
    meter.onTurnEnd(USAGE);
    model = { ...model, contextWindow: 150000, contextWindowSource: 'api' };
    expect(meter.current()).toMatchObject({ occupied: 100500, source: 'usage',
      contextWindow: 150000, windowSource: 'api' });
    version += 1;
    expect(meter.current().source).toBe('estimate');
    expect(meter.current().estimateOffset).toBeUndefined();
  });
  it('invalidates calibration after a splice when the prompt changes', () => {
    const messages = [user('task')];
    let prompt = 'old';
    const meter = new ContextMeter({ getMessages: () => messages,
      getSystemPrompt: () => prompt, getModelInfo: () => MODEL,
      isWindowKnown: () => true, getWindowOverride: () => null });
    meter.onTurnEnd(USAGE);
    meter.onHistorySpliced();
    expect(meter.current().estimateOffset).toBeGreaterThan(0);
    prompt = 'new request instructions';
    expect(meter.current().estimateOffset).toBeUndefined();
    expect(meter.current().occupied).toBeLessThan(1000);
  });
  it('keeps a valid sample when a new run has no usage', () => {
    const h = harness({ messages: [user('task')] });
    h.meter.onTurnEnd(USAGE);
    expect(h.meter.measureWith(undefined).occupied).toBe(100_500);
  });

  it('rejects equal-length replacement and cannot revive spliced usage', () => {
    const h = harness({ messages: [user('old')] });
    h.meter.onTurnEnd(USAGE);
    h.setMessages([user('new')]);
    expect(h.meter.current().source).toBe('estimate');
    h.meter.onHistorySpliced();
    expect(h.meter.measureWith(USAGE).source).toBe('estimate');
  });

  it('sees appended messages before a timer or notification', () => {
    const messages = [user('task')];
    const h = harness({ messages });
    h.meter.onTurnEnd(USAGE);
    h.setMessages(afterTurn(messages, user('x'.repeat(10_000))));
    expect(h.meter.current().occupied).toBeGreaterThan(100_500);
  });
});

describe('T1 - the fully measured moment', () => {
  it('turn_end yields source `usage` and a zero delta', () => {
    // `turn_end` is emitted BEFORE the assistant message is pushed, so the
    // history at that instant is EXACTLY what the provider billed for. It is the
    // only point in the whole flow where nothing is estimated.
    const h = harness({ messages: [user('a'), user('b')] });
    h.meter.onTurnEnd(USAGE);
    const p = h.meter.current();
    expect(p.source).toBe('usage');
    expect(p.deltaTokens).toBe(0);
    expect(p.occupied).toBe(100_500);
  });

  it('the reading is order-independent: a later read re-measures the appended slice', () => {
    const measured = [user('a'), user('b')];
    const h = harness({ messages: measured });
    h.meter.onTurnEnd(USAGE);
    h.setMessages(afterTurn(measured, toolResult('t', 120_000)));
    h.meter.scheduleTick();
    const p = h.meter.current();
    expect(p.source).toBe('usage');
    expect(p.deltaTokens).toBeGreaterThan(20_000);
  });
});

describe('T2 - the in-turn tick is DELAYED, never synchronous (I-3)', () => {
  it('tool_execution_end does not measure in the handler, and does after the timer', () => {
    // BOTH DIRECTIONS ARE REQUIRED. `agent-loop.ts` emits `tool_execution_end`
    // and only THEN pushes the `tool_result`, so an implementation that measures
    // inside the handler reads a history missing the largest message of the turn
    // - silently, every turn. Asserting only "it updates eventually" passes
    // against that implementation too.
    vi.useFakeTimers();
    try {
      const measured = [user('a'), user('b')];
      const h = harness({ messages: measured });
      h.attach();
      h.meter.subscribe(() => {});
      h.meter.onTurnEnd(USAGE);

      // The loop's ordering, reproduced: the event fires while the history is
      // still short.
      h.emit({ type: 'tool_execution_end', toolCallId: 't', toolName: 'read', isError: false, duration: 1, result: {} });
      const beforePush = h.meter.lastPublished();
      expect(beforePush?.deltaTokens).toBe(0);

      // ... and the message lands one synchronous statement later.
      h.setMessages(afterTurn(measured, toolResult('t', 120_000)));
      vi.advanceTimersByTime(CONTEXT_METER_TICK_MS + 1);
      expect(h.meter.lastPublished()!.deltaTokens).toBeGreaterThan(20_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('T3 / T3b - the two reset depths diverge on `estimateOffset` (I-8)', () => {
  /**
   * THE ASSERTION THAT MATTERS IS THE DIFFERENCE, NOT THE BRANCH.
   *
   * Both methods drop `lastUsage` and force the estimate branch, so a test that
   * only checks `source === 'estimate'` goes green against an implementation
   * where the two are the same method - which is exactly the P0 (RV-1) this pair
   * exists to prevent. Only the offset tells them apart.
   */
  function seededOffset(): { h: ReturnType<typeof harness>; offset: number } {
    const measured = [user('a'.repeat(400)), user('b'.repeat(400))];
    const h = harness({ messages: measured, systemPrompt: 'sys' });
    // A usage far above what the estimator counts, so the offset is large and
    // unmistakable.
    h.meter.onTurnEnd({ inputTokens: 50_000, outputTokens: 0 });
    const offset = h.meter.lastPublished()!.estimateOffset ?? 0;
    expect(offset).toBeGreaterThan(40_000);
    return { h, offset };
  }

  it('onHistorySpliced KEEPS the offset (the shallow reset)', () => {
    const { h, offset } = seededOffset();
    h.setMessages([user('the summary')]);
    h.meter.onHistorySpliced();
    const p = h.meter.current();
    expect(p.source).toBe('estimate');
    expect(p.estimateOffset).toBe(offset);
    // A splice changes neither the toolset nor the model, so the calibration is
    // still the only thing keeping the post-compaction estimate honest (I-5).
    expect(p.occupied).toBeGreaterThan(offset);
  });

  it('onHistoryReplaced DROPS the offset (the deep reset)', () => {
    const { h } = seededOffset();
    h.setMessages([user('a resumed session')]);
    h.meter.onHistoryReplaced();
    const p = h.meter.current();
    expect(p.source).toBe('estimate');
    expect(p.estimateOffset).toBeUndefined();
  });
});

describe('T3c - the structural belt for a missed invalidation site (I-9)', () => {
  it('a history SHORTER than the recorded prefix degrades to the estimate branch', () => {
    // NOTHING IS TOLD TO THE METER HERE. This is the "someone added a fourth
    // splicer and forgot to announce it" case, and the belt is the only thing
    // between it and a gauge reporting the pre-splice occupancy forever.
    // `estimateAppendedTokens` bounds-checks too, but it keeps the wrong
    // measured BASE and only zeroes the delta, which is why that is not enough.
    //
    // THE USAGE IS DELIBERATELY BELOW THE ESTIMATE, so `computeEstimateOffset`
    // clamps to 0 and the assertion below is about the BASE rather than about a
    // large carried offset masking it.
    const measured = [
      user('a'.repeat(40_000)),
      user('b'.repeat(40_000)),
      user('c'.repeat(40_000)),
      user('d'.repeat(40_000)),
    ];
    const h = harness({ messages: measured });
    h.meter.onTurnEnd({ inputTokens: 20_000, outputTokens: 0 });
    expect(h.meter.current().source).toBe('usage');
    expect(h.meter.current().occupied).toBe(20_000);

    h.setMessages([user('the summary')]);
    const p = h.meter.current();
    // Without the belt this reads `usage` / 20000 - the measured base for a
    // history that no longer exists.
    expect(p.source).toBe('estimate');
    expect(p.occupied).toBeLessThan(1000);
  });

  it('is STRICT: the turn_end instant, where length === prefix, is NOT stale (IF-1)', () => {
    // `turn_end` fires before the assistant push, so `measuredPrefixLength`
    // equals `messages.length` for one synchronous window - and the compaction
    // wiring reads inside it. An inclusive comparison discards the measurement
    // one statement after taking it, but only when this meter's listener runs
    // first, which is a subscription-order-dependent silent fallback on EVERY
    // turn.
    const measured = [user('a'), user('b')];
    const h = harness({ messages: measured });
    h.meter.onTurnEnd(USAGE);
    // Read again with the history untouched - exactly the wiring's `snapshot()`.
    expect(h.meter.current().source).toBe('usage');
  });
});

describe('T4 - dirty tracking', () => {
  it('re-measures when dirty and serves the cache when not', () => {
    const messages = [user('a')];
    let systemPromptReads = 0;
    const meter = new ContextMeter({
      getMessages: () => messages,
      // COUNTED ON THE SYSTEM PROMPT, not on `getMessages`: the structural belt
      // reads the message array on every `current()` by design (it must, or it
      // cannot notice a splice nobody announced), so that counter cannot
      // distinguish "measured" from "checked". The system prompt is read only by
      // a real measurement.
      getSystemPrompt: () => {
        systemPromptReads += 1;
        return '';
      },
      getModelInfo: () => MODEL,
      isWindowKnown: () => true,
      getWindowOverride: () => null,
    });
    const first = meter.current();
    expect(systemPromptReads).toBe(3);

    // Clean: the cache is served, byte for byte the same object.
    expect(meter.current()).toBe(first);
    expect(systemPromptReads).toBe(4);

    // Dirty: measured again. `scheduleTick` with no subscribers arms no timer
    // (I-11) but still marks dirty, which is exactly the state under test.
    meter.scheduleTick();
    expect(meter.current()).not.toBe(first);
    expect(systemPromptReads).toBe(7);
  });

  it('lastPublished NEVER re-measures - it is the accounting read (I-10)', () => {
    // `Compactor.lastMeasured()` forwards here, and `tokensBefore` (hence
    // `tokensReclaimed`, hence the card's "reclaimed N tokens") depends on it
    // answering with the PRE-splice figure.
    const measured = [user('a'), user('b')];
    const h = harness({ messages: measured });
    h.meter.onTurnEnd({ inputTokens: 150_000, outputTokens: 0 });
    const before = h.meter.lastPublished()!.occupied;

    h.setMessages([user('the summary')]);
    h.meter.onHistorySpliced();
    expect(h.meter.lastPublished()!.occupied).toBe(before);
    // ... while the SCREEN read does move.
    expect(h.meter.current().occupied).toBeLessThan(before);
  });
});

describe('T5 - disposal', () => {
  it('a scheduled publish does not fire after dispose()', () => {
    vi.useFakeTimers();
    try {
      const h = harness({ messages: [user('a')] });
      const seen: number[] = [];
      h.meter.subscribe((u) => seen.push(u.occupied));
      h.meter.scheduleTick();
      h.meter.dispose();
      vi.advanceTimersByTime(CONTEXT_METER_TICK_MS * 3);
      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('T9b - no subscribers, no timers (I-11)', () => {
  it('arms nothing while unsubscribed, and arms on the first tick after subscribing', () => {
    // BOTH DIRECTIONS. `aragon exec` builds an `AgentController` and reads this
    // number nowhere; an implementation that arms a timer and then finds no
    // listeners at fire time passes a one-directional test and still holds the
    // event loop open for 400 ms per tool call.
    vi.useFakeTimers();
    try {
      const h = harness({ messages: [user('a')] });
      h.meter.scheduleTick();
      expect(vi.getTimerCount()).toBe(0);

      // `current()` is deliberately NOT gated on subscribers: `/context` and
      // `wiring.snapshot()` must work in a host with no UI.
      expect(h.meter.current().occupied).toBeGreaterThan(0);

      h.meter.subscribe(() => {});
      h.meter.scheduleTick();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('T9c - an armed tick cannot hold the process open (I-11)', () => {
  it('calls unref() on the handle it schedules', () => {
    const unref = vi.fn();
    const original = globalThis.setTimeout;
    // A STUB RATHER THAN FAKE TIMERS, because what is under test is a property
    // of the HANDLE, and the fake-timer handle's shape is an implementation
    // detail of a dependency.
    (globalThis as { setTimeout: unknown }).setTimeout = ((): unknown => ({ unref })) as unknown;
    try {
      const h = harness({ messages: [user('a')] });
      h.meter.subscribe(() => {});
      h.meter.scheduleTick();
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as { setTimeout: unknown }).setTimeout = original;
    }
  });
});

describe('the denominator (I-6)', () => {
  it('an override makes the window KNOWN and flags itself as an override', () => {
    const h = harness({ messages: [user('a')], windowKnown: false, windowOverride: 1_000_000 });
    const p = h.meter.current();
    expect(p.contextWindow).toBe(1_000_000);
    // The user ASSERTED it, so the `~` has no business staying on the percentage
    // - but `/context` still has to be able to name who supplied the number,
    // which is why these are two booleans rather than one.
    expect(p.windowKnown).toBe(true);
    expect(p.windowOverridden).toBe(true);
  });

  it('falls back to the model table, carrying its own trustworthiness', () => {
    const h = harness({ messages: [user('a')], windowKnown: false });
    const p = h.meter.current();
    expect(p.contextWindow).toBe(200_000);
    expect(p.windowKnown).toBe(false);
    expect(p.windowOverridden).toBe(false);
  });

  it('onWindowChanged re-measures WITHOUT dropping the measured base (RV-13)', () => {
    const h = harness({ messages: [user('a'), user('b')] });
    h.meter.onTurnEnd({ inputTokens: 100_000, outputTokens: 0 });
    h.setWindowOverride(400_000);
    h.meter.onWindowChanged();
    const p = h.meter.current();
    // The numerator is still the measurement - swapping it for a whole-history
    // estimate would make `/model` produce a visible jump for no gain.
    expect(p.source).toBe('usage');
    expect(p.contextWindow).toBe(400_000);
  });
});

describe('toContextUsage', () => {
  it('takes the percentage from `ratio`, so it cannot disagree with the trigger', () => {
    const usage = toContextUsage({
      occupied: 86_000,
      contextWindow: 200_000,
      ratio: 0.43,
      headroom: 114_000,
      source: 'usage',
      windowKnown: true,
      windowOverridden: false,
      deltaTokens: 0,
    });
    expect(usage).toEqual({
      occupied: 86_000,
      window: 200_000,
      pct: 43,
      source: 'usage',
      deltaTokens: 0,
      windowKnown: true,
      windowOverridden: false,
    });
  });
});


describe('stable gate cost', () => {
  it('checks references without traversing a thousand-message history', () => {
    let reads = 0;
    const messages = Array.from({ length: 1000 }, () => new Proxy(user('x'.repeat(200)), {
      get(target, key, receiver) { reads += 1; return Reflect.get(target, key, receiver); },
    }));
    const h = harness({ messages });
    h.meter.current();
    reads = 0;
    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const start = performance.now();
      h.meter.current();
      samples.push(performance.now() - start);
    }
    expect(reads).toBe(0);
    samples.sort((a, b) => a - b);
    console.log(`stable gate: messages=1000, chars=200000, samples=100, P95=${samples[94]}ms`);
  });
});

// ---------------------------------------------------------------------------
// T10 - the zero-input defense (context-usage-zero-input-tokens B)
// ---------------------------------------------------------------------------

describe('T10 - a usage that measured no input side is not a measurement', () => {
  const GATEWAY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 245 };

  it('does not arm the measured branch - the gauge degrades to an honest estimate', () => {
    // THE §2.2 REPRO, INVERTED. Pre-fix, arming the measured branch with a
    // 0-input usage showed occupied=245 (0%) as `source: 'usage'` - a confident
    // zero that hid the `~`, starved the trigger and mis-priced the session.
    // Post-fix the same history reads as an estimate of the right magnitude.
    const messages: Message[] = [];
    for (let i = 0; i < 30; i += 1) {
      messages.push(user(`turn ${i}: ${'x'.repeat(2_000)}`));
      messages.push(assistant('answer '.repeat(200)));
    }
    const h = harness({ messages, systemPrompt: 'sys' });
    h.meter.onTurnEnd(GATEWAY_USAGE);
    const after = h.meter.currentUsage();
    expect(after.source).toBe('estimate');
    expect(after.occupied).toBeGreaterThan(20_000);
    expect(after.pct).toBeGreaterThan(0);
  });

  it('keeps an earlier good measurement and estimates only what was appended since', () => {
    // THE KIMI SHAPE: the gateway discloses input on most turns and drops it
    // on a few. A good measurement of a prefix that still exists is better
    // than a whole-history estimate - the history only grows between splices,
    // so "old good base + appended estimate" stays self-consistent.
    const measured = [user('a'), user('b')];
    const h = harness({ messages: measured });
    h.meter.onTurnEnd(USAGE);
    h.setMessages(afterTurn(measured, toolResult('t', 60_000)));
    h.meter.onTurnEnd(GATEWAY_USAGE);
    const p = h.meter.current();
    expect(p.source).toBe('usage');
    expect(p.deltaTokens).toBeGreaterThan(10_000);
    expect(p.occupied).toBeGreaterThan(100_500);
  });

  it('does not overwrite estimateOffset or the prefix bookkeeping', () => {
    // (a) With no earlier good measurement the offset stays undefined. Pre-fix
    //     a 245-token usage clamped it to 0, destroying the estimate branch's
    //     only calibration source for the rest of the session.
    const fresh = harness({ messages: [user('a')] });
    fresh.meter.onTurnEnd(GATEWAY_USAGE);
    expect(fresh.meter.current().estimateOffset).toBeUndefined();

    // (b) A seeded offset survives a later zero-input turn AND the splice that
    //     follows it (the shallow reset keeps it - I-5 / I-8).
    const measured = [user('a'.repeat(400)), user('b'.repeat(400))];
    const seeded = harness({ messages: measured, systemPrompt: 'sys' });
    seeded.meter.onTurnEnd({ inputTokens: 50_000, outputTokens: 0 });
    const offset = seeded.meter.lastPublished()!.estimateOffset ?? 0;
    expect(offset).toBeGreaterThan(40_000);
    seeded.setMessages([user('the summary')]);
    seeded.meter.onHistorySpliced();
    seeded.meter.onTurnEnd(GATEWAY_USAGE);
    const p = seeded.meter.current();
    expect(p.source).toBe('estimate');
    expect(p.estimateOffset).toBe(offset);
    expect(p.occupied).toBeGreaterThan(offset);
  });

  it('input 0 with a huge cache read IS a measurement and still arms the branch', () => {
    // Anthropic's `input_tokens` EXCLUDES cached tokens; a deeply cached turn
    // legitimately reports 0 uncached input. Rejecting it on `inputTokens`
    // alone would strand a correct gauge on the estimator - the input-side SUM
    // is the predicate, and this usage passes it.
    const h = harness({ messages: [user('a'), user('b')] });
    h.meter.onTurnEnd({ inputTokens: 0, cacheReadTokens: 90_000, outputTokens: 245 });
    const p = h.meter.current();
    expect(p.source).toBe('usage');
    expect(p.occupied).toBe(90_245);
  });

  it('S3-b: after a splice, the next zero-input turn_end does not collapse the gauge', () => {
    // The post-compaction reading must survive the FIRST gateway-style turn_end
    // after it. Pre-fix that turn re-armed the measured branch with a 0-input
    // usage and the gauge fell straight back to ~0% - the "compaction broke the
    // display" symptom (S3).
    const measured = [user('a'.repeat(400)), user('b'.repeat(400))];
    const h = harness({ messages: measured, systemPrompt: 'sys' });
    h.meter.onTurnEnd({ inputTokens: 50_000, outputTokens: 0 });
    h.setMessages([user('the summary')]);
    h.meter.onHistorySpliced();
    const afterSplice = h.meter.current();
    expect(afterSplice.source).toBe('estimate');

    h.setMessages([user('the summary'), user('the next task')]);
    h.meter.onTurnEnd(GATEWAY_USAGE);
    const p = h.meter.currentUsage();
    expect(p.source).toBe('estimate');
    expect(p.occupied).toBeGreaterThanOrEqual(afterSplice.occupied);
    expect(p.pct).toBeGreaterThan(0);
  });

  it('warns once per run, not once per turn', () => {
    // 10-09 alone saw 1,973 zero-input turns; a per-turn warn is a log flood
    // that teaches whoever reads the file to ignore it.
    const h = harness({ messages: [user('a'), user('b')] });
    const warn = vi.spyOn(getLogger(), 'warn');
    try {
      h.meter.onTurnEnd(GATEWAY_USAGE);
      h.meter.onTurnEnd(GATEWAY_USAGE);
      h.meter.onTurnEnd(GATEWAY_USAGE);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'compaction',
        'context_input_tokens_unreported',
        expect.objectContaining({ in: 0, out: 245 }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
