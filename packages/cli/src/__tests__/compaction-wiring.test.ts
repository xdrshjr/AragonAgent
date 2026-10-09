/**
 * `CompactionWiring` — the settle path and the idle `/compact` path
 * (context-auto-compaction §3.2.1 / §4.4 / §5.2).
 *
 * BOTH SUITES HERE COVER FAILURES THAT ARE INVISIBLE TO THE COMPACTOR'S OWN
 * TESTS, because they are about the seam between two event streams rather than
 * about any one decision: the compactor emits an optimistic record, the ENGINE
 * decides `applied`, and the wiring is the only thing that sees both. Every bug
 * this file pins lives in the ordering between them.
 *
 * NO NETWORK, AND NOT BY MOCKING ONE. `hasKey` answers `false`, so
 * `resolveSummarizer()` returns `null` and the failure ladder ends at
 * `no_summarizer_model` WITHOUT ever reaching `getRegistry()`. The result is a
 * `truncated` splice, which is a complete compaction cycle for the purposes of
 * everything below.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message, ModelInfo, ModelRef, ProviderRegistry,
  AssistantMessage } from '@aragon-agent/core';
import { CompactionWiring } from '../compaction/wiring.js';
import type { CompactionEvent } from '../compaction/types.js';
import {
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_FAST_CONFIG,
  type CliConfig,
} from '../config/schema.js';

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

const REF: ModelRef = { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' };

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 0 };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function conversation(turns: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns; i += 1) {
    out.push(user(`turn ${i}: ${'q'.repeat(2000)}`));
    out.push(assistantText(`answer ${i}: ${'a'.repeat(4000)}`));
  }
  return out;
}

function harness(messages: Message[], complete?: () => Promise<AssistantMessage>) {
  const config = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    maxTokens: 8192,
    fast: { ...DEFAULT_FAST_CONFIG },
    compaction: { ...DEFAULT_COMPACTION_CONFIG, archive: false },
  } as unknown as CliConfig;

  const events: CompactionEvent[] = [];
  const wiring = new CompactionWiring({
    getConfig: () => config,
    hasKey: () => true,
    getApiKey: () => 'k',
    createRegistry: () => ({ complete: complete ?? (async () => ({ role: 'assistant', content: [
      { type: 'text', text: JSON.stringify({ schemaVersion: 2, additions: [
        { section: 'facts', text: 'Recorded answer', sources: [
          { messageId: 'g1:m1', role: 'assistant', excerpt: 'answer 0' }],
        }], }) }], usage: { inputTokens: 10, outputTokens: 10 },
    })) }) as unknown as ProviderRegistry,
    getModelInfoFor: () => MODEL,
    isPricedModel: () => true,
    getMessages: () => messages,
    getSystemPrompt: () => 'sys',
    notify: () => {},
  });
  wiring.subscribe((e) => events.push(e));

  /** The agent-stream injector `attach` hands out, so a core verdict can be timed. */
  let agent: ((event: AgentEvent) => void) | null = null;
  wiring.attach((listener) => {
    agent = listener;
    return (): void => {
      agent = null;
    };
  });

  const ends = (): Array<Extract<CompactionEvent, { type: 'compaction_end' }>> =>
    events.filter((e): e is Extract<CompactionEvent, { type: 'compaction_end' }> => {
      return e.type === 'compaction_end';
    });

  return { wiring, events, ends, emitAgent: (e: AgentEvent): void => agent?.(e), config };
}

describe('the idle /compact path (§4.4 / D-25)', () => {
  /**
   * THE HEADLINE NUMBERS ARE REAL ON THE IDLE PATH TOO.
   *
   * There is no `compaction_end` from the engine here — there is no loop — so
   * nothing supplies `tokensBefore` / `tokensAfter` unless this path computes
   * them itself. Settling with a hardcoded `tokensAfter: 0` renders a card
   * claiming the compaction freed the ENTIRE window ("118.4k -> 0 tokens") and
   * adds the whole occupancy to `tokensReclaimed`, which `/compact status` then
   * reports for the rest of the session. Both numbers are wrong, both are
   * plausible, and nothing raises.
   */
  it('reports both token figures from core\'s own estimator, never a zeroed "after"', async () => {
    const messages = conversation(10);
    const { wiring, ends } = harness(messages);

    const outcome = await wiring.compactNow({
      messages,
      systemPrompt: 'sys',
      model: REF,
      signal: new AbortController().signal,
      isCurrent: () => true,
      adopt: (next) => { messages.splice(0, messages.length, ...next); },
    });
    expect(outcome.ok).toBe(true);

    const settled = ends().at(-1)!.record;
    expect(settled.applied).toBe(true);
    expect(settled.tokensBefore).toBeGreaterThan(0);
    // The number that was 0 before the fix. It must be a real estimate of the
    // spliced history — smaller than the original, and not nothing.
    expect(settled.tokensAfter).toBeGreaterThan(0);
    expect(settled.tokensAfter).toBeLessThan(settled.tokensBefore);

    // And the session total is the difference of those two, not the whole of
    // `tokensBefore`.
    expect(wiring.snapshot().tokensReclaimed).toBe(settled.tokensBefore - settled.tokensAfter);
  });

  it('a refused splice reports "after" equal to "before", because nothing changed', async () => {
    // One turn, so `planCompaction` has nothing to drop and the outcome is
    // `keep`. The card must not imply the history shrank.
    const messages = conversation(1);
    const { wiring, ends } = harness(messages);

    const outcome = await wiring.compactNow({
      messages,
      systemPrompt: 'sys',
      model: REF,
      signal: new AbortController().signal,
      isCurrent: () => true,
      adopt: (next) => { messages.splice(0, messages.length, ...next); },
    });
    expect(outcome.ok).toBe(false);

    expect(ends()).toHaveLength(0); // Declined before any paid call.
    expect(outcome).toMatchObject({ ok: false, reason: 'nothing_to_drop' });
    expect(wiring.snapshot().tokensReclaimed).toBe(0);
  });
});

describe('the settle race between the two streams (C-8)', () => {
  /**
   * THE ENGINE'S VERDICT CAN LAND BEFORE THE COMPACTOR'S RECORD, AND ESC IS THE
   * ORDINARY WAY IT HAPPENS.
   *
   * `runCompaction` races `compact()` against the run's signal, so an abort
   * resolves the race and emits `compaction_end` while `compact()` is still
   * unwinding its own call. If the wiring only ever settles a record it already
   * holds, that verdict is dropped on the floor and the transcript card stays
   * `live: true` FOREVER — which is C-8's failure mode exactly: `Transcript`'s
   * settled boundary is monotonic, so the entire tail re-renders on every frame
   * for the rest of the session, and the card goes on claiming a compaction is
   * running. `manager_timeout` reaches the same place.
   *
   * The compactor's own record arrives afterwards and must NOT open a second
   * card for a compaction the user has already been told about.
   */
  it('a verdict that arrives first still settles the card, and the late record is dropped', async () => {
    const messages = conversation(10);
    const { wiring, ends, emitAgent } = harness(messages);

    // `compact()` emits its CLI `compaction_start` synchronously, before its
    // first await (this fixture reaches commit point B) — so the card is open by
    // the time this call returns a promise.
    const inFlight = wiring.manager().compact({
      messageCount: messages.length,
      turnIndex: 3,
      trigger: 'pressure',
      messages,
      systemPrompt: 'sys',
      model: REF,
      signal: new AbortController().signal,
    });
    expect(ends()).toHaveLength(0);

    // Esc: the engine stops waiting and reports, while `compact()` is still open.
    emitAgent({
      type: 'compaction_end',
      applied: false,
      mode: 'none',
      reason: 'aborted',
      messagesBefore: messages.length,
      messagesAfter: messages.length,
      droppedMessages: 0,
      estimatedTokensBefore: 1234,
      estimatedTokensAfter: 1234,
      durationMs: 7,
    });

    const settled = ends();
    expect(settled).toHaveLength(1);
    expect(settled[0]!.record.applied).toBe(false);
    expect(settled[0]!.record.reason).toBe('aborted');

    // The compactor's own record lands late. The card is already closed, so it
    // must not produce a second one.
    await inFlight;
    expect(ends()).toHaveLength(1);
  });

  it('the ordinary ordering is unchanged: record first, then the verdict settles it', async () => {
    const messages = conversation(10);
    const { wiring, ends, emitAgent } = harness(messages);

    await wiring.manager().compact({
      messageCount: messages.length,
      turnIndex: 3,
      trigger: 'pressure',
      messages,
      systemPrompt: 'sys',
      model: REF,
      signal: new AbortController().signal,
    });
    // HELD, not forwarded: `applied` is the engine's to decide.
    expect(ends()).toHaveLength(0);

    emitAgent({
      type: 'compaction_end',
      applied: true,
      mode: 'truncated',
      messagesBefore: messages.length,
      messagesAfter: 4,
      droppedMessages: messages.length - 4,
      estimatedTokensBefore: 30_000,
      estimatedTokensAfter: 2_000,
      durationMs: 12,
    });

    const settled = ends();
    expect(settled).toHaveLength(1);
    expect(settled[0]!.record.applied).toBe(true);
    expect(settled[0]!.record.tokensBefore).toBe(30_000);
    expect(settled[0]!.record.tokensAfter).toBe(2_000);
    expect(wiring.snapshot().tokensReclaimed).toBe(28_000);
  });
});

describe('AC-Q13: a declined checkpoint settles without a card (quiet-noop §3.6)', () => {
  /**
   * THE RECEIVING END OF THE QUIET NO-OP.
   *
   * Core emits its `compaction_end` for EVERY attempt, declines included — that
   * pair is the idle-watchdog contract and is emitted from a `finally`. So
   * `settlePending` still runs on a decline; what it must NOT do is synthesize a
   * card out of a compaction that never announced one. `skeletonRecord()` returns
   * `null` because `this.open` was never set, and the early return is what keeps
   * the transcript silent.
   *
   * IT STILL EMITS A `snapshot`, so the gauge, the chip and `/compact status`
   * (which is where the `declined` count lives) are refreshed by the same settle
   * every other verdict refreshes them by. Without it this is the one settle path
   * a future reader has to remember is an exception.
   */
  it('emits no compaction_end on the CLI stream, but exactly one snapshot', async () => {
    // ONE user turn: `planCompaction` finds no cut and the tail is far too small
    // for relief, so the compaction declines before committing to any work.
    const messages = conversation(1);
    const { wiring, ends, events, emitAgent } = harness(messages);

    await wiring.manager().compact({
      messageCount: messages.length,
      turnIndex: 3,
      trigger: 'pressure',
      messages,
      systemPrompt: 'sys',
      model: REF,
      signal: new AbortController().signal,
    });
    // Nothing at all yet: no card was opened, so none is pending.
    expect(events).toHaveLength(0);

    emitAgent({
      type: 'compaction_end',
      applied: false,
      mode: 'none',
      reason: 'nothing_to_drop',
      messagesBefore: messages.length,
      messagesAfter: messages.length,
      droppedMessages: 0,
      estimatedTokensBefore: 1234,
      estimatedTokensAfter: 1234,
      durationMs: 3,
    });

    expect(ends()).toHaveLength(0);
    expect(events.filter((e) => e.type === 'snapshot')).toHaveLength(1);
    // And the count that survives the silence reached the snapshot.
    expect(wiring.snapshot().declined).toBe(1);
  });
});


describe('adoption ownership and local cancellation', () => {
  it.each(['stale', 'throw'])('never publishes success when adoption is %s', async (mode) => {
    const messages = conversation(6);
    const before = JSON.stringify(messages);
    const h = harness(messages);
    const adopt = vi.fn(() => { throw new Error('replacement rejected'); });
    const result = await h.wiring.compactNow({ messages, model: REF, systemPrompt: 'sys',
      signal: new AbortController().signal, isCurrent: () => mode !== 'stale', adopt });
    expect(result.ok).toBe(false);
    expect(h.ends().at(-1)?.record.applied).toBe(false);
    expect(h.wiring.getIdentity()).toBeUndefined();
    expect(h.wiring.snapshot().generation).toBe(0);
    expect(JSON.stringify(messages)).toBe(before);
    expect(adopt).toHaveBeenCalledTimes(mode === 'stale' ? 0 : 1);
    h.wiring.dispose();
  });

  it('releases an ignored abort, then isolates late usage from the next operation', async () => {
    let release!: (value: AssistantMessage) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const remote = new Promise<AssistantMessage>((resolve) => { release = resolve; });
    const messages = conversation(6);
    const complete = vi.fn(() => { entered(); return remote; });
    const h = harness(messages, complete);
    const parent = new AbortController();
    const adopt = vi.fn();
    const first = h.wiring.compactNow({ messages, model: REF, systemPrompt: 'sys',
      signal: parent.signal, isCurrent: () => true, adopt });
    await started;
    parent.abort();
    expect((await first).ok).toBe(false);
    expect(h.wiring.snapshot().inFlight).toBe(false);
    const secondAbort = new AbortController();
    const second = h.wiring.compactNow({ messages, model: REF, systemPrompt: 'sys',
      signal: secondAbort.signal, isCurrent: () => true, adopt });
    expect(h.wiring.snapshot().inFlight).toBe(true);
    secondAbort.abort();
    await second;
    release({ role: 'assistant', content: [{ type: 'text', text: '{}' }],
      usage: { inputTokens: 30, outputTokens: 4 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adopt).not.toHaveBeenCalled();
    expect(h.wiring.snapshot().generation).toBe(0);
    expect(h.events.filter((event) => event.type === 'usage')).toHaveLength(1);
    expect(h.wiring.snapshot().usage).toEqual({ inputTokens: 30, outputTokens: 4 });
    expect(h.ends().every((event) => !event.record.applied)).toBe(true);
    h.wiring.dispose();
  });
});
