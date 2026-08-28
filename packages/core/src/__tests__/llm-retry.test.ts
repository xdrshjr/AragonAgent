/**
 * `withRetry` and its arithmetic (llm-api-retry-backoff §11, AC-1...AC-14b).
 *
 * `now` / `sleep` / `random` are ALL INJECTED and no case in this file touches a
 * real timer, with exactly one exception: the abort test (AC-5) deliberately uses
 * the DEFAULT `sleep`, because "Esc is felt within a frame" is a property of that
 * implementation and injecting a fake would assert the design against itself.
 */

import { describe, expect, it } from 'vitest';
import { LLMError, classifyHttpError } from '../llm/provider.js';
import type { LLMProvider, LLMRequest } from '../llm/provider.js';
import type { AssistantMessage, ModelInfo, StreamEvent, TokenUsage } from '../llm/types.js';
import { ProviderRegistry } from '../llm/providers/index.js';
import {
  DEFAULT_RETRY_POLICY,
  RETRY_LIMITS,
  computeBackoffDelay,
  decide,
  isRetryableError,
  normalizePolicy,
  parseRetryAfterMs,
  withRetry,
  type RetryPolicy,
} from '../llm/retry.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const usage: TokenUsage = { inputTokens: 1, outputTokens: 2 };

function doneEvent(text = 'hi'): StreamEvent {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage,
    stopReason: 'end_turn',
  };
  return { type: 'done', message, usage };
}

function overloaded(retryAfterMs?: number): LLMError {
  return new LLMError(
    'anthropic API error 529: overloaded',
    'anthropic',
    'overloaded',
    true,
    529,
    undefined,
    retryAfterMs,
  );
}

function policy(patch: Partial<RetryPolicy> = {}): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...patch };
}

/** A stream factory that replays one scripted event array per attempt. */
function scripted(scripts: StreamEvent[][]): {
  make: () => AsyncIterableIterator<StreamEvent>;
  attempts: () => number;
} {
  let attempt = 0;
  const make = (): AsyncIterableIterator<StreamEvent> => {
    const script = scripts[Math.min(attempt, scripts.length - 1)] ?? [];
    attempt += 1;
    return (async function* () {
      for (const event of script) yield event;
    })();
  };
  return { make, attempts: () => attempt };
}

/** A deterministic clock whose `sleep` records what it was asked to wait. */
function fakeClock(start = 0): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  delays: number[];
} {
  let t = start;
  const delays: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      delays.push(ms);
      t += ms;
    },
    delays,
  };
}

async function collect(stream: AsyncIterableIterator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

/** A minimal `LLMProvider` over a scripted stream, for the registry cases. */
function fakeProvider(
  id: string,
  make: () => AsyncIterableIterator<StreamEvent>,
): LLMProvider {
  return {
    id,
    displayName: id,
    defaultBaseUrl: 'https://example.invalid',
    stream: () => make(),
    complete: async () => {
      throw new Error('provider.complete must not be called by the registry');
    },
    listModels: async (): Promise<ModelInfo[]> => [],
  };
}

const request: LLMRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  apiKey: 'k',
};

// ---------------------------------------------------------------------------
// AC-1 / AC-2 / AC-3 / AC-4 — the ladder
// ---------------------------------------------------------------------------

describe('withRetry — the happy path is untouched (AC-1)', () => {
  it('forwards exactly the scripted events and never sleeps', async () => {
    const script: StreamEvent[] = [
      { type: 'text_delta', delta: 'a' },
      { type: 'text_delta', delta: 'b' },
      doneEvent('ab'),
    ];
    const { make, attempts } = scripted([script]);
    const clock = fakeClock();

    const events = await collect(
      withRetry(make, {
        policy: policy(),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );

    expect(events).toEqual(script);
    expect(events.some((e) => e.type.startsWith('retry_'))).toBe(false);
    expect(clock.delays).toEqual([]);
    expect(attempts()).toBe(1);
  });
});

describe('withRetry — a recovered sequence (AC-2)', () => {
  it('emits one retry_scheduled/retry_attempt pair per retry and forwards no error', async () => {
    const { make } = scripted([
      [{ type: 'error', error: overloaded() }],
      [{ type: 'error', error: overloaded() }],
      [{ type: 'error', error: overloaded() }],
      [doneEvent('ok')],
    ]);
    const clock = fakeClock();

    const events = await collect(
      withRetry(make, {
        policy: policy({ jitter: false }),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );

    expect(events.filter((e) => e.type === 'retry_scheduled')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'retry_attempt')).toHaveLength(3);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events[events.length - 1]?.type).toBe('done');
    // The card ticks against `resumeAt`, so it has to be `now + delayMs`.
    const first = events.find((e) => e.type === 'retry_scheduled');
    expect(first).toMatchObject({
      attempt: 1,
      maxRetries: 10,
      delayMs: 1000,
      resumeAt: 1000,
      errorType: 'overloaded',
    });
  });
});

describe('withRetry — the full ten-step ladder (AC-3)', () => {
  it('waits exactly 1/2/4/8/16/30x5 seconds and then forwards the original error', async () => {
    let last: LLMError | undefined;
    let attempt = 0;
    const make = (): AsyncIterableIterator<StreamEvent> => {
      attempt += 1;
      last = overloaded();
      const error = last;
      return (async function* () {
        yield { type: 'error', error } as StreamEvent;
      })();
    };
    const clock = fakeClock();

    const events = await collect(
      withRetry(make, {
        policy: policy({ jitter: false }),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );

    expect(clock.delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000]);
    // 11 requests total: the initial attempt plus ten retries.
    expect(attempt).toBe(11);
    const terminal = events[events.length - 1];
    expect(terminal?.type).toBe('error');
    // IDENTITY, not shape: the consumer must see the provider's own error so
    // `formatStreamError`, `retryable` and any downstream `instanceof` behave.
    expect(terminal).toEqual({ type: 'error', error: last });
    expect((terminal as unknown as { error: LLMError }).error).toBe(last);
  });

  it('the budget never stops the tenth retry (the headline number must not be a lie)', () => {
    // 181 s worst case against a 240 s budget. If this inequality ever inverts,
    // `maxRetries: 10` silently becomes fewer.
    const p = normalizePolicy(policy({ jitter: false }));
    let total = 0;
    for (let i = 1; i <= p.maxRetries; i += 1) total += computeBackoffDelay(i, p);
    expect(total).toBe(181_000);
    expect(total).toBeLessThan(p.maxElapsedMs);
  });
});

describe('withRetry — a non-retryable failure (AC-4)', () => {
  it('forwards a 401 on the first failure without sleeping', async () => {
    const authError = new LLMError('bad key', 'anthropic', 'auth_error', false, 401);
    const { make, attempts } = scripted([[{ type: 'error', error: authError }]]);
    const clock = fakeClock();

    const events = await collect(
      withRetry(make, {
        policy: policy(),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );

    expect(events).toEqual([{ type: 'error', error: authError }]);
    expect(clock.delays).toEqual([]);
    expect(attempts()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC-5 / AC-5b / AC-6 — abort
// ---------------------------------------------------------------------------

describe('withRetry — abort during the backoff (AC-5)', () => {
  it('yields NO further event of any type and settles within a frame', async () => {
    const controller = new AbortController();
    const { make } = scripted([[{ type: 'error', error: overloaded() }], [doneEvent()]]);

    // THE DEFAULT `sleep`, on a 30-second wait. If it did not race the signal
    // this case would hang until the suite timeout rather than fail on an
    // assertion, which is the honest shape for "Esc must be felt immediately".
    const stream = withRetry(make, {
      policy: policy({ jitter: false, initialDelayMs: 30_000, maxDelayMs: 30_000 }),
      providerId: 'anthropic',
      modelId: 'm',
      signal: controller.signal,
    });

    const events: StreamEvent[] = [];
    const startedAt = Date.now();
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'retry_scheduled') controller.abort();
    }
    const elapsed = Date.now() - startedAt;

    // THE FULL SEQUENCE, not just "did not retry": an implementation that yields
    // the terminal error on the abort path passes the weaker assertion (G3 / P1-1).
    expect(events.map((e) => e.type)).toEqual(['retry_scheduled']);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe('registry.complete aborted mid-backoff (AC-5b)', () => {
  it('never rejects with a fabricated network_error', async () => {
    const controller = new AbortController();
    const registry = new ProviderRegistry({
      retryPolicy: policy({ jitter: false, initialDelayMs: 30_000, maxDelayMs: 30_000 }),
    });
    registry.register(
      fakeProvider(
        'fake',
        scripted([[{ type: 'error', error: overloaded() }], [doneEvent()]]).make,
      ),
    );

    // The abort lands while the wrapper is sleeping.
    setTimeout(() => controller.abort(), 20);
    let caught: unknown;
    try {
      await registry.complete('fake', { ...request, signal: controller.signal });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    // The point of G3: nothing here may blame the network for a user action.
    expect(caught).not.toBeInstanceOf(LLMError);
    expect((caught as { errorType?: unknown }).errorType).toBeUndefined();
    expect(String((caught as Error).message)).not.toMatch(/network/i);
  });
});

describe('isRetryableError — abort beats retryable (AC-6)', () => {
  it('refuses an AbortError-shaped failure when the signal is aborted', () => {
    // `wrapFetchError` marks an AbortError `retryable: true, errorType: 'timeout'`.
    const abortish = new LLMError('request aborted', 'anthropic', 'timeout', true);
    const aborted = AbortSignal.abort();
    expect(isRetryableError(abortish, aborted)).toEqual({ retry: false, reason: 'aborted' });
  });

  it('retries the SAME failure when the signal is not aborted (both directions)', () => {
    const abortish = new LLMError('request timed out', 'anthropic', 'timeout', true);
    const live = new AbortController().signal;
    expect(isRetryableError(abortish, live)).toEqual({ retry: true, reason: 'retryable' });
    expect(isRetryableError(abortish)).toEqual({ retry: true, reason: 'retryable' });
  });

  it('reads `retryable` structurally, never through instanceof', () => {
    expect(isRetryableError({ retryable: true })).toEqual({ retry: true, reason: 'retryable' });
    expect(isRetryableError({ retryable: 'true' })).toEqual({
      retry: false,
      reason: 'not_retryable',
    });
    expect(isRetryableError(undefined)).toEqual({ retry: false, reason: 'not_retryable' });
  });

  it('does not retry when the signal aborted, end to end', async () => {
    const controller = new AbortController();
    controller.abort();
    const { make } = scripted([[{ type: 'error', error: overloaded() }], [doneEvent()]]);
    const clock = fakeClock();
    const events = await collect(
      withRetry(make, {
        policy: policy(),
        providerId: 'anthropic',
        modelId: 'm',
        signal: controller.signal,
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    expect(events).toEqual([]);
    expect(clock.delays).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-7 / AC-8 / AC-13 — Retry-After
// ---------------------------------------------------------------------------

describe('Retry-After is a FLOOR, not a replacement (AC-7)', () => {
  const p = normalizePolicy(policy({ jitter: false }));

  it('raises the second retry above the ladder', () => {
    expect(computeBackoffDelay(2, p)).toBe(2000);
    expect(computeBackoffDelay(2, p, { retryAfterMs: 5000 })).toBe(5000);
  });

  it('does NOT shrink the ninth retry below the ladder', () => {
    expect(computeBackoffDelay(9, p)).toBe(30_000);
    expect(computeBackoffDelay(9, p, { retryAfterMs: 1000 })).toBe(30_000);
  });

  it('is ignored entirely when respectRetryAfter is off', () => {
    const off = normalizePolicy(policy({ jitter: false, respectRetryAfter: false }));
    expect(computeBackoffDelay(2, off, { retryAfterMs: 5000 })).toBe(2000);
  });

  it('never returns 0 and never exceeds the absolute ceiling', () => {
    const tiny = normalizePolicy(policy({ jitter: true, initialDelayMs: 100 }));
    expect(computeBackoffDelay(1, tiny, { random: () => 0 })).toBeGreaterThanOrEqual(
      RETRY_LIMITS.minDelayMs,
    );
    expect(computeBackoffDelay(1, p, { retryAfterMs: 10_000_000 })).toBe(
      RETRY_LIMITS.absoluteMaxDelayMs,
    );
  });
});

describe('an unreasonable Retry-After is surfaced, not waited out (AC-8)', () => {
  it('forwards the error immediately with reason retry_after_too_long', async () => {
    const error = overloaded(3_600_000);
    const { make, attempts } = scripted([[{ type: 'error', error }]]);
    const clock = fakeClock();

    const events = await collect(
      withRetry(make, {
        policy: policy({ jitter: false }),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );

    expect(events).toEqual([{ type: 'error', error }]);
    expect(clock.delays).toEqual([]);
    expect(attempts()).toBe(1);

    expect(
      decide({
        error,
        committed: false,
        retryIndex: 0,
        firstFailureAt: 0,
        candidateDelay: 1000,
        retryAfterMs: 3_600_000,
        policy: normalizePolicy(policy()),
        now: () => 0,
      }).reason,
    ).toBe('retry_after_too_long');
  });
});

describe('classifyHttpError (AC-13)', () => {
  it('classifies 408 as a retryable timeout', () => {
    const err = classifyHttpError(408, 'timed out', 'openai');
    expect(err.errorType).toBe('timeout');
    expect(err.retryable).toBe(true);
  });

  it('carries Retry-After out on the error', () => {
    const headers = new Headers({ 'retry-after': '7' });
    const err = classifyHttpError(429, 'slow down', 'openai', headers);
    expect(err.errorType).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(7000);
  });

  it('leaves retryAfterMs undefined when no headers are supplied', () => {
    expect(classifyHttpError(429, 'slow down', 'openai').retryAfterMs).toBeUndefined();
  });
});

describe('parseRetryAfterMs read order', () => {
  const now = (): number => Date.parse('2026-01-01T00:00:00Z');

  it('prefers retry-after, in seconds', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '3' }), now)).toBe(3000);
  });

  it('accepts an HTTP-date and never returns a negative', () => {
    expect(
      parseRetryAfterMs(new Headers({ 'retry-after': '2026-01-01T00:00:30Z' }), now),
    ).toBe(30_000);
    expect(
      parseRetryAfterMs(new Headers({ 'retry-after': '2025-01-01T00:00:00Z' }), now),
    ).toBe(0);
  });

  it('falls back to the OpenAI reset header, then to both Anthropic ones', () => {
    expect(parseRetryAfterMs(new Headers({ 'x-ratelimit-reset-after': '4' }), now)).toBe(4000);
    expect(
      parseRetryAfterMs(
        new Headers({ 'anthropic-ratelimit-requests-reset': '2026-01-01T00:00:12Z' }),
        now,
      ),
    ).toBe(12_000);
    // The TOKEN window is the one that bites on a long context, so it is read.
    expect(
      parseRetryAfterMs(
        new Headers({ 'anthropic-ratelimit-input-tokens-reset': '2026-01-01T00:00:20Z' }),
        now,
      ),
    ).toBe(20_000);
  });

  it('returns undefined for absent or unparseable values', () => {
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
    expect(parseRetryAfterMs(new Headers(), now)).toBeUndefined();
    expect(parseRetryAfterMs(new Headers({ 'retry-after': 'soon' }), now)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC-9c / AC-10 / AC-10b — contract violations and budgets
// ---------------------------------------------------------------------------

describe('an iterator that terminates with nothing (AC-9c)', () => {
  it('synthesises a retryable network_error and retries it', async () => {
    const { make, attempts } = scripted([[], [doneEvent('recovered')]]);
    const clock = fakeClock();
    const events = await collect(
      withRetry(make, {
        policy: policy({ jitter: false }),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    expect(events.filter((e) => e.type === 'retry_scheduled')).toHaveLength(1);
    expect(events[events.length - 1]?.type).toBe('done');
    expect(attempts()).toBe(2);
  });

  it('forwards a retryable LLMError when it cannot retry', async () => {
    const { make } = scripted([[]]);
    const events = await collect(
      withRetry(make, {
        policy: policy({ maxRetries: 0 }),
        providerId: 'anthropic',
        modelId: 'm',
        now: () => 0,
        sleep: async () => {},
      }),
    );
    expect(events).toHaveLength(1);
    const error = (events[0] as unknown as { error: LLMError }).error;
    expect(error).toBeInstanceOf(LLMError);
    expect(error.errorType).toBe('network_error');
    expect(error.retryable).toBe(true);
    // NAMES BOTH IDS. `agent-loop` throws a nearly identical sentence one layer
    // up, so a message without them cannot be told apart from that one in a bug
    // report — and this is the only thing that reads `modelId`.
    expect(error.message).toContain('anthropic/m');
  });
});

describe('the wall-clock budget (AC-10 / AC-10b)', () => {
  it('stops mid-ladder when the budget would be exceeded', async () => {
    const error = overloaded();
    const { make } = scripted([[{ type: 'error', error }]]);
    const clock = fakeClock();
    const events = await collect(
      withRetry(make, {
        // Room for 1000 + 2000 but not for the 4000 that would follow.
        policy: policy({ jitter: false, maxRetries: 10, maxElapsedMs: 6_000 }),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    expect(clock.delays).toEqual([1000, 2000]);
    expect(events[events.length - 1]).toEqual({ type: 'error', error });
  });

  it('is EVALUATED ON THE FIRST FAILURE, not only on a later one (AC-10b)', async () => {
    // The case a mis-ordered implementation computes as `now() - undefined +
    // delay` => NaN, which compares `false` and lets every first retry through.
    const error = overloaded();
    const { make, attempts } = scripted([[{ type: 'error', error }]]);
    const clock = fakeClock();
    const events = await collect(
      withRetry(make, {
        policy: policy({ jitter: false, initialDelayMs: 1000, maxElapsedMs: 500 }),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    expect(clock.delays).toEqual([]);
    expect(attempts()).toBe(1);
    expect(events).toEqual([{ type: 'error', error }]);

    expect(
      decide({
        error,
        committed: false,
        retryIndex: 0,
        firstFailureAt: 0,
        candidateDelay: 1000,
        policy: normalizePolicy(policy({ initialDelayMs: 1000, maxElapsedMs: 500 })),
        now: () => 0,
      }).reason,
    ).toBe('budget_exhausted');
  });
});

// ---------------------------------------------------------------------------
// AC-11 / AC-14 — the registry seam
// ---------------------------------------------------------------------------

describe('ProviderRegistry.complete goes through the retrying stream (AC-11)', () => {
  it('recovers a provider that fails twice and then succeeds', async () => {
    const registry = new ProviderRegistry({
      retryPolicy: policy({ jitter: false, initialDelayMs: RETRY_LIMITS.minDelayMs }),
    });
    registry.register(
      fakeProvider(
        'fake',
        scripted([
          [{ type: 'error', error: overloaded() }],
          [{ type: 'error', error: overloaded() }],
          [doneEvent('assembled')],
        ]).make,
      ),
    );

    const message = await registry.complete('fake', request);
    expect(message.content).toEqual([{ type: 'text', text: 'assembled' }]);
  });
});

describe('the off-path is byte-identical (AC-14)', () => {
  it('returns the adapter iterator DIRECTLY when maxRetries is 0', () => {
    const marker = (async function* () {
      yield doneEvent();
    })();
    const registry = new ProviderRegistry({ retryPolicy: policy({ maxRetries: 0 }) });
    registry.register(fakeProvider('fake', () => marker));
    expect(registry.stream('fake', request)).toBe(marker);
  });

  it('returns the adapter iterator DIRECTLY when the policy is null', () => {
    const marker = (async function* () {
      yield doneEvent();
    })();
    const registry = new ProviderRegistry({ retryPolicy: null });
    registry.register(fakeProvider('fake', () => marker));
    expect(registry.getRetryPolicy()).toBeNull();
    expect(registry.stream('fake', request)).toBe(marker);
  });

  it('installs the product default when no option is supplied', () => {
    expect(new ProviderRegistry().getRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
    // `undefined` means "the default"; only an explicit `null` opts out.
    expect(new ProviderRegistry({}).getRetryPolicy()).toEqual(DEFAULT_RETRY_POLICY);
  });

  it('setRetryPolicy takes effect live', () => {
    const marker = (async function* () {
      yield doneEvent();
    })();
    const registry = new ProviderRegistry();
    registry.register(fakeProvider('fake', () => marker));
    expect(registry.stream('fake', request)).not.toBe(marker);
    registry.setRetryPolicy(null);
    expect(registry.stream('fake', request)).toBe(marker);
  });
});

// ---------------------------------------------------------------------------
// AC-12 / AC-12b — the commit point
// ---------------------------------------------------------------------------

describe('mid-stream restart (AC-12)', () => {
  it('emits stream_restart carrying every tool_call_start id of the failed attempt', async () => {
    const { make } = scripted([
      [
        { type: 'text_delta', delta: 'partial' },
        { type: 'tool_call_start', toolCallId: 't1', toolName: 'read_file' },
        { type: 'tool_call_start', toolCallId: 't2', toolName: 'bash' },
        { type: 'error', error: overloaded() },
      ],
      [doneEvent('full')],
    ]);
    const clock = fakeClock();
    const events = await collect(
      withRetry(make, {
        policy: policy({ jitter: false }),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );

    const restart = events.find((e) => e.type === 'stream_restart');
    expect(restart).toEqual({
      type: 'stream_restart',
      attempt: 1,
      discardedToolCallIds: ['t1', 't2'],
    });
    // Order matters: the consumer must be told to rewind BEFORE it is told to wait.
    const types = events.map((e) => e.type);
    expect(types.indexOf('stream_restart')).toBeLessThan(types.indexOf('retry_scheduled'));
  });

  it('forwards the failure immediately when onPartialStream is off', async () => {
    const error = overloaded();
    const { make, attempts } = scripted([
      [{ type: 'text_delta', delta: 'partial' }, { type: 'error', error }],
      [doneEvent()],
    ]);
    const clock = fakeClock();
    const events = await collect(
      withRetry(make, {
        policy: policy({ jitter: false, onPartialStream: false }),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    expect(attempts()).toBe(1);
    expect(events).toEqual([{ type: 'text_delta', delta: 'partial' }, { type: 'error', error }]);
  });
});

describe('the commit point includes thinking_start (AC-12b)', () => {
  it('treats a thinking_start-only attempt as committed', async () => {
    const { make } = scripted([
      [{ type: 'thinking_start' }, { type: 'error', error: overloaded() }],
      [doneEvent()],
    ]);
    const clock = fakeClock();
    const events = await collect(
      withRetry(make, {
        policy: policy({ jitter: false }),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    expect(events.find((e) => e.type === 'stream_restart')).toEqual({
      type: 'stream_restart',
      attempt: 1,
      discardedToolCallIds: [],
    });
  });

  it('emits no stream_restart when nothing was forwarded', async () => {
    const { make } = scripted([[{ type: 'error', error: overloaded() }], [doneEvent()]]);
    const clock = fakeClock();
    const events = await collect(
      withRetry(make, {
        policy: policy({ jitter: false }),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    expect(events.some((e) => e.type === 'stream_restart')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-14b — the structural clamp bites at THIS boundary
// ---------------------------------------------------------------------------

describe('normalizePolicy is enforced by withRetry, not only by the CLI (AC-14b)', () => {
  it('caps maxRetries at hardMaxRetries however large the policy says', async () => {
    let attempt = 0;
    const make = (): AsyncIterableIterator<StreamEvent> => {
      attempt += 1;
      return (async function* () {
        yield { type: 'error', error: overloaded() } as StreamEvent;
      })();
    };
    const clock = fakeClock();
    await collect(
      withRetry(make, {
        policy: policy({ jitter: false, maxRetries: 5000, maxElapsedMs: 30 * 60_000 }),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    expect(clock.delays).toHaveLength(RETRY_LIMITS.hardMaxRetries);
    expect(attempt).toBe(RETRY_LIMITS.hardMaxRetries + 1);
  });

  it('never waits longer than absoluteMaxDelayMs however large maxDelayMs says', async () => {
    let attempt = 0;
    const make = (): AsyncIterableIterator<StreamEvent> => {
      attempt += 1;
      return (async function* () {
        yield { type: 'error', error: overloaded() } as StreamEvent;
      })();
    };
    const clock = fakeClock();
    await collect(
      withRetry(make, {
        policy: policy({
          jitter: false,
          maxRetries: 6,
          maxDelayMs: 10_000_000,
          maxElapsedMs: 60 * 60_000,
        }),
        providerId: 'anthropic',
        modelId: 'm',
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
    for (const delay of clock.delays) {
      expect(delay).toBeLessThanOrEqual(RETRY_LIMITS.absoluteMaxDelayMs);
    }
    expect(attempt).toBe(7);
  });

  it('corrects an out-of-range policy rather than throwing', () => {
    const corrected = normalizePolicy({
      maxRetries: -3,
      initialDelayMs: -5,
      maxDelayMs: 0,
      multiplier: 0.1,
      jitter: true,
      respectRetryAfter: true,
      maxElapsedMs: -1,
      onPartialStream: true,
    });
    expect(corrected.maxRetries).toBe(0);
    expect(corrected.initialDelayMs).toBe(RETRY_LIMITS.minDelayMs);
    expect(corrected.maxDelayMs).toBe(RETRY_LIMITS.minDelayMs);
    expect(corrected.multiplier).toBe(1);
    expect(corrected.maxElapsedMs).toBe(RETRY_LIMITS.minDelayMs);
  });

  it('falls back to the default for a NON-FINITE value, which is not the same as clamping', () => {
    // `NaN` / `Infinity` mean "this number is unusable", and clamping them would
    // silently pick an arbitrary endpoint of the range instead of the documented
    // product default.
    const corrected = normalizePolicy({
      ...DEFAULT_RETRY_POLICY,
      maxRetries: Number.NaN,
      maxElapsedMs: Number.NEGATIVE_INFINITY,
    });
    expect(corrected.maxRetries).toBe(DEFAULT_RETRY_POLICY.maxRetries);
    expect(corrected.maxElapsedMs).toBe(DEFAULT_RETRY_POLICY.maxElapsedMs);
  });

  it('keeps an explicit maxRetries of 0 as 0 (never coerced to the default)', () => {
    expect(normalizePolicy(policy({ maxRetries: 0 })).maxRetries).toBe(0);
  });
});
