/**
 * The idle watchdog across a retry backoff (llm-api-retry-backoff §4.6, AC-15 /
 * AC-16).
 *
 * REAL TIMERS, ON PURPOSE. The property under test is that two independent
 * mechanisms — `withRetry`'s wait and `IdleWatchdog`'s window — do not race each
 * other, and fake timers would let the test decide the interleaving that the bug
 * is about. The windows are kept small (100 ms idle, ~350 ms backoff) so the file
 * still runs in well under a second.
 *
 * `IdleWatchdog.pause` / `resume` in isolation are covered by
 * `watchdog-pause.test.ts`; what is new here is that `Agent.emit` applies them.
 */

import { describe, expect, it } from 'vitest';
import { Agent } from '../engine/agent.js';
import type { ProviderRegistry } from '../llm/providers/index.js';
import type { AgentEvent } from '../types.js';
import type { AssistantMessage, StreamEvent, TokenUsage } from '../llm/types.js';

const usage: TokenUsage = { inputTokens: 1, outputTokens: 1 };

function doneEvent(): StreamEvent {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    usage,
    stopReason: 'end_turn',
  };
  return { type: 'done', message, usage };
}

/** Sleep that resolves early when `signal` fires, so an abort ends a run promptly. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** A `ProviderRegistry`-shaped stub; `Agent` only ever calls `stream()`. */
function registryOf(
  make: (signal: AbortSignal | undefined) => AsyncIterableIterator<StreamEvent>,
): ProviderRegistry {
  return {
    stream: (_providerId: string, request: { signal?: AbortSignal }) => make(request.signal),
  } as unknown as ProviderRegistry;
}

function agentWith(registry: ProviderRegistry, idleTimeout: number): Agent {
  return new Agent({
    systemPrompt: 'test',
    model: { providerId: 'anthropic', modelId: 'test-model' },
    tools: [],
    providerRegistry: registry,
    getApiKey: () => 'k',
    timeouts: { idleTimeout },
  });
}

describe('Agent pauses the idle watchdog across a backoff (AC-15)', () => {
  it('does not abort a run whose only "inactivity" is a scheduled retry', async () => {
    const backoffMs = 350;
    const idleTimeout = 100; // deliberately far shorter than the backoff

    const registry = registryOf((signal) =>
      (async function* () {
        yield {
          type: 'retry_scheduled',
          attempt: 1,
          maxRetries: 10,
          delayMs: backoffMs,
          resumeAt: Date.now() + backoffMs,
          errorType: 'overloaded',
          message: 'anthropic API error 529',
        } as StreamEvent;
        // The wait. Nothing is emitted here, which is exactly what the watchdog
        // would otherwise read as a wedged call.
        await sleep(backoffMs, signal);
        if (signal?.aborted) return;
        yield { type: 'retry_attempt', attempt: 1, maxRetries: 10 } as StreamEvent;
        yield doneEvent();
      })(),
    );

    const agent = agentWith(registry, idleTimeout);
    const seen: AgentEvent['type'][] = [];
    agent.subscribe((event) => seen.push(event.type));

    await agent.prompt('hello');

    // `turn_end` is only reached when the stream produced a `done` — the loop
    // `break`s before it on abort, so its presence IS "the run survived".
    expect(seen).toContain('turn_end');
    expect(seen[seen.length - 1]).toBe('agent_end');
  });

  it('still aborts a genuinely wedged run (the pause must not be permanent)', async () => {
    const registry = registryOf((signal) =>
      (async function* () {
        // No events at all: an ordinary hung provider call.
        await sleep(2_000, signal);
      })(),
    );

    const agent = agentWith(registry, 60);
    const seen: AgentEvent['type'][] = [];
    agent.subscribe((event) => seen.push(event.type));

    await agent.prompt('hello');

    expect(seen).not.toContain('turn_end');
    expect(seen[seen.length - 1]).toBe('agent_end');
  });
});

describe('a run aborted mid-backoff leaves the watchdog usable (AC-16)', () => {
  it('arms normally on the NEXT run of the SAME agent after a retry_scheduled with no retry_attempt', async () => {
    // ONE AGENT, TWO RUNS. The watchdog is per-instance, so a second `Agent`
    // would prove nothing — reusing this one is the whole test.
    let run = 0;
    const registry = registryOf((signal) => {
      run += 1;
      // Run 1: pause the watchdog, then get aborted during the wait, so
      // `retry_attempt` never arrives and nothing ever calls `resume()`.
      if (run === 1) {
        return (async function* () {
          yield {
            type: 'retry_scheduled',
            attempt: 1,
            maxRetries: 10,
            delayMs: 5_000,
            resumeAt: Date.now() + 5_000,
            errorType: 'overloaded',
            message: 'anthropic API error 529',
          } as StreamEvent;
          await sleep(5_000, signal);
        })();
      }
      // Run 2: an ordinary wedged call with no retry events at all. If `paused`
      // had survived run 1, the watchdog would be deaf and this would sit for the
      // full 2 s; `IdleWatchdog.stop()` clearing `paused` is what fires it.
      return (async function* () {
        await sleep(2_000, signal);
      })();
    });

    const agent = agentWith(registry, 60);
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'message_update' && event.streamEvent.type === 'retry_scheduled') {
        agent.abort(); // Esc, effectively
      }
    });
    await agent.prompt('first');
    unsubscribe();

    const seen: AgentEvent['type'][] = [];
    agent.subscribe((event) => seen.push(event.type));
    const startedAt = Date.now();
    await agent.prompt('second');
    const elapsed = Date.now() - startedAt;

    expect(run).toBe(2);
    expect(seen).not.toContain('turn_end');
    // The watchdog fired rather than the 2 s sleep completing on its own.
    expect(elapsed).toBeLessThan(1_500);
  });
});
