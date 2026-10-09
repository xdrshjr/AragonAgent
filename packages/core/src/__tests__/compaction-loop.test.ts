/**
 * The compaction checkpoint inside the agent loop (context-auto-compaction
 * §8.1, loop half).
 *
 * Five of the assertions here cover invariants that FAIL QUIETLY — the feature
 * keeps working, reports success, and is wrong — which is why the review made
 * them a shipping condition rather than prose: P0-1 (`overflowRecovered` cleared
 * after a completed stream, never at the top of the loop), P1-1 (`lastUsage`
 * actually assigned), P1-2 (a shallow copy across the port), and P1-3's two
 * halves (a non-settling `compact()` and an abort during one).
 *
 * REAL TIMERS with small windows, for the reason `retry-watchdog.test.ts`
 * records: the properties under test are about two independent mechanisms not
 * racing each other, and fake timers would let the test pick the interleaving.
 */

import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../engine/agent.js';
import type { ProviderRegistry } from '../llm/providers/index.js';
import type { AgentEvent } from '../types.js';
import type { AssistantMessage, Message, StreamEvent, TokenUsage } from '../llm/types.js';
import type {
  CompactionContext,
  CompactionOutcome,
  CompactionProbe,
  ContextManager,
} from '../engine/context-manager.js';

const usage: TokenUsage = { inputTokens: 10, outputTokens: 2 };

function doneEvent(text = 'ok'): StreamEvent {
  const message: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage,
    stopReason: 'end_turn',
  };
  return { type: 'done', message, usage };
}

/** A `ProviderRegistry`-shaped stub; `Agent` only ever calls `stream()`. */
function registryOf(
  make: (signal: AbortSignal | undefined) => AsyncIterableIterator<StreamEvent>,
): ProviderRegistry {
  return {
    stream: (_providerId: string, request: { signal?: AbortSignal }) => make(request.signal),
  } as unknown as ProviderRegistry;
}

interface AgentOpts {
  contextManager?: ContextManager;
  idleTimeout?: number;
  /** AC-10a's injected ceiling, so the assertion does not wait two minutes. */
  compactionHardTimeout?: number;
}

function agentWith(registry: ProviderRegistry, opts: AgentOpts = {}): Agent {
  return new Agent({
    systemPrompt: 'test',
    model: { providerId: 'anthropic', modelId: 'test-model' },
    tools: [],
    providerRegistry: registry,
    getApiKey: () => 'k',
    ...(opts.contextManager ? { contextManager: opts.contextManager } : {}),
    timeouts: {
      idleTimeout: opts.idleTimeout ?? 60_000,
      ...(opts.compactionHardTimeout !== undefined
        ? { compactionHardTimeout: opts.compactionHardTimeout }
        : {}),
    },
  });
}

function collect(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((e) => events.push(e));
  return events;
}

function overflowError(): Error {
  const err = new Error('context length exceeded') as Error & { errorType: string };
  err.errorType = 'context_overflow';
  return err;
}

describe('steering receipts across suspended compaction', () => {
  it('accepts A before compaction while B remains pending at the first turn_start', async () => {
    let release!: (outcome: CompactionOutcome) => void;
    let started!: () => void;
    const suspended = new Promise<CompactionOutcome>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const manager: ContextManager = {
      shouldCompact: (probe) => probe.turnIndex === 1,
      compact: () => { started(); return suspended; },
    };
    const agent = agentWith(registryOf(() => (async function* () {
      yield doneEvent();
    })()), { contextManager: manager });
    const events = collect(agent);
    const turnReceipts: string[][] = [];
    agent.subscribe((event) => {
      if (event.type === 'turn_start') {
        turnReceipts.push(events.flatMap((e) => e.type === 'steering_accepted' ? e.ids : []));
      }
    });
    agent.steer('A', 'id-a');
    const running = agent.prompt('initial');
    await entered;
    agent.steer('B', 'id-b');
    expect(events.filter((e) => e.type === 'steering_accepted'))
      .toEqual([{ type: 'steering_accepted', ids: ['id-a'] }]);
    expect(agent.state.messages.some((m) => m.role === 'user' && m.content === 'B')).toBe(false);
    release({ action: 'keep', reason: 'test' });
    await running;
    expect(turnReceipts).toEqual([['id-a'], ['id-a', 'id-b']]);
    expect(events.filter((e) => e.type === 'steering_accepted')).toEqual([
      { type: 'steering_accepted', ids: ['id-a'] },
      { type: 'steering_accepted', ids: ['id-b'] },
    ]);
  });
});

describe('the checkpoint is free when there is no manager (AC-1)', () => {
  it('emits no compaction events at all', async () => {
    const registry = registryOf(() =>
      (async function* () {
        yield doneEvent();
      })(),
    );
    const agent = agentWith(registry);
    const events = collect(agent);
    await agent.prompt('hi');
    expect(events.map((e) => e.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_update',
      'turn_end',
      'agent_end',
    ]);
  });
});

describe('shouldCompact === false costs nothing', () => {
  it('produces the same event sequence as a run with no manager', async () => {
    const registry = registryOf(() =>
      (async function* () {
        yield doneEvent();
      })(),
    );
    const compact = vi.fn();
    const manager: ContextManager = { shouldCompact: () => false, compact: compact as never };
    const agent = agentWith(registry, { contextManager: manager });
    const events = collect(agent);
    await agent.prompt('hi');
    expect(compact).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_update',
      'turn_end',
      'agent_end',
    ]);
  });
});

describe('the structural gate (D-4 / R-2)', () => {
  it('refuses a history with an orphan tool_result and continues on the original', async () => {
    const registry = registryOf(() =>
      (async function* () {
        yield doneEvent();
      })(),
    );
    const manager: ContextManager = {
      shouldCompact: () => true,
      compact: async () => ({
        action: 'replace',
        mode: 'summarized',
        messages: [{ role: 'tool_result', toolCallId: 'nope', content: 'x' }],
      }),
    };
    const agent = agentWith(registry, { contextManager: manager });
    const events = collect(agent);
    await agent.prompt('hi');

    const end = events.find((e) => e.type === 'compaction_end');
    expect(end).toBeDefined();
    expect(end).toMatchObject({ applied: false, mode: 'none' });
    expect((end as { reason?: string }).reason).toMatch(/^invalid_history: orphan_tool_result/);
    // The original history is intact.
    expect(agent.state.messages[0]).toMatchObject({ role: 'user', content: 'hi' });
  });

  it('refuses a history that grew', async () => {
    const registry = registryOf(() =>
      (async function* () {
        yield doneEvent();
      })(),
    );
    const manager: ContextManager = {
      shouldCompact: () => true,
      compact: async (ctx) => ({
        action: 'replace',
        mode: 'summarized',
        messages: [...ctx.messages, { role: 'user', content: 'extra' }] as Message[],
      }),
    };
    const agent = agentWith(registry, { contextManager: manager });
    const events = collect(agent);
    await agent.prompt('hi');
    const end = events.find((e) => e.type === 'compaction_end') as { reason?: string };
    expect(end.reason).toBe('invalid_history: grew');
  });

  it('adopts a valid replacement and reports both sides in one unit', async () => {
    const registry = registryOf(() =>
      (async function* () {
        yield doneEvent();
      })(),
    );
    const manager: ContextManager = {
      shouldCompact: (p) => p.turnIndex === 1,
      compact: async () => ({
        action: 'replace',
        mode: 'summarized',
        summary: '## Task\ndo the thing',
        messages: [{ role: 'user', content: 'compacted' }],
      }),
    };
    const agent = agentWith(registry, { contextManager: manager });
    const events = collect(agent);
    agent.replaceMessages([
      { role: 'user', content: 'a'.repeat(4000) },
      { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(4000) }] },
    ]);
    await agent.continue();

    const end = events.find((e) => e.type === 'compaction_end') as {
      applied: boolean;
      mode: string;
      summary?: string;
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
      messagesBefore: number;
      messagesAfter: number;
      droppedMessages: number;
    };
    expect(end.applied).toBe(true);
    expect(end.mode).toBe('summarized');
    expect(end.summary).toBe('## Task\ndo the thing');
    expect(end.messagesBefore).toBe(2);
    expect(end.messagesAfter).toBe(1);
    expect(end.droppedMessages).toBe(1);
    // Both figures come from core's own estimator, so they are comparable.
    expect(end.estimatedTokensBefore).toBeGreaterThan(end.estimatedTokensAfter);
  });
});

describe('a manager that misbehaves degrades to "compaction did not happen"', () => {
  it('a throwing compact() lets the run continue', async () => {
    const registry = registryOf(() =>
      (async function* () {
        yield doneEvent();
      })(),
    );
    const manager: ContextManager = {
      shouldCompact: () => true,
      compact: async () => {
        throw new Error('boom');
      },
    };
    const agent = agentWith(registry, { contextManager: manager });
    const events = collect(agent);
    await agent.prompt('hi');
    const end = events.find((e) => e.type === 'compaction_end') as { applied: boolean; reason?: string };
    expect(end.applied).toBe(false);
    expect(end.reason).toMatch(/^manager_threw: boom/);
    expect(events.some((e) => e.type === 'turn_end')).toBe(true);
  });

  it('a throwing shouldCompact() lets the run continue and is still reported', async () => {
    const registry = registryOf(() =>
      (async function* () {
        yield doneEvent();
      })(),
    );
    const manager: ContextManager = {
      shouldCompact: () => {
        throw new Error('predicate boom');
      },
      compact: async () => ({ action: 'keep', reason: 'never' }),
    };
    const agent = agentWith(registry, { contextManager: manager });
    const events = collect(agent);
    await agent.prompt('hi');
    const end = events.find((e) => e.type === 'compaction_end') as { applied: boolean; reason?: string };
    expect(end.reason).toMatch(/^manager_threw: predicate boom/);
    expect(events.some((e) => e.type === 'turn_end')).toBe(true);
  });
});

describe('P1-2 — the port receives a COPY, not the engine\'s live array', () => {
  it('a manager that splices ctx.messages in place changes nothing', async () => {
    const registry = registryOf(() =>
      (async function* () {
        yield doneEvent();
      })(),
    );
    const manager: ContextManager = {
      shouldCompact: (p) => p.turnIndex === 1,
      compact: async (ctx: CompactionContext) => {
        // The abuse the copy exists to absorb. Against `getAll() as Message[]`
        // this corrupts engine state directly, before the gate can look at it.
        (ctx.messages as Message[]).splice(1);
        return { action: 'keep', reason: 'no' } as CompactionOutcome;
      },
    };
    const agent = agentWith(registry, { contextManager: manager });
    agent.replaceMessages([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
      { role: 'user', content: 'three' },
    ]);
    await agent.continue();
    // Three in, three still there (plus the turn's assistant message).
    expect(agent.state.messages.slice(0, 3).map((m) => (m as { content: string }).content)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });
});

describe('P1-1 — lastUsage is assigned, not merely declared', () => {
  it('is undefined on turn 1 and carries the previous turn_end usage on turn 2', async () => {
    let turn = 0;
    const registry = registryOf(() =>
      (async function* () {
        turn += 1;
        if (turn === 1) {
          // A tool call, so the loop iterates a second time.
          const message: AssistantMessage = {
            role: 'assistant',
            content: [{ type: 'tool_call', toolCallId: 't1', toolName: 'noop', args: {} }],
            usage,
          };
          yield { type: 'done', message, usage } as StreamEvent;
          return;
        }
        yield doneEvent();
      })(),
    );

    const probes: CompactionProbe[] = [];
    const manager: ContextManager = {
      shouldCompact: (p) => {
        probes.push(p);
        return false;
      },
      compact: async () => ({ action: 'keep', reason: 'never' }),
    };
    const agent = agentWith(registry, { contextManager: manager });
    // A registered tool so the call resolves rather than erroring out the run.
    agent.setTools([
      {
        name: 'noop',
        label: 'noop',
        description: 'noop',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'done' }] }),
      },
    ]);
    await agent.prompt('hi');

    expect(probes.length).toBeGreaterThanOrEqual(2);
    expect(probes[0]!.lastUsage).toBeUndefined();
    expect(probes[0]!.turnIndex).toBe(1);
    expect(probes[1]!.lastUsage).toEqual(usage);
    expect(probes[1]!.turnIndex).toBe(2);
  });
});

describe('the reactive path (§3.5)', () => {
  it('clears pre-compaction usage before an overflow checkpoint', async () => {
    let turn = 0;
    const probes: CompactionProbe[] = [];
    const registry = registryOf(() => (async function* () {
      turn += 1;
      if (turn === 1) {
        const message: AssistantMessage = {
          role: 'assistant', usage,
          content: [{ type: 'tool_call', toolCallId: 'u', toolName: 'noop', args: {} }],
        };
        yield { type: 'done', message, usage } as StreamEvent;
      } else { throw overflowError(); }
    })());
    const manager: ContextManager = {
      shouldCompact: (probe) => {
        probes.push(probe);
        return probe.turnIndex === 2 && probe.trigger === 'pressure';
      },
      compact: async () => ({ action: 'replace', mode: 'summarized',
        messages: [{ role: 'user', content: 'memory' }] }),
    };
    const agent = agentWith(registry, { contextManager: manager });
    await agent.prompt('task').catch(() => {});
    expect(probes.find((probe) => probe.trigger === 'overflow')).toBeDefined();
    expect(probes.find((probe) => probe.trigger === 'overflow')?.lastUsage).toBeUndefined();
  });
  it('recovers: one compaction, two requests, run completes (AC-11)', async () => {
    let attempts = 0;
    const registry = registryOf(() =>
      (async function* () {
        attempts += 1;
        if (attempts === 1) throw overflowError();
        yield doneEvent();
      })(),
    );
    const compactions: string[] = [];
    const manager: ContextManager = {
      shouldCompact: (p) => p.trigger === 'overflow',
      compact: async (ctx) => {
        compactions.push(ctx.trigger);
        return {
          action: 'replace',
          mode: 'summarized',
          messages: [{ role: 'user', content: 'compacted' }],
        };
      },
    };
    const agent = agentWith(registry, { contextManager: manager });
    const events = collect(agent);
    await agent.prompt('hi');

    expect(attempts).toBe(2);
    expect(compactions).toEqual(['overflow']);
    expect(events.some((e) => e.type === 'turn_end')).toBe(true);
  });

  it('P0-1 — a provider that overflows on EVERY attempt compacts exactly once', async () => {
    // The regression that distinguishes a live `overflowRecovered` from a dead
    // one. A top-of-loop reset passes the two-attempt case above and fails here.
    let attempts = 0;
    const registry = registryOf(() =>
      (async function* () {
        attempts += 1;
        throw overflowError();
        // eslint-disable-next-line no-unreachable
        yield doneEvent();
      })(),
    );
    let compactCalls = 0;
    const manager: ContextManager = {
      shouldCompact: (p) => p.trigger === 'overflow',
      compact: async () => {
        compactCalls += 1;
        return {
          action: 'replace',
          mode: 'summarized',
          messages: [{ role: 'user', content: `compacted ${compactCalls}` }],
        };
      },
    };
    const agent = agentWith(registry, { contextManager: manager });
    await agent.prompt('hi');

    expect(compactCalls).toBe(1);
    expect(attempts).toBe(2);
  });

  it('rethrows when the compaction did not apply', async () => {
    let attempts = 0;
    const registry = registryOf(() =>
      (async function* () {
        attempts += 1;
        throw overflowError();
        // eslint-disable-next-line no-unreachable
        yield doneEvent();
      })(),
    );
    const manager: ContextManager = {
      shouldCompact: () => true,
      compact: async () => ({ action: 'keep', reason: 'nothing_to_drop' }),
    };
    const agent = agentWith(registry, { contextManager: manager });
    await agent.prompt('hi');
    expect(attempts).toBe(1);
  });

  it('leaves a non-overflow error alone', async () => {
    let attempts = 0;
    const registry = registryOf(() =>
      (async function* () {
        attempts += 1;
        const err = new Error('rate limited') as Error & { errorType: string };
        err.errorType = 'rate_limit';
        throw err;
        // eslint-disable-next-line no-unreachable
        yield doneEvent();
      })(),
    );
    const triggers: string[] = [];
    const manager: ContextManager = {
      shouldCompact: () => true,
      compact: async (ctx) => {
        triggers.push(ctx.trigger);
        return { action: 'keep', reason: 'not_needed' };
      },
    };
    const agent = agentWith(registry, { contextManager: manager });
    await agent.prompt('hi');
    expect(attempts).toBe(1);
    // The PRESSURE checkpoint ran; the overflow path was never entered, because
    // a `rate_limit` is not a `context_overflow`.
    expect(triggers).toEqual(['pressure']);
  });
});

describe('IF-2 — a malformed outcome degrades, it does not kill the run', () => {
  it('a compact() that resolves with undefined is reported and survived', async () => {
    // THE TYPE IS NOT THE GUARANTEE. `ContextManager` is implemented in another
    // package, so at this boundary the value is untyped at runtime: a stub, a
    // mock, or a host that forgot a `return` all arrive as `undefined`. Reading
    // `.action` off that used to throw past the inner catch and end the run —
    // the exact failure §3.3 step 4 forbids.
    const registry = registryOf(() =>
      (async function* () {
        yield doneEvent();
      })(),
    );
    const compact = vi.fn();
    const manager: ContextManager = { shouldCompact: () => true, compact: compact as never };
    const agent = agentWith(registry, { contextManager: manager });
    const events = collect(agent);
    await agent.prompt('hi');

    expect(compact).toHaveBeenCalledTimes(1);
    const end = events.find((e) => e.type === 'compaction_end') as { applied: boolean; reason?: string };
    expect(end.applied).toBe(false);
    expect(end.reason).toBe('manager_bad_outcome');
    expect(events.some((e) => e.type === 'turn_end')).toBe(true);
  });

  it('a replace with a non-array messages field is refused the same way', async () => {
    const registry = registryOf(() =>
      (async function* () {
        yield doneEvent();
      })(),
    );
    const manager: ContextManager = {
      shouldCompact: () => true,
      compact: async () => ({ action: 'replace', mode: 'summarized' }) as never,
    };
    const agent = agentWith(registry, { contextManager: manager });
    const events = collect(agent);
    await agent.prompt('hi');
    const end = events.find((e) => e.type === 'compaction_end') as { reason?: string };
    expect(end.reason).toBe('manager_bad_outcome');
    expect(events.some((e) => e.type === 'turn_end')).toBe(true);
  });
});

describe('the watchdog across a compaction (C-4 / AC-10)', () => {
  it('a slow compaction does not trip a short idle timeout', async () => {
    const registry = registryOf(() =>
      (async function* () {
        yield doneEvent();
      })(),
    );
    const manager: ContextManager = {
      shouldCompact: (p) => p.turnIndex === 1,
      compact: async () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ action: 'keep', reason: 'slow but fine' }),
            220,
          ),
        ),
    };
    const agent = agentWith(registry, { contextManager: manager, idleTimeout: 60 });
    const events = collect(agent);
    await agent.prompt('hi');
    // The run reached a turn rather than being aborted for being "idle" while it
    // was provably working.
    expect(events.some((e) => e.type === 'turn_end')).toBe(true);
  });

  it('P1-3 — a compact() that never settles ends within the ceiling, watchdog resumed', async () => {
    const registry = registryOf(() =>
      (async function* () {
        yield doneEvent();
      })(),
    );
    const manager: ContextManager = {
      shouldCompact: (p) => p.turnIndex === 1,
      // Never settles, and ignores the signal entirely.
      compact: () => new Promise<CompactionOutcome>(() => {}),
    };
    // The ceiling is injected small so the test does not wait two minutes; the
    // production value is `COMPACTION_HARD_TIMEOUT_MS`.
    const agent = agentWith(registry, {
      contextManager: manager,
      idleTimeout: 60_000,
      compactionHardTimeout: 120,
    });
    const events = collect(agent);
    const before = Date.now();
    await agent.prompt('hi');
    const elapsed = Date.now() - before;

    const end = events.find((e) => e.type === 'compaction_end') as { applied: boolean; reason?: string };
    expect(end.applied).toBe(false);
    expect(end.reason).toBe('manager_timeout');
    // `compaction_end` is what resumes the watchdog, and it was emitted exactly
    // once — the `finally` is the assertion, because an `end` that never arrives
    // leaves the run permanently deaf.
    expect(events.filter((e) => e.type === 'compaction_end')).toHaveLength(1);
    expect(elapsed).toBeLessThan(5000);
    // And the run went on to complete rather than hanging.
    expect(events.some((e) => e.type === 'turn_end')).toBe(true);
  });

  it('P1-3 / AC-14a — an abort during a non-settling compact() ends the run with no request', async () => {
    let requests = 0;
    const registry = registryOf(() =>
      (async function* () {
        requests += 1;
        yield doneEvent();
      })(),
    );
    const manager: ContextManager = {
      shouldCompact: (p) => p.turnIndex === 1,
      // Ignores the signal ENTIRELY. AC-14 is only true if the ENGINE races it.
      compact: () => new Promise<CompactionOutcome>(() => {}),
    };
    const agent = agentWith(registry, { contextManager: manager, idleTimeout: 60_000 });
    const events = collect(agent);
    const run = agent.prompt('hi');
    setTimeout(() => agent.abort(), 30);
    await run;

    const end = events.find((e) => e.type === 'compaction_end') as { reason?: string };
    expect(end.reason).toBe('aborted');
    expect(requests).toBe(0);
  });
});
