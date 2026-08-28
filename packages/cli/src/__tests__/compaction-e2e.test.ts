/**
 * The compaction stack, end to end, against a scripted provider
 * (context-auto-compaction-hardening §3.7 / §8.2 / W6).
 *
 * SIX OF THE SEVEN NOT-SKIPPABLE MANUAL ROWS, CONVERTED. Round 1 shipped a
 * feature whose failure mode is "the session becomes permanently un-sendable",
 * defended entirely by unit tests that mock the summarization call - the digest,
 * the prompt, the registry, the retry policy, the splice and the event stream
 * had never run together even once.
 *
 * A REAL `Agent` AND A REAL `CompactionWiring`, BUT NO `AgentController`
 * (DH-12). The controller constructs tools, skills and a dozen subsystems these
 * rows have nothing to say about, and a harness that is expensive to stand up is
 * a harness nobody extends.
 *
 * WHAT THIS DOES NOT CLAIM. The scripted provider implements the same interface
 * the real adapters do, but rows 4, 6, 7 and 8 stay manual precisely so the
 * live-provider path keeps a human check. After this file the compaction stack
 * is TESTED, not OBSERVED.
 */

import { describe, expect, it } from 'vitest';
import {
  Agent,
  ProviderRegistry,
  type AgentEvent,
  type Message,
  type ModelInfo,
  type ModelRef,
} from '@aragon-agent/core';
import { CompactionWiring } from '../compaction/wiring.js';
import type { CompactionEvent, CompactionRecord } from '../compaction/types.js';
import {
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_FAST_CONFIG,
  type CliConfig,
} from '../config/schema.js';
import { scriptedProvider, type ScriptStep } from './helpers/scripted-provider.js';

const PROVIDER_ID = 'anthropic';
const REF: ModelRef = { providerId: PROVIDER_ID, modelId: 'claude-sonnet-4-5' };

function modelInfo(contextWindow: number): ModelInfo {
  return {
    id: 'claude-sonnet-4-5',
    name: 'Sonnet',
    provider: PROVIDER_ID,
    contextWindow,
    maxOutputTokens: 8_192,
    supportsThinking: true,
    supportsTools: true,
    supportsImages: true,
    cost: { input: 3, output: 15 },
  };
}

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 0 };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

/** A history whose ESTIMATE alone is roughly `tokens`. */
function historyOfSize(tokens: number): Message[] {
  const out: Message[] = [];
  const perMessage = 8_000; // ~2 000 tokens
  const count = Math.max(6, Math.ceil((tokens * 4) / perMessage));
  for (let i = 0; i < count; i += 1) {
    out.push(user(`turn ${i}: ${'q'.repeat(perMessage)}`));
    out.push(assistantText(`answer ${i}`));
  }
  return out;
}

interface HarnessOpts {
  contextWindow?: number;
  compaction?: Partial<CliConfig['compaction']>;
  /** Served through `stream()` AND `complete()` from one queue. */
  script?: ScriptStep[];
  seed?: Message[];
}

function harness(opts: HarnessOpts = {}) {
  const info = modelInfo(opts.contextWindow ?? 200_000);
  const config = {
    provider: PROVIDER_ID,
    model: 'claude-sonnet-4-5',
    maxTokens: 4_096,
    fast: { ...DEFAULT_FAST_CONFIG },
    compaction: { ...DEFAULT_COMPACTION_CONFIG, archive: false, ...opts.compaction },
  } as unknown as CliConfig;

  const provider = scriptedProvider(PROVIDER_ID, opts.script ?? []);
  const registry = new ProviderRegistry({ retryPolicy: null });
  registry.register(provider);

  const events: CompactionEvent[] = [];
  const agentEvents: AgentEvent[] = [];
  let agent: Agent | null = null;

  const wiring = new CompactionWiring({
    getConfig: () => config,
    hasKey: () => true,
    getApiKey: () => 'k',
    getModelInfoFor: () => info,
    isPricedModel: () => true,
    // LAZY, because the wiring is constructed BEFORE the `Agent` - the C-12 split
    // this harness has to honour exactly as `AgentController` does.
    getMessages: () => agent?.state.messages ?? [],
    getSystemPrompt: () => agent?.state.systemPrompt ?? '',
    notify: () => {},
    // THE ONE PRODUCTION SEAM (DH-13). Without it the SUMMARIZER's transport is
    // the real `initProviders`, i.e. a network call, while the lead's is scripted.
    createRegistry: () => registry,
  });
  wiring.subscribe((e) => events.push(e));

  agent = new Agent({
    systemPrompt: 'sys',
    model: REF,
    tools: [],
    providerRegistry: registry,
    getApiKey: () => 'k',
    maxTokens: 4_096,
    contextManager: wiring.manager(),
    timeouts: { idleTimeout: 30_000 },
  });
  agent.subscribe((e) => agentEvents.push(e));
  wiring.attach((listener) => agent!.subscribe(listener));
  if (opts.seed) agent.replaceMessages(opts.seed);

  const ends = (): CompactionRecord[] =>
    events
      .filter((e): e is Extract<CompactionEvent, { type: 'compaction_end' }> => e.type === 'compaction_end')
      .map((e) => e.record);

  return { agent, wiring, provider, events, agentEvents, ends, config };
}

describe('row 1 - small-window headroom co-trigger', () => {
  it('triggers on headroom, not ratio, on a 32k window', async () => {
    // 90 % OF A 32 k WINDOW LEAVES 3.2 k, WHICH IS LESS THAN ONE `max_tokens`.
    // A pure-ratio trigger is correct for the models most users run and quietly
    // wrong for the small ones.
    const seed = historyOfSize(23_000);
    const h = harness({
      contextWindow: 32_000,
      seed,
      script: [
        { kind: 'summary', text: '## Task\ncompacted' },
        { kind: 'assistant', text: 'answered' },
      ],
    });

    await h.agent.prompt('go');

    const records = h.ends();
    expect(records).toHaveLength(1);
    expect(records[0]!.applied).toBe(true);
    // The ratio is nowhere near 0.9; the headroom term is what fired.
    const ratio = h.wiring.snapshot().pressure.ratio;
    expect(ratio).toBeLessThan(0.9);
  });
});

describe('row 2 - resume pressure on the estimate path', () => {
  it('a resumed 180k history compacts on turn 1 with no lastUsage', async () => {
    // THE CR-1 REGRESSION, NOW END TO END. `lastUsage` is `undefined` before the
    // first `turn_end` of a run, which is exactly what `/resume` on a huge
    // conversation looks like - and the estimate branch is the only one there.
    const h = harness({
      seed: historyOfSize(190_000),
      script: [
        { kind: 'summary', text: '## Task\ncompacted' },
        { kind: 'assistant', text: 'answered' },
      ],
    });

    await h.agent.prompt('continue');

    expect(h.ends()[0]?.applied).toBe(true);
    // AND THE REQUEST THAT WENT OUT CARRIED THE COMPACTED HISTORY - the assertion
    // the manual row exists to make.
    const sent = h.provider.agentRequests.at(-1)!;
    expect(sent.messages.length).toBeLessThan(20);
    expect(JSON.stringify(sent.messages)).toContain('compacted_context');
  });
});

describe('row 3 - wrong-window recovery through the reactive path', () => {
  it('a provider that overflows once completes after one compaction and one re-send', async () => {
    const h = harness({
      seed: historyOfSize(40_000),
      script: [
        { kind: 'overflow' },
        { kind: 'summary', text: '## Task\ncompacted' },
        { kind: 'assistant', text: 'answered after recovery' },
      ],
    });

    await h.agent.prompt('go');

    const records = h.ends();
    expect(records).toHaveLength(1);
    expect(records[0]!.trigger).toBe('overflow');
    expect(records[0]!.applied).toBe(true);
    // TWO AGENT-LOOP REQUESTS: the refused one, then the compacted re-send. The
    // summarization is a THIRD request on this provider, and it is deliberately
    // not counted here - see `agentRequests`.
    expect(h.provider.agentRequests).toHaveLength(2);
    expect(h.provider.summarizerRequests).toHaveLength(1);
    expect(JSON.stringify(h.provider.agentRequests[1]!.messages)).toContain('compacted_context');
  });
});

describe('row 5 - the failure ladder', () => {
  it('summarization fails twice, truncation happens, and it is announced', async () => {
    const notices: string[] = [];
    const info = modelInfo(200_000);
    const config = {
      provider: PROVIDER_ID,
      model: 'claude-sonnet-4-5',
      maxTokens: 4_096,
      fast: { ...DEFAULT_FAST_CONFIG },
      compaction: { ...DEFAULT_COMPACTION_CONFIG, archive: false },
    } as unknown as CliConfig;

    const provider = scriptedProvider(PROVIDER_ID, [
      { kind: 'error', errorType: 'server_error' },
      { kind: 'error', errorType: 'server_error' },
      { kind: 'assistant', text: 'answered anyway' },
    ]);
    const registry = new ProviderRegistry({ retryPolicy: null });
    registry.register(provider);

    let agent: Agent | null = null;
    const events: CompactionEvent[] = [];
    const wiring = new CompactionWiring({
      getConfig: () => config,
      hasKey: () => true,
      getApiKey: () => 'k',
      getModelInfoFor: () => info,
      isPricedModel: () => true,
      getMessages: () => agent?.state.messages ?? [],
      getSystemPrompt: () => agent?.state.systemPrompt ?? '',
      notify: (_level, text) => notices.push(text),
      createRegistry: () => registry,
    });
    wiring.subscribe((e) => events.push(e));

    agent = new Agent({
      systemPrompt: 'sys',
      model: REF,
      tools: [],
      providerRegistry: registry,
      getApiKey: () => 'k',
      maxTokens: 4_096,
      contextManager: wiring.manager(),
      timeouts: { idleTimeout: 30_000 },
    });
    wiring.attach((listener) => agent!.subscribe(listener));
    agent.replaceMessages(historyOfSize(190_000));

    await agent.prompt('go');

    const record = events
      .filter((e): e is Extract<CompactionEvent, { type: 'compaction_end' }> => e.type === 'compaction_end')
      .map((e) => e.record)[0]!;

    // RUNG 1 AND RUNG 2 BOTH RAN - two `complete()` calls - then rung 3 truncated.
    expect(provider.summarizerRequests).toHaveLength(2);
    expect(record.mode).toBe('truncated');
    expect(notices.join(' ')).toContain('without a summary');
  });
});

describe('row 10 - two compactions in one session', () => {
  it('the second carries the first block forward whole', async () => {
    const h = harness({
      seed: historyOfSize(190_000),
      script: [
        { kind: 'summary', text: '## Task\nfirst generation summary' },
        { kind: 'assistant', text: 'answered' },
      ],
    });

    await h.agent.prompt('one');
    expect(h.ends()).toHaveLength(1);

    // Refill the window and go round again.
    h.agent.replaceMessages([...h.agent.state.messages, ...historyOfSize(190_000)]);
    await h.agent.prompt('two');

    const records = h.ends();
    expect(records.length).toBeGreaterThanOrEqual(2);
    // THE DIGEST HANDED TO THE SUMMARIZER CONTAINS THE PRIOR BLOCK VERBATIM
    // (D-22): a second compaction MERGES the first forward rather than
    // summarizing a summary from nothing.
    const secondDigest = JSON.stringify(h.provider.summarizerRequests.at(-1)!.messages);
    expect(secondDigest).toContain('first generation summary');
    expect(h.wiring.snapshot().generation).toBeGreaterThanOrEqual(2);
  });
});

describe('AC-H1 - off is byte-identical', () => {
  it('with no contextManager the provider sees exactly one request and no events', async () => {
    const provider = scriptedProvider(PROVIDER_ID, [{ kind: 'assistant', text: 'hi' }]);
    const registry = new ProviderRegistry({ retryPolicy: null });
    registry.register(provider);

    const agent = new Agent({
      systemPrompt: 'sys',
      model: REF,
      tools: [],
      providerRegistry: registry,
      getApiKey: () => 'k',
      timeouts: { idleTimeout: 30_000 },
    });
    const events: AgentEvent[] = [];
    agent.subscribe((e) => events.push(e));
    agent.replaceMessages(historyOfSize(190_000));

    await agent.prompt('go');

    expect(provider.agentRequests).toHaveLength(1);
    expect(provider.summarizerRequests).toHaveLength(0);
    expect(events.some((e) => e.type === 'compaction_start')).toBe(false);
    expect(events.some((e) => e.type === 'compaction_end')).toBe(false);
  });
});

describe('AC-Q14: core still reports a declined attempt, so the watchdog still cycles', () => {
  /**
   * THE ENGINE'S PAIR IS NOT A UI EVENT, AND MUST NOT BE MADE ONE.
   *
   * `compaction_start` PAUSES the idle watchdog and `compaction_end` RESUMES it
   * (`Agent.applyWatchdogPolicy`), which is why core emits the end from a
   * `finally`. The quiet no-op suppresses the CLI's OWN pair for a `pressure`
   * compaction that declined before doing any work; suppressing core's would
   * leave the run permanently deaf, and this row is what makes that regression
   * fail loudly instead of two minutes into someone's next long session.
   *
   * IT IS ALSO WHERE THE OBSERVABILITY CLAIM IS CHECKED. "Quiet, not unrecorded"
   * rests on this pair still firing: the JSONL diagnostic log subscribes to
   * core's stream, not the CLI's.
   */
  it('a pressure checkpoint that finds nothing to drop emits core\'s pair and no card', async () => {
    // ONE enormous user turn: the estimate alone clears the threshold, so the
    // checkpoint fires - and with fewer than `keepRecentTurns` turns behind it
    // there is no cut to make and no tool result to clip.
    const h = harness({
      seed: [user(`the only turn: ${'q'.repeat(800_000)}`)],
      script: [{ kind: 'assistant', text: 'answered anyway' }],
    });

    await h.agent.prompt('go');

    const coreStarts = h.agentEvents.filter((e) => e.type === 'compaction_start');
    const coreEnds = h.agentEvents.filter((e) => e.type === 'compaction_end');
    expect(coreStarts).toHaveLength(1);
    expect(coreEnds).toHaveLength(1);
    expect(coreEnds[0]).toMatchObject({ applied: false, reason: 'nothing_to_drop' });

    // AND NOTHING ON THE CLI STREAM: no card was opened, so the transcript is
    // indistinguishable from a turn at which the threshold was never crossed.
    expect(h.events.filter((e) => e.type === 'compaction_start')).toHaveLength(0);
    expect(h.ends()).toHaveLength(0);
    // The summarizer was never called - a decline costs nothing.
    expect(h.provider.summarizerRequests).toHaveLength(0);
    // It is still counted where counting it is not noise.
    expect(h.wiring.snapshot().declined).toBe(1);
  });
});
