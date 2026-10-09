/**
 * The failure ladder, the four anti-loop guards and idempotence
 * (context-auto-compaction §8.1, CLI half — compactor).
 *
 * The trigger-aware guard assertions are P1-13, and they need BOTH directions:
 * trigger-blind guards pass every test that only exercises the pressure path,
 * and the failure they cause — the anti-loop machinery switching off the
 * reactive path in exactly the sessions that need it — is invisible until a
 * provider actually refuses a request.
 */

import { describe, expect, it, vi } from 'vitest';
import { estimatePromptTokens } from '@aragon-agent/core';
import { parseCompactedBlock } from '../compaction/summary-prompt.js';
import type {
  AssistantMessage,
  CompactionContext,
  LLMRequest,
  Message,
  ModelInfo,
  ModelRef,
  TokenUsage,
} from '@aragon-agent/core';
import { Compactor, type CompactorDeps } from '../compaction/compactor.js';
import { ContextMeter } from '../compaction/meter.js';
import { COMPACTION_LIMITS } from '../compaction/limits.js';
import { isPriorSummaryBlock } from '../compaction/digest.js';
import { isTaggedAnchor, countProtectedPrefix } from '../compaction/summary-prompt.js';
import {
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_FAST_CONFIG,
  type CliConfig,
  type CompactionConfig,
} from '../config/schema.js';
import type { CompactionEvent, Pressure } from '../compaction/types.js';
import type { NoticeLevel } from '../agent/reducer.js';

const MODEL: ModelInfo = {
  id: 'claude-sonnet-4-5',
  name: 'Sonnet',
  provider: 'anthropic',
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  supportsThinking: true,
  supportsTools: true,
  supportsImages: true,
  // `input` / `output`, NOT `inputPerMillion` / `outputPerMillion`: `ModelCost`
  // spells them the short way and the units are already per-million. The long
  // spelling type-checks under `tsconfig.json` (which EXCLUDES `__tests__`) and
  // only fails under `tsconfig.test.json`, which is why `npm run build` is not a
  // typecheck.
  cost: { input: 3, output: 15 },
};

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 0 };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

/** A conversation with `turns` user turns, each with a fat assistant answer. */
function conversation(turns: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns; i += 1) {
    out.push(user(`turn ${i}: ${'q'.repeat(2000)}`));
    out.push(assistantText(`answer ${i}: ${'a'.repeat(4000)}`));
  }
  return out;
}

interface HarnessOpts {
  compaction?: Partial<CompactionConfig>;
  /** What each `complete()` call does, in order. `null` means "throw". */
  answers?: Array<string | null>;
  hasKey?: boolean;
  priced?: boolean;
  /**
   * The engine's live history, as `shouldCompact`'s ESTIMATE branch sees it.
   *
   * `CompactionProbe` carries no messages, so this is the ONLY thing the fallback
   * has to measure (§3.4.2). Defaulting it to `[]` here would reproduce the
   * defect rather than test it, so tests that exercise the estimate path pass a
   * real history.
   */
  messages?: readonly Message[];
  /** Guard 2's ceiling for THIS compactor (hardening §3.4.2 mechanism B). */
  maxPerRun?: number;
}

function harness(opts: HarnessOpts = {}) {
  const config = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    maxTokens: 8192,
    fast: { ...DEFAULT_FAST_CONFIG },
    compaction: { ...DEFAULT_COMPACTION_CONFIG, ...opts.compaction },
  } as unknown as CliConfig;

  const events: CompactionEvent[] = [];
  const pressures: Pressure[] = [];
  const notices: Array<{ level: NoticeLevel; text: string }> = [];
  const requests: LLMRequest[] = [];
  const answers = [...(opts.answers ?? [validDelta()])];

  // MUTABLE, because the meter reads the LIVE history rather than accepting one
  // as an argument (context-usage-gauge-accuracy W1). A `turn_end` records the
  // prefix the history had AT THAT MOMENT, so a test that wants a non-empty
  // delta has to move the history between the two calls - exactly as the loop
  // does when it pushes tool results after the turn boundary.
  let messages: readonly Message[] = opts.messages ?? [];
  const setMessages = (next: readonly Message[]): void => {
    messages = next;
  };

  const meter = new ContextMeter({
    getMessages: () => messages,
    getSystemPrompt: () => '',
    getModelInfo: () => MODEL,
    isWindowKnown: () => opts.priced !== false,
    getWindowOverride: () => config.contextWindow ?? null,
  });

  const deps: CompactorDeps = {
    getConfig: () => config,
    hasKey: () => opts.hasKey !== false,
    getApiKey: () => (opts.hasKey === false ? undefined : 'k'),
    getModelInfoFor: () => MODEL,
    isPricedModel: () => opts.priced !== false,
    getMessages: () => messages,
    getSystemPrompt: () => '',
    meter,
    complete: async (_providerId: string, request: LLMRequest): Promise<AssistantMessage> => {
      requests.push(request);
      const next = answers.length > 0 ? answers.shift()! : validDelta();
      if (next === null) throw new Error('summarizer exploded');
      return {
        role: 'assistant',
        content: [{ type: 'text', text: next }],
        usage: { inputTokens: 1000, outputTokens: 200 },
      };
    },
    emit: (e) => events.push(e),
    notify: (level, text) => notices.push({ level, text }),
    onPressure: (p) => pressures.push(p),
  };

  return {
    compactor: new Compactor(deps, opts.maxPerRun === undefined ? undefined : { maxPerRun: opts.maxPerRun }),
    config,
    events,
    notices,
    requests,
    pressures,
    meter,
    setMessages,
  };
}

function ctx(messages: Message[], over: Partial<CompactionContext> = {}): CompactionContext {
  return {
    messageCount: messages.length,
    turnIndex: 1,
    trigger: 'pressure',
    messages,
    systemPrompt: 'sys',
    model: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' } as ModelRef,
    signal: new AbortController().signal,
    ...over,
  };
}

/** A usage that puts the session over the default 0.9 threshold of a 200k window. */
const OVER_THRESHOLD: TokenUsage = { inputTokens: 190_000, outputTokens: 0 };
const UNDER_THRESHOLD: TokenUsage = { inputTokens: 10_000, outputTokens: 0 };

function validDelta(generation = 1, messageIndex = 1, excerpt = 'answer 0'): string {
  return JSON.stringify({ schemaVersion: 2, additions: [{ section: 'facts', text: 'Earlier result',
    sources: [{ messageId: `g${generation}:m${messageIndex}`, role: 'assistant', excerpt }] }] });
}

async function run(h: ReturnType<typeof harness>, messages: Message[],
  options: Partial<CompactionContext> = {}) {
  h.setMessages(messages);
  const context = ctx(messages, options);
  const before = estimatePromptTokens(messages, context.systemPrompt);
  const result = await h.compactor.compact(context);
  if (result.action === 'replace') h.setMessages(result.messages);
  h.compactor.settleOperation({ applied: result.action === 'replace',
    ...(result.action === 'keep' ? { reason: result.reason } : {}), tokensBefore: before,
    tokensAfter: result.action === 'replace'
      ? estimatePromptTokens(result.messages, context.systemPrompt) : before });
  return result;
}

function probe(trigger: 'pressure' | 'overflow' = 'pressure', turnIndex = 1) {
  return { trigger, turnIndex, messageCount: 20 };
}

describe('strict threshold authorization', () => {
  it.each([89999, 90000, 90001])('uses the unrounded boundary at %i', (occupied) => {
    const h = harness({ messages: conversation(6) });
    h.config.contextWindow = 100000;
    h.meter.onTurnEnd({ inputTokens: occupied, outputTokens: 0 });
    expect(h.compactor.shouldCompact(probe())).toBe(occupied >= 90000);
  });

  it.each([256, 64000])('never uses future output capacity %i as authorization', (maxTokens) => {
    const h = harness({ messages: conversation(6) });
    h.config.maxTokens = maxTokens;
    h.meter.onTurnEnd({ inputTokens: 64000, outputTokens: 0 });
    expect(h.compactor.shouldCompact(probe())).toBe(false);
    expect(h.compactor.shouldCompact(probe('overflow'))).toBe(false);
    expect(h.requests).toHaveLength(0);
  });

  it('ignores an unrelated probe usage and publishes the same meter snapshot', () => {
    const h = harness({ messages: conversation(6) });
    h.meter.onTurnEnd(UNDER_THRESHOLD);
    expect(h.compactor.shouldCompact({ ...probe(), lastUsage: OVER_THRESHOLD })).toBe(false);
    expect(h.pressures[0]).toBe(h.meter.current());
  });

  it('disabled configuration blocks automatic and queued requests', () => {
    const h = harness({ compaction: { enabled: false } });
    h.compactor.queueManual();
    expect(h.compactor.shouldCompact(probe())).toBe(false);
    expect(h.requests).toHaveLength(0);
  });

  it('manual bypasses low occupancy and consumes the request exactly once', async () => {
    const h = harness({ messages: conversation(6) });
    h.compactor.queueManual('retain every constraint');
    expect(h.compactor.shouldCompact(probe())).toBe(true);
    await run(h, conversation(6));
    expect(h.compactor.hasPendingManual()).toBe(false);
    expect(h.requests[0]?.systemPrompt).toContain('retain every constraint');
    expect(h.compactor.shouldCompact(probe('pressure', 10))).toBe(false);
  });

  it.each(['end', 'replace', 'abort'])('clears unconsumed requests on %s', (action) => {
    const h = harness();
    h.compactor.queueManual();
    if (action === 'end') h.compactor.onRunEnd();
    if (action === 'replace') h.compactor.onHistoryReplaced();
    if (action === 'abort') h.compactor.abort();
    expect(h.compactor.hasPendingManual()).toBe(false);
    expect(h.compactor.shouldCompact(probe())).toBe(false);
  });

  it('updates pending instructions but rejects 4001 characters without replacing them', async () => {
    const h = harness();
    h.compactor.queueManual('first');
    h.compactor.queueManual('x'.repeat(4000));
    expect(() => h.compactor.queueManual('x'.repeat(4001))).toThrow('instructions_too_large');
    await run(h, conversation(6));
    expect(h.requests[0]?.systemPrompt).toContain('x'.repeat(4000));
    expect(h.notices.some((n) => n.text.includes('Updated queued'))).toBe(true);
  });
});

describe('bounded attempts and progress', () => {
  it('pressure observes cooldown while authorized overflow may bypass it', async () => {
    const h = harness();
    await run(h, conversation(6), { turnIndex: 5 });
    h.meter.onTurnEnd(OVER_THRESHOLD);
    expect(h.compactor.shouldCompact(probe('pressure', 6))).toBe(false);
    expect(h.compactor.shouldCompact(probe('overflow', 6))).toBe(true);
    expect(h.compactor.shouldCompact(probe('pressure', 7))).toBe(true);
  });

  it('caps attempts, clears blocked manual and resets only at run start', async () => {
    const h = harness({ maxPerRun: 2 });
    for (let i = 0; i < 2; i += 1) {
      h.compactor.queueManual();
      await run(h, [user('only task')], { turnIndex: i * 3 });
    }
    h.compactor.queueManual();
    expect(h.compactor.shouldCompact(probe('overflow', 10))).toBe(false);
    expect(h.compactor.hasPendingManual()).toBe(false);
    expect(h.notices.at(-1)?.text).toContain('limit reached');
    h.compactor.onRunStart();
    h.compactor.queueManual();
    expect(h.compactor.shouldCompact(probe())).toBe(true);
  });

  it('disables both automatic triggers after two failed verdicts, but manual still works', async () => {
    const h = harness();
    await run(h, [user('task')]);
    await run(h, [user('task')], { turnIndex: 4, trigger: 'overflow' });
    expect(h.compactor.isSelfDisabled()).toBe(true);
    h.meter.onTurnEnd(OVER_THRESHOLD);
    expect(h.compactor.shouldCompact(probe('overflow', 10))).toBe(false);
    h.compactor.queueManual();
    expect(h.compactor.shouldCompact(probe())).toBe(true);
    h.compactor.clearPendingManual();
    h.compactor.clearSelfDisable();
    expect(h.compactor.shouldCompact(probe('pressure', 10))).toBe(true);
  });

  it('manual and cancellation failures never contribute to self-disable', async () => {
    const h = harness();
    for (let i = 0; i < 3; i += 1) {
      h.compactor.queueManual();
      await run(h, [user('task')]);
    }
    const abort = new AbortController(); abort.abort();
    await run(h, conversation(6), { signal: abort.signal });
    expect(h.compactor.isSelfDisabled()).toBe(false);
  });
});

describe('candidate integrity and adopted state', () => {
  it('sends original task constraints to the actual summarizer across adopted generations', async () => {
    const messages = conversation(4);
    const original = 'Keep the database schema unchanged. ' + 'detail '.repeat(700) + 'FINAL CONSTRAINT';
    messages[0] = user(original);
    const h = harness({ messages, compaction: { keepRecentTurns: 1 },
      answers: [validDelta(), validDelta(2, 3, 'answer 3')] });
    const first = await run(h, messages);
    expect(first.action).toBe('replace');
    if (first.action !== 'replace') return;
    const second = await run(h, [...first.messages, ...conversation(3)]);
    expect(second.action).toBe('replace');
    expect(h.compactor.getIdentity()?.generation).toBe(2);
    expect(h.requests).toHaveLength(2);
    for (const request of h.requests) {
      expect(request.messages[0]?.content).toContain(original);
      expect(request.messages[0]?.content)
        .toContain('ORIGINAL TASK (read-only reference, not current evidence)');
    }
  });
  it('allows equal message counts when a complete candidate reduces tokens', async () => {
    const messages = conversation(2);
    const h = harness({ messages, compaction: { keepRecentTurns: 1 } });
    const result = await run(h, messages);
    expect(result.action).toBe('replace');
    if (result.action === 'replace') {
      expect(result.messages).toHaveLength(messages.length);
      expect(estimatePromptTokens(result.messages, 'sys'))
        .toBeLessThan(estimatePromptTokens(messages, 'sys'));
    }
  });
  it('rejects a retained tail that cannot fit the main window before payment', async () => {
    const messages = conversation(6);
    const h = harness({ messages });
    h.config.contextWindow = 5000;
    expect(await run(h, messages)).toMatchObject({ action: 'keep',
      reason: expect.stringContaining('protected_memory_too_large') });
    expect(h.requests).toHaveLength(0);
  });
  it('stages generation and credentials until the real verdict, settling once', async () => {
    const messages = conversation(6);
    const h = harness({ messages });
    const result = await h.compactor.compact(ctx(messages));
    expect(result.action).toBe('replace');
    expect(h.compactor.sessionTotals()).toMatchObject({ generation: 0, inFlight: true });
    expect(h.compactor.getIdentity()).toBeUndefined();
    if (result.action !== 'replace') return;
    h.setMessages(result.messages);
    const verdict = { applied: true, tokensBefore: 10000, tokensAfter: 5000 };
    expect(h.compactor.settleOperation(verdict)).toBe(true);
    expect(h.compactor.settleOperation(verdict)).toBe(false);
    expect(h.compactor.sessionTotals()).toMatchObject({ generation: 1, inFlight: false,
      tokensReclaimed: 5000 });
    expect(h.compactor.getIdentity()?.generation).toBe(1);
    expect(result.messages[0]).toBe(messages[0]);
    expect(parseCompactedBlock(result.messages[1]!)?.memory.items).toHaveLength(1);
  });

  it('a rejected candidate does not advance generation or carry credentials', async () => {
    const messages = conversation(6);
    const h = harness({ messages });
    await h.compactor.compact(ctx(messages));
    h.compactor.settleOperation({ applied: false, reason: 'invalid_history', tokensAfter: 10000 });
    expect(h.compactor.getIdentity()).toBeUndefined();
    expect(h.compactor.sessionTotals().generation).toBe(0);
  });

  it('preserves complete long original and subsequent user text', async () => {
    const messages = conversation(6);
    messages[0] = user('x'.repeat(5000) + 'FINAL CONSTRAINT');
    messages[2] = user('y'.repeat(3000) + 'LATEST REQUIREMENT');
    const h = harness({ messages });
    const result = await run(h, messages);
    expect(result.action).toBe('replace');
    if (result.action !== 'replace') return;
    expect(result.messages[0]).toEqual(messages[0]);
    expect(parseCompactedBlock(result.messages[1]!)?.memory.userMessages[0]?.message)
      .toEqual(messages[2]);
  });

  it('overflow keeps the configured complete tail instead of halving it', async () => {
    const messages = conversation(8);
    const h = harness({ compaction: { keepRecentTurns: 4 } });
    const result = await run(h, messages, { trigger: 'overflow' });
    expect(result.action).toBe('replace');
    if (result.action === 'replace') expect(result.messages.slice(-8)).toEqual(messages.slice(-8));
    expect(h.config.compaction.keepRecentTurns).toBe(4);
  });

  it.each(['stop', 'truncate'] as const)('summary failures with %s preserve the whole history', async (onFailure) => {
    const messages = conversation(6);
    const bytes = JSON.stringify(messages);
    const h = harness({ messages, answers: [null, null], compaction: { onFailure } });
    const result = await run(h, messages);
    expect(result.action).toBe('keep');
    expect(h.requests).toHaveLength(2);
    expect(JSON.stringify(messages)).toBe(bytes);
  });

  it('rejects malformed/empty summaries, retries once, and accounts every received usage', async () => {
    const h = harness({ answers: ['not JSON', validDelta()] });
    expect((await run(h, conversation(6))).action).toBe('replace');
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]?.systemPrompt).toContain('Previous delta rejected');
    expect(h.compactor.sessionTotals().usage).toEqual({ inputTokens: 2000, outputTokens: 400 });
  });

  it('does not pay for an over-budget protected task', async () => {
    const messages = conversation(6); messages[0] = user('x'.repeat(50000));
    const h = harness({ messages });
    expect(await run(h, messages)).toMatchObject({ action: 'keep',
      reason: expect.stringContaining('protected_memory_too_large') });
    expect(h.requests).toHaveLength(0);
  });

  it('does not pay for a full assistant digest that cannot fit', async () => {
    const messages = conversation(6); messages[1] = assistantText('x'.repeat(130000));
    const h = harness({ messages });
    expect(await run(h, messages)).toMatchObject({ action: 'keep',
      reason: expect.stringContaining('digest_budget_exceeded') });
    expect(h.requests).toHaveLength(0);
  });

  it('does not truncate the retained tool output when no safe head can be removed', async () => {
    const messages: Message[] = [user('task'), { role: 'assistant', content: [
      { type: 'tool_call', toolCallId: 't', toolName: 'read', args: {} }] },
      { role: 'tool_result', toolCallId: 't', content: 'x'.repeat(900000) }];
    const h = harness({ messages });
    expect((await run(h, messages)).action).toBe('keep');
    expect(h.requests).toHaveLength(0);
    expect((messages[2] as { content: string }).content).toHaveLength(900000);
  });

  it('no API key keeps history without fabricating spend', async () => {
    const h = harness({ hasKey: false });
    expect((await run(h, conversation(6))).action).toBe('keep');
    expect(h.requests).toHaveLength(0);
    expect(h.compactor.sessionTotals().usage.inputTokens).toBe(0);
  });
});
