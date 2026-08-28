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
  const answers = [...(opts.answers ?? ['## Task\nthe summary'])];

  const deps: CompactorDeps = {
    getConfig: () => config,
    hasKey: () => opts.hasKey !== false,
    getApiKey: () => (opts.hasKey === false ? undefined : 'k'),
    getModelInfoFor: () => MODEL,
    isPricedModel: () => opts.priced !== false,
    getMessages: () => opts.messages ?? [],
    getSystemPrompt: () => '',
    complete: async (_providerId: string, request: LLMRequest): Promise<AssistantMessage> => {
      requests.push(request);
      const next = answers.length > 0 ? answers.shift()! : '## Task\nthe summary';
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

/**
 * A history whose ESTIMATE alone clears the 0.9 threshold of a 200 k window.
 *
 * `estimatePromptTokens` is ~4 chars/token, so 20 messages of 48 000 characters
 * is ~240 k tokens — comfortably over both terms of the trigger.
 */
function hugeHistory(): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < 20; i += 1) out.push(user(`m${i}: ${'x'.repeat(48_000)}`));
  return out;
}

describe('the trigger (§3.4)', () => {
  /**
   * §3.4.2 — THE RESUMED-SESSION CASE, and the regression guard for a defect
   * that is silent in every other test.
   *
   * `lastUsage` is `undefined` before the first `turn_end` of a run, which is
   * exactly what `/resume` on a 180 k-token conversation looks like — the moment
   * the design calls the most dangerous in this feature's life. The estimate
   * branch is the only one available there, and `CompactionProbe` carries no
   * messages, so the compactor has to read the history from its deps. Measuring
   * an empty array instead answers 0 % and the trigger never fires: the run then
   * sends the very request that is most likely to overflow, and nothing anywhere
   * reports a fault. `computePressure`'s own unit tests pass either way, because
   * they are handed a history directly.
   */
  it('fires on the ESTIMATE when there is no usage yet, reading the live history', () => {
    const { compactor } = harness({ messages: hugeHistory() });
    expect(
      compactor.shouldCompact({ messageCount: 20, turnIndex: 1, trigger: 'pressure' }),
    ).toBe(true);
  });

  it('and reads 0 % for a genuinely empty history, not for every history', () => {
    const { compactor } = harness();
    expect(
      compactor.shouldCompact({ messageCount: 0, turnIndex: 1, trigger: 'pressure' }),
    ).toBe(false);
  });

  it('does not fire below the threshold', () => {
    const { compactor } = harness();
    expect(
      compactor.shouldCompact({
        messageCount: 10,
        turnIndex: 5,
        trigger: 'pressure',
        lastUsage: UNDER_THRESHOLD,
      }),
    ).toBe(false);
  });

  it('fires above it', () => {
    const { compactor } = harness();
    expect(
      compactor.shouldCompact({
        messageCount: 10,
        turnIndex: 5,
        trigger: 'pressure',
        lastUsage: OVER_THRESHOLD,
      }),
    ).toBe(true);
  });

  it('never fires when the config says off', () => {
    const { compactor } = harness({ compaction: { enabled: false } });
    expect(
      compactor.shouldCompact({
        messageCount: 10,
        turnIndex: 5,
        trigger: 'pressure',
        lastUsage: OVER_THRESHOLD,
      }),
    ).toBe(false);
  });
});

describe('guard 1 — cooldown (§3.8)', () => {
  it('refuses two PRESSURE compactions on consecutive turns', async () => {
    const { compactor } = harness();
    const probe = (turnIndex: number) => ({
      messageCount: 20,
      turnIndex,
      trigger: 'pressure' as const,
      lastUsage: OVER_THRESHOLD,
    });
    expect(compactor.shouldCompact(probe(5))).toBe(true);
    await compactor.compact(ctx(conversation(10), { turnIndex: 5 }));

    expect(compactor.shouldCompact(probe(6))).toBe(false);
    expect(compactor.shouldCompact(probe(7))).toBe(true);
  });

  it('is BYPASSED for overflow — the cooldown cannot block the only path that helps', async () => {
    const { compactor } = harness();
    await compactor.compact(ctx(conversation(10), { turnIndex: 5 }));
    expect(
      compactor.shouldCompact({
        messageCount: 20,
        turnIndex: 6,
        trigger: 'overflow',
        lastUsage: OVER_THRESHOLD,
      }),
    ).toBe(true);
  });
});

describe('guard 2 — the per-run cap (§3.8)', () => {
  it('stops after maxPerRun and resets on agent_start', async () => {
    const { compactor } = harness();
    const probe = (turnIndex: number) => ({
      messageCount: 40,
      turnIndex,
      trigger: 'pressure' as const,
      lastUsage: OVER_THRESHOLD,
    });
    for (let i = 0; i < COMPACTION_LIMITS.maxPerRun; i += 1) {
      const turn = 10 + i * COMPACTION_LIMITS.minTurnsBetween;
      expect(compactor.shouldCompact(probe(turn))).toBe(true);
      await compactor.compact(ctx(conversation(20), { turnIndex: turn }));
    }
    expect(compactor.shouldCompact(probe(500))).toBe(false);
    // HARD ON BOTH TRIGGERS.
    expect(
      compactor.shouldCompact({
        messageCount: 40,
        turnIndex: 501,
        trigger: 'overflow',
        lastUsage: OVER_THRESHOLD,
      }),
    ).toBe(false);

    compactor.onRunStart();
    expect(compactor.shouldCompact(probe(1))).toBe(true);
  });
});

describe('guards 3 and 4 are TRIGGER-AWARE (D-24 / P1-13)', () => {
  /**
   * A history whose tail alone is enormous, so no cut can reclaim enough. This
   * is the shape that drives the progress guard.
   */
  function unreclaimable(): Message[] {
    const out: Message[] = [];
    for (let i = 0; i < 8; i += 1) {
      out.push(user(`t${i}`));
      out.push(assistantText('z'.repeat(120_000)));
    }
    return out;
  }

  it('self-disables the PRESSURE trigger after stuckLimit, with a diagnostic notice', async () => {
    const { compactor, notices } = harness({ compaction: { keepRecentTurns: 8 } });
    for (let i = 0; i < COMPACTION_LIMITS.stuckLimit; i += 1) {
      await compactor.compact(ctx(unreclaimable(), { turnIndex: 10 + i * 5, trigger: 'pressure' }));
    }
    expect(compactor.isSelfDisabled()).toBe(true);

    // NO THIRD PRESSURE CALL.
    expect(
      compactor.shouldCompact({
        messageCount: 20,
        turnIndex: 500,
        trigger: 'pressure',
        lastUsage: OVER_THRESHOLD,
      }),
    ).toBe(false);

    // The notice NAMES THE CAUSE AND THE REMEDIES. A wording drift makes it
    // useless, which is why this is asserted rather than merely counted.
    const warn = notices.find((n) => n.level === 'warn' && n.text.includes('Auto-compaction is off'));
    expect(warn).toBeDefined();
    expect(warn!.text).toContain('keepRecentTurns');
    expect(warn!.text).toContain('/clear');
    expect(warn!.text).toContain('/reset');
  });

  it('AC-12a — after that self-disable a context_overflow STILL triggers a compaction', async () => {
    const { compactor } = harness({ compaction: { keepRecentTurns: 8 } });
    for (let i = 0; i < COMPACTION_LIMITS.stuckLimit; i += 1) {
      await compactor.compact(ctx(unreclaimable(), { turnIndex: 10 + i * 5, trigger: 'pressure' }));
    }
    expect(compactor.isSelfDisabled()).toBe(true);
    // THE REACTIVE PATH STAYS ARMED. The anti-loop guards must not be able to
    // switch off the answer to a request the provider has already refused.
    expect(
      compactor.shouldCompact({
        messageCount: 20,
        turnIndex: 500,
        trigger: 'overflow',
        lastUsage: OVER_THRESHOLD,
      }),
    ).toBe(true);
  });

  /**
   * GUARD 4 COUNTS THE *UI* TRIGGER, NOT THE LOOP'S.
   *
   * A queued `/compact` arrives at the boundary as an ordinary `pressure`
   * checkpoint — that is what the queue IS — so charging its result to the stuck
   * counter lets a user who types `/compact` twice on a conversation with
   * nothing worth dropping switch off the proactive trigger for the rest of the
   * session, and be told, wrongly, that their recent turns exceed the threshold.
   * This guard exists to stop UNREQUESTED spend; a user asking twice is not that.
   */
  it('a MANUAL compaction that reclaims nothing never self-disables the session', async () => {
    const { compactor, notices } = harness({ compaction: { keepRecentTurns: 8 } });
    for (let i = 0; i < COMPACTION_LIMITS.stuckLimit + 1; i += 1) {
      compactor.queueManual();
      await compactor.compact(ctx(unreclaimable(), { turnIndex: 10 + i * 5, trigger: 'pressure' }));
    }
    expect(compactor.isSelfDisabled()).toBe(false);
    expect(notices.some((n) => n.text.includes('Auto-compaction is off'))).toBe(false);
  });

  it('guard 3 never self-disables on OVERFLOW, however little it reclaims', async () => {
    const { compactor } = harness({ compaction: { keepRecentTurns: 8 } });
    for (let i = 0; i < COMPACTION_LIMITS.stuckLimit + 2; i += 1) {
      await compactor.compact(ctx(unreclaimable(), { turnIndex: 10 + i, trigger: 'overflow' }));
    }
    expect(compactor.isSelfDisabled()).toBe(false);
  });

  it('an overflow attempt HALVES keepRecentTurns for itself and does not persist it', async () => {
    const { compactor, config } = harness({ compaction: { keepRecentTurns: 8 } });
    const history = conversation(12);

    const overflow = await compactor.compact(ctx(history, { trigger: 'overflow', turnIndex: 3 }));
    expect(overflow.action).toBe('replace');

    // NOT PERSISTED, and not even mutated in memory: the halving is scoped to
    // the one attempt where the provider has proven the request impossible.
    expect(config.compaction.keepRecentTurns).toBe(8);

    // The overflow splice kept FEWER turns than a pressure one would have, which
    // is the only lever that can make a too-large tail fit.
    compactor.onRunStart();
    const pressure = await compactor.compact(ctx(history, { trigger: 'pressure', turnIndex: 3 }));
    expect(pressure.action).toBe('replace');
    if (overflow.action === 'replace' && pressure.action === 'replace') {
      expect(overflow.messages.length).toBeLessThan(pressure.messages.length);
    }
  });
});

describe('the failure ladder (§3.7)', () => {
  it('rung 1: a successful call splices mode summarized', async () => {
    const { compactor, requests } = harness({ answers: ['## Task\nbuild the parser'] });
    const outcome = await compactor.compact(ctx(conversation(10)));
    expect(outcome.action).toBe('replace');
    if (outcome.action === 'replace') {
      expect(outcome.mode).toBe('summarized');
      expect(outcome.summary).toContain('build the parser');
    }
    expect(requests).toHaveLength(1);
    // NO TOOLS, no thinking, temperature 0 — the `fast/review-call.ts` shape.
    expect(requests[0]!.tools).toBeUndefined();
    expect(requests[0]!.thinkingLevel).toBe('off');
    expect(requests[0]!.temperature).toBe(0);
    expect(requests[0]!.maxTokens).toBe(COMPACTION_LIMITS.summaryOutputTokens);
  });

  it('rung 2: one retry, then rung 3 truncation with a warn notice', async () => {
    const { compactor, requests, notices } = harness({ answers: [null, null] });
    const outcome = await compactor.compact(ctx(conversation(10)));
    expect(requests).toHaveLength(2);
    expect(outcome.action).toBe('replace');
    if (outcome.action === 'replace') {
      expect(outcome.mode).toBe('truncated');
      // The block itself says the record is incomplete (§6.4).
      const block = outcome.messages.find((m) => isPriorSummaryBlock(m))!;
      expect(block.content).toContain('THE RECORD IS INCOMPLETE');
    }
    // "It did nothing" is never the observable outcome (R-8).
    expect(notices.some((n) => n.level === 'warn' && n.text.includes('could not summarize'))).toBe(true);
  });

  it('rung 2: an EMPTY summary counts as a failure and is retried', async () => {
    const { compactor, requests } = harness({ answers: ['   ', '## Task\nrecovered'] });
    const outcome = await compactor.compact(ctx(conversation(10)));
    expect(requests).toHaveLength(2);
    if (outcome.action === 'replace') expect(outcome.mode).toBe('summarized');
  });

  it('rung 4: onFailure stop keeps the history and raises an ERROR notice', async () => {
    const { compactor, notices } = harness({
      answers: [null, null],
      compaction: { onFailure: 'stop' },
    });
    const outcome = await compactor.compact(ctx(conversation(10)));
    expect(outcome.action).toBe('keep');
    if (outcome.action === 'keep') expect(outcome.reason).toMatch(/^summarize_failed/);
    const err = notices.find((n) => n.level === 'error');
    expect(err).toBeDefined();
    // The error names all three exits, because the run is about to fail.
    expect(err!.text).toContain('/compact');
    expect(err!.text).toContain('/clear');
    expect(err!.text).toContain('/reset');
  });

  it('keeps the goal anchor through EVERY rung, including truncation', async () => {
    for (const answers of [['## Task\nfine'], [null, null]]) {
      const { compactor } = harness({ answers });
      const history = [user('THE ORIGINAL TASK'), ...conversation(10)];
      const outcome = await compactor.compact(ctx(history));
      expect(outcome.action).toBe('replace');
      if (outcome.action !== 'replace') continue;
      // AC-7, mechanically: the FIRST message is the anchor and it is tagged.
      expect(isTaggedAnchor(outcome.messages[0]!)).toBe(true);
      expect(outcome.messages[0]!.content).toContain('THE ORIGINAL TASK');
    }
  });

  it('refuses cleanly when no summarizer model resolves', async () => {
    const { compactor } = harness({ hasKey: false });
    const outcome = await compactor.compact(ctx(conversation(10)));
    expect(outcome.action).toBe('replace');
    // With no key the ladder cannot summarize, so it truncates rather than
    // leaving the run at the occupancy that triggered it.
    if (outcome.action === 'replace') expect(outcome.mode).toBe('truncated');
  });

  it('an aborted run keeps the history and says so', async () => {
    const controller = new AbortController();
    controller.abort();
    const { compactor, requests } = harness();
    const outcome = await compactor.compact(ctx(conversation(10), { signal: controller.signal }));
    expect(outcome.action).toBe('keep');
    if (outcome.action === 'keep') expect(outcome.reason).toBe('aborted');
    // AND NO FULL-PRICE REQUEST WAS SENT.
    expect(requests).toHaveLength(0);
  });
});

describe('AC-7a / P1-9 — compacting the same conversation TWICE', () => {
  it('leaves exactly one anchor and one block, still carrying the task', async () => {
    const { compactor } = harness({ answers: ['## Task\npass one', '## Task\npass two'] });
    const original = [user('THE ORIGINAL TASK'), ...conversation(12)];

    const first = await compactor.compact(ctx(original, { turnIndex: 2 }));
    expect(first.action).toBe('replace');
    if (first.action !== 'replace') return;

    // A second pass over the compacted history, plus new material.
    const grown = [...first.messages, ...conversation(8)];
    compactor.onRunStart();
    const second = await compactor.compact(ctx(grown, { turnIndex: 2 }));
    expect(second.action).toBe('replace');
    if (second.action !== 'replace') return;

    const anchors = second.messages.filter((m) => isTaggedAnchor(m));
    const blocks = second.messages.filter((m) => isPriorSummaryBlock(m));
    expect(anchors).toHaveLength(1);
    expect(blocks).toHaveLength(1);
    expect(anchors[0]!.content).toContain('THE ORIGINAL TASK');
    // `generation` counts compactions in this history.
    expect(blocks[0]!.content).toContain('generation="2"');
    // The second summary MERGED the first rather than re-condensing it — the
    // prompt said so, and the digest carried the block whole.
    expect(blocks[0]!.content).toContain('pass two');
  });

  it('a THIRD pass with nothing new returns null via protectedPrefix', async () => {
    const { compactor } = harness({ answers: ['## Task\npass one'] });
    const original = [user('THE ORIGINAL TASK'), ...conversation(12)];
    const first = await compactor.compact(ctx(original, { turnIndex: 2 }));
    if (first.action !== 'replace') throw new Error('setup failed');

    // Only the anchor, the block and one trailing turn: nothing worth dropping.
    const stagnant = first.messages.slice(0, 2).concat(first.messages.slice(-2));
    expect(countProtectedPrefix(stagnant)).toBe(2);

    compactor.onRunStart();
    const third = await compactor.compact(ctx(stagnant, { turnIndex: 2 }));
    expect(third.action).toBe('keep');
    if (third.action === 'keep') expect(third.reason).toBe('nothing_to_drop');
  });
});

describe('the manual queue (§4.4 / D-17)', () => {
  it('a queued /compact fires at the next boundary regardless of occupancy', () => {
    const { compactor } = harness();
    const probe = {
      messageCount: 4,
      turnIndex: 1,
      trigger: 'pressure' as const,
      lastUsage: UNDER_THRESHOLD,
    };
    expect(compactor.shouldCompact(probe)).toBe(false);
    compactor.queueManual();
    expect(compactor.hasPendingManual()).toBe(true);
    expect(compactor.shouldCompact(probe)).toBe(true);
  });

  it('is consumed by the compaction it triggered', async () => {
    const { compactor, events } = harness();
    compactor.queueManual('keep every SQL query');
    await compactor.compact(ctx(conversation(10)));
    expect(compactor.hasPendingManual()).toBe(false);
    const start = events.find((e) => e.type === 'compaction_start');
    expect(start).toMatchObject({ trigger: 'manual' });
  });

  it('forwards the instructions into the summarizer prompt', async () => {
    const { compactor, requests } = harness();
    compactor.queueManual('keep every SQL query verbatim');
    await compactor.compact(ctx(conversation(10)));
    expect(requests[0]!.systemPrompt).toContain('## Focus');
    expect(requests[0]!.systemPrompt).toContain('keep every SQL query verbatim');
  });

  it('is not suppressed by a self-disable', async () => {
    const { compactor } = harness({ compaction: { keepRecentTurns: 8 } });
    const big: Message[] = [];
    for (let i = 0; i < 8; i += 1) {
      big.push(user(`t${i}`), assistantText('z'.repeat(120_000)));
    }
    for (let i = 0; i < COMPACTION_LIMITS.stuckLimit; i += 1) {
      await compactor.compact(ctx(big, { turnIndex: 10 + i * 5 }));
    }
    expect(compactor.isSelfDisabled()).toBe(true);
    compactor.queueManual();
    // A user instruction outranks a guard that exists to stop UNREQUESTED spend.
    expect(
      compactor.shouldCompact({
        messageCount: 20,
        turnIndex: 500,
        trigger: 'pressure',
        lastUsage: UNDER_THRESHOLD,
      }),
    ).toBe(true);
  });
});

describe('the summarizer choice (§3.6.4 / P2-8)', () => {
  it('is the MAIN model out of the box, because fast.enabled defaults to false', () => {
    const { compactor } = harness();
    const choice = compactor.resolveSummarizer()!;
    expect(choice.fromFastTier).toBe(false);
    expect(choice.ref.modelId).toBe('claude-sonnet-4-5');
  });

  it('is the fast tier when one resolves and useFastTier is on', () => {
    const { compactor, config } = harness();
    (config.fast as { enabled: boolean; model: string }).enabled = true;
    (config.fast as { enabled: boolean; model: string }).model = 'claude-haiku-4-5';
    const choice = compactor.resolveSummarizer()!;
    expect(choice.fromFastTier).toBe(true);
    expect(choice.ref.modelId).toBe('claude-haiku-4-5');
  });

  it('ignores the fast tier when useFastTier is off', () => {
    const { compactor, config } = harness({ compaction: { useFastTier: false } });
    (config.fast as { enabled: boolean; model: string }).enabled = true;
    (config.fast as { enabled: boolean; model: string }).model = 'claude-haiku-4-5';
    expect(compactor.resolveSummarizer()!.fromFastTier).toBe(false);
  });

  it('retries on the MAIN model when the fast tier failed', async () => {
    const { compactor, config, requests } = harness({ answers: [null, '## Task\nrecovered'] });
    (config.fast as { enabled: boolean; model: string }).enabled = true;
    (config.fast as { enabled: boolean; model: string }).model = 'claude-haiku-4-5';
    await compactor.compact(ctx(conversation(10)));
    expect(requests).toHaveLength(2);
    expect(requests[0]!.model).toBe('claude-haiku-4-5');
    // "A fast model that cannot summarize" is the most likely single failure.
    expect(requests[1]!.model).toBe('claude-sonnet-4-5');
  });
});

describe('cost honesty (§6.4 / AC-15)', () => {
  it('carries pricingUnknown rather than reporting $0.00', async () => {
    const { compactor } = harness({ priced: false });
    await compactor.compact(ctx(conversation(10)));
    expect(compactor.sessionTotals().pricingUnknown).toBe(true);
  });

  it('accumulates the summarizer spend and emits it', async () => {
    const { compactor, events } = harness();
    await compactor.compact(ctx(conversation(10)));
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(compactor.sessionTotals().usage).toEqual({ inputTokens: 1000, outputTokens: 200 });
  });
});

describe('the port contract', () => {
  it('compact() never throws, even when the summarizer does', async () => {
    const { compactor } = harness({ answers: [null, null] });
    await expect(compactor.compact(ctx(conversation(10)))).resolves.toBeTruthy();
  });

  it('shouldCompact() is synchronous and allocates no promise', () => {
    const { compactor } = harness();
    const result = compactor.shouldCompact({
      messageCount: 4,
      turnIndex: 1,
      trigger: 'pressure',
      lastUsage: UNDER_THRESHOLD,
    });
    expect(typeof result).toBe('boolean');
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('emits exactly one start and one end per compaction', async () => {
    const { compactor, events } = harness();
    await compactor.compact(ctx(conversation(10)));
    expect(events.filter((e) => e.type === 'compaction_start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'compaction_end')).toHaveLength(1);
  });

  /**
   * A summarizer that hangs until its signal fires — which is what every real
   * adapter does, because `ProviderRegistry.stream()` forwards `request.signal`
   * into the fetch.
   *
   * THAT CONTRACT IS WHY `callTimeoutMs` BITES AT ALL. This module deliberately
   * does not own an `AbortController` (see `summarize-call.ts`'s header) and does
   * not race the provider's promise: it stamps `callAbortReason` and aborts, and
   * the provider's own rejection is what returns control. A provider that ignored
   * the signal entirely would not be bounded here — it is bounded one layer up,
   * by the ENGINE's `COMPACTION_HARD_TIMEOUT_MS`, which exists precisely because
   * "the host is correct" is the assumption `runCompaction` refuses to make
   * (§3.7's last row / P1-3).
   */
  function hangingComplete(): (id: string, request: LLMRequest) => Promise<AssistantMessage> {
    return (_id, request) =>
      new Promise<AssistantMessage>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
  }

  it('bounds each rung at callTimeoutMs and lands on truncation', async () => {
    vi.useFakeTimers();
    try {
      const config = {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        maxTokens: 8192,
        fast: { ...DEFAULT_FAST_CONFIG },
        compaction: { ...DEFAULT_COMPACTION_CONFIG },
      } as unknown as CliConfig;
      const notices: Array<{ level: NoticeLevel; text: string }> = [];
      const compactor = new Compactor({
        getConfig: () => config,
        hasKey: () => true,
        getApiKey: () => 'k',
        getModelInfoFor: () => MODEL,
        isPricedModel: () => true,
        getMessages: () => [],
        getSystemPrompt: () => '',
        complete: hangingComplete(),
        emit: () => {},
        notify: (level, text) => notices.push({ level, text }),
      });

      const promise = compactor.compact(ctx(conversation(10)));
      // Two rungs, each bounded by `callTimeoutMs`.
      await vi.advanceTimersByTimeAsync(COMPACTION_LIMITS.callTimeoutMs + 10);
      await vi.advanceTimersByTimeAsync(COMPACTION_LIMITS.callTimeoutMs + 10);
      const outcome = await promise;

      // The run is DEGRADED, not wedged: rung 3, announced.
      expect(outcome.action).toBe('replace');
      if (outcome.action === 'replace') expect(outcome.mode).toBe('truncated');
      expect(notices.some((n) => n.level === 'warn' && n.text.includes('could not summarize'))).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('the two-rung budget stays strictly under the engine ceiling', () => {
    // COUPLED CONSTANTS, and only this assertion says so. §3.7's worst legal host
    // case is two `callTimeoutMs` calls back to back plus the digest render;
    // raising `callTimeoutMs` past half the engine's `COMPACTION_HARD_TIMEOUT_MS`
    // makes the ladder unreachable and turns every slow-but-correct summarization
    // into `manager_timeout` — a failure that presents as "compaction stopped
    // working" with nothing pointing at the number that changed.
    const ENGINE_HARD_TIMEOUT_MS = 120_000;
    expect(COMPACTION_LIMITS.callTimeoutMs * 2).toBeLessThan(ENGINE_HARD_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// W1 — the recorded prefix, and reporting above the guards
// (context-auto-compaction-hardening §8.1, tests 13-15a)
// ---------------------------------------------------------------------------

/** A turn's worth of appended tool results: ~49 k tokens across two calls. */
function appendedToolResults(): Message[] {
  return [
    { role: 'tool_result', toolCallId: 'a', content: 'r'.repeat(98_000) },
    { role: 'tool_result', toolCallId: 'b', content: 'r'.repeat(98_000) },
  ];
}

describe('the recorded measurement prefix (hardening §3.2.3 / W1)', () => {
  it('onTurnEnd records the length; invalidateMeasurement clears it', () => {
    const measured: Message[] = [user('turn 12'), user('the assistant turn')];
    const history = [...measured, ...appendedToolResults()];
    const { compactor } = harness({ messages: history });

    // Nothing recorded yet: the delta is absent and the number is round 1's.
    compactor.measure({ lastUsage: { inputTokens: 152_000, outputTokens: 0 }, messages: history });
    expect(compactor.lastMeasured()?.deltaTokens).toBe(0);

    compactor.onTurnEnd({ inputTokens: 152_000, outputTokens: 0 }, measured.slice(0, 1), '');
    compactor.measure({ lastUsage: { inputTokens: 152_000, outputTokens: 0 }, messages: history });
    expect(compactor.lastMeasured()!.deltaTokens).toBeGreaterThan(40_000);

    compactor.invalidateMeasurement();
    compactor.measure({ lastUsage: { inputTokens: 152_000, outputTokens: 0 }, messages: history });
    expect(compactor.lastMeasured()!.deltaTokens).toBe(0);
  });

  /**
   * AC-H3 / test 14 — THE REGRESSION FOR §3.2.1, end to end through the trigger.
   *
   * This is the test that fails against `553827ca7`: without the delta the
   * compactor reads 76 %, declines, and the run sends a request of ~101 %.
   */
  it('a 76 %-measured history with 49 k of appended tool results TRIGGERS', () => {
    const measured: Message[] = [user('turn 12'), user('the assistant turn')];
    const history = [...measured, ...appendedToolResults()];
    const { compactor } = harness({ messages: history });
    const probe = {
      messageCount: history.length,
      turnIndex: 5,
      trigger: 'pressure' as const,
      lastUsage: { inputTokens: 152_000, outputTokens: 0 },
    };

    compactor.onTurnEnd(probe.lastUsage, measured.slice(0, 1), '');
    expect(compactor.shouldCompact(probe)).toBe(true);

    // And the same history with the prefix invalidated does NOT - which is
    // exactly the pre-fix behaviour, asserted so a revert is visible.
    compactor.invalidateMeasurement();
    expect(compactor.shouldCompact(probe)).toBe(false);
  });
});

describe('onPressure fires above the guards (hardening §3.2.4 / RV-4 / DH-15)', () => {
  const probe = (turnIndex: number) => ({
    messageCount: 4,
    turnIndex,
    trigger: 'pressure' as const,
    lastUsage: { inputTokens: 10_000, outputTokens: 0 },
  });

  it('fires once per enabled checkpoint, and not at all when compaction is off', () => {
    const { compactor, pressures } = harness();
    compactor.shouldCompact(probe(10));
    expect(pressures).toHaveLength(1);

    const off = harness({ compaction: { enabled: false } });
    off.compactor.shouldCompact(probe(10));
    expect(off.pressures).toHaveLength(0);
  });

  it('fires INSIDE the cooldown window, where the guard declines', async () => {
    // WRITTEN THE OTHER WAY ROUND THIS TEST PINS THE DEFECT AS THE CONTRACT.
    // Below the guards the measurement is skipped on five paths, and the gauge
    // would go dark on every one of them.
    const { compactor, pressures } = harness();
    await compactor.compact(ctx(conversation(6)));
    const before = pressures.length;
    // `minTurnsBetween` is 2 and the compaction ran at turnIndex 1.
    expect(compactor.shouldCompact(probe(1))).toBe(false);
    expect(pressures.length).toBe(before + 1);
  });

  it('fires after the per-run cap is spent, which never clears within a run', async () => {
    const { compactor, pressures } = harness({ maxPerRun: 1 });
    await compactor.compact(ctx(conversation(6)));
    const before = pressures.length;
    expect(compactor.shouldCompact(probe(50))).toBe(false);
    expect(pressures.length).toBe(before + 1);
  });

  it('fires after guard 4 self-disables, which is designed not to clear', async () => {
    // Two no-progress PRESSURE compactions self-disable the proactive trigger.
    const { compactor, pressures } = harness({ compaction: { keepRecentTurns: 1 } });
    const tiny = [user('only turn')];
    await compactor.compact(ctx(tiny, { turnIndex: 1 }));
    await compactor.compact(ctx(tiny, { turnIndex: 10 }));
    expect(compactor.isSelfDisabled()).toBe(true);

    const before = pressures.length;
    expect(compactor.shouldCompact(probe(50))).toBe(false);
    expect(pressures.length).toBe(before + 1);
  });
});

describe('maxPerRun is an instance bound (hardening §3.4.2 mechanism B / RV-2)', () => {
  /**
   * "THE OVERLAY WAS PASSED" AND "THE OVERLAY TOOK EFFECT" ARE DIFFERENT CLAIMS,
   * and only the second one bounds the cost that justifies reversing D-15.
   */
  it('a compactor built with maxPerRun: 2 refuses its THIRD compaction', async () => {
    const { compactor } = harness({ maxPerRun: 2 });
    const probe = {
      messageCount: 12,
      turnIndex: 100,
      trigger: 'pressure' as const,
      lastUsage: OVER_THRESHOLD,
    };

    await compactor.compact(ctx(conversation(6), { turnIndex: 1 }));
    await compactor.compact(ctx(conversation(6), { turnIndex: 50 }));
    expect(compactor.shouldCompact(probe)).toBe(false);
  });

  it('and the default instance refuses only its SIXTH', async () => {
    const { compactor } = harness();
    const probe = {
      messageCount: 12,
      turnIndex: 100,
      trigger: 'pressure' as const,
      lastUsage: OVER_THRESHOLD,
    };

    for (let i = 0; i < COMPACTION_LIMITS.maxPerRun - 1; i += 1) {
      await compactor.compact(ctx(conversation(6), { turnIndex: i * 10 }));
    }
    expect(compactor.shouldCompact(probe)).toBe(true);
    await compactor.compact(ctx(conversation(6), { turnIndex: 90 }));
    expect(compactor.shouldCompact(probe)).toBe(false);
  });
});
