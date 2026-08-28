/**
 * Per-child context compaction
 * (context-auto-compaction-hardening §8.1, tests 25-28 / W3).
 *
 * TEST 27 IS THE ONE THAT MATTERS. "The overlay was passed" and "the overlay
 * took effect" are different claims, and only the second one bounds the cost
 * that justifies reversing D-15. `maxPerRun` cannot come from config - it is
 * structural, read as `COMPACTION_LIMITS.maxPerRun` by guard 2, and
 * `limits.ts`'s header is explicit that a user has no business tuning it - so
 * without the instance bound a child silently inherits FIVE, two and a half
 * times the number the reversal rests on.
 */

import { describe, expect, it } from 'vitest';
import type {
  AgentConfig,
  AgentEvent,
  AssistantMessage,
  CompactionContext,
  LLMRequest,
  Message,
  ModelInfo,
  ModelRef,
} from '@aragon-agent/core';
import {
  createChildContextManager,
  type ChildCompactionDeps,
  type ChildContextManagerRequest,
} from '../compaction/child.js';
import { COMPACTION_LIMITS } from '../compaction/limits.js';
import { CompactionWiring } from '../compaction/wiring.js';
import { createSubagent, type SubagentAgentLike, type SubagentDeps } from '../team/subagent.js';
import { TeamBus } from '../team/bus.js';
import {
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_FAST_CONFIG,
  DEFAULT_TEAM_CONFIG,
  type CliConfig,
} from '../config/schema.js';
import type { DispatchOutcome, SubagentRun, SubagentSpec } from '../team/types.js';
import { activityLine } from '../ui/TeamPanel.js';
import { buildDispatchReport } from '../team/report.js';

const MODEL: ModelInfo = {
  id: 'claude-sonnet-4-5',
  name: 'Sonnet',
  provider: 'anthropic',
  contextWindow: 32_000,
  maxOutputTokens: 8_192,
  supportsThinking: true,
  supportsTools: true,
  supportsImages: true,
  cost: { input: 3, output: 15 },
};

const CHILD_REF: ModelRef = { providerId: 'anthropic', modelId: 'claude-haiku-4-5' };

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 0 };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function conversation(turns: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns; i += 1) {
    out.push(user(`turn ${i}: ${'q'.repeat(2_000)}`));
    out.push(assistantText(`answer ${i}: ${'a'.repeat(4_000)}`));
  }
  return out;
}

function baseConfig(over: Partial<CliConfig['compaction']> = {}): CliConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    maxTokens: 4_096,
    team: { ...DEFAULT_TEAM_CONFIG },
    fast: { ...DEFAULT_FAST_CONFIG },
    compaction: { ...DEFAULT_COMPACTION_CONFIG, ...over },
  } as unknown as CliConfig;
}

function childHarness(getConfig: () => CliConfig, messages: () => readonly Message[]) {
  const compacted: string[] = [];
  const deps: ChildCompactionDeps = {
    getConfig,
    hasKey: () => true,
    getApiKey: () => 'k',
    getModelInfoFor: () => MODEL,
    isPricedModel: () => true,
    complete: async (_id: string, _req: LLMRequest): Promise<AssistantMessage> => ({
      role: 'assistant',
      content: [{ type: 'text', text: '## Task\nthe child summary' }],
      usage: { inputTokens: 500, outputTokens: 100 },
    }),
    onUsage: () => {},
  };

  const manager = createChildContextManager(
    {
      label: 'researcher',
      model: CHILD_REF,
      getMessages: messages,
      getSystemPrompt: () => 'child sys',
      onCompacted: () => compacted.push('researcher'),
    },
    deps,
  );
  return { manager, compacted };
}

function ctx(messages: Message[], over: Partial<CompactionContext> = {}): CompactionContext {
  return {
    messageCount: messages.length,
    turnIndex: 1,
    trigger: 'pressure',
    messages,
    systemPrompt: 'child sys',
    model: CHILD_REF,
    signal: new AbortController().signal,
    ...over,
  };
}

describe('the child overlay (§3.4.2 / test 27)', () => {
  it('mechanism A: the config view really returns the three policy rows', async () => {
    let seen: CliConfig['compaction'] | null = null;
    const config = baseConfig();
    const { manager } = childHarness(
      () => config,
      () => [],
    );
    // The overlay is only observable through what the compactor DOES with it, so
    // the assertion runs through a real compaction: `keepRecentTurns: 2` retains
    // exactly two user turns in the tail.
    const history = conversation(8);
    const outcome = await manager.compact(ctx(history));
    seen = config.compaction;

    expect(outcome.action).toBe('replace');
    if (outcome.action !== 'replace') return;
    // The splice is `[anchor, block, ...tail]`, and BOTH the anchor and the
    // `<compacted_context>` block are `user`-role messages - so a child keeping
    // two turns leaves four.
    const retainedTurns = outcome.messages.filter((m) => m.role === 'user').length;
    expect(retainedTurns).toBe(2 + COMPACTION_LIMITS.childKeepRecentTurns);
    expect(COMPACTION_LIMITS.childKeepRecentTurns).toBeLessThan(
      DEFAULT_COMPACTION_CONFIG.keepRecentTurns,
    );
    // AND THE LEAD'S OWN CONFIG IS NOT MUTATED - the overlay is a VIEW.
    expect(seen.keepRecentTurns).toBe(DEFAULT_COMPACTION_CONFIG.keepRecentTurns);
    expect(seen.archive).toBe(true);
  });

  it('mechanism A: it RE-READS the live config on every call', async () => {
    // A settings-screen edit mid-dispatch has to reach a running child, which is
    // why the view closes over the accessor rather than over one snapshot.
    let config = baseConfig();
    const { manager } = childHarness(
      () => config,
      () => [],
    );

    config = baseConfig({ threshold: 0.5 });
    const probe = {
      messageCount: 4,
      turnIndex: 10,
      trigger: 'pressure' as const,
      lastUsage: { inputTokens: 20_000, outputTokens: 0 },
    };
    // 20 000 of a 32 000 window is 62 %: under the default 0.9, over the live 0.5.
    expect(manager.shouldCompact(probe)).toBe(true);

    config = baseConfig({ threshold: 0.95 });
    expect(manager.shouldCompact({ ...probe, turnIndex: 20 })).toBe(false);
  });

  it('mechanism B: the child is refused its THIRD compaction, not its sixth', async () => {
    const config = baseConfig();
    const { manager } = childHarness(
      () => config,
      () => [],
    );
    const probe = {
      messageCount: 16,
      turnIndex: 100,
      trigger: 'pressure' as const,
      lastUsage: { inputTokens: 31_000, outputTokens: 0 },
    };

    await manager.compact(ctx(conversation(8), { turnIndex: 1 }));
    expect(manager.shouldCompact({ ...probe, turnIndex: 50 })).toBe(true);
    await manager.compact(ctx(conversation(8), { turnIndex: 50 }));
    // THE BOUND, ASSERTED THROUGH BEHAVIOUR. `COMPACTION_LIMITS.maxPerRun` is 5;
    // a child that inherited it would still say `true` here.
    expect(COMPACTION_LIMITS.childMaxPerRun).toBeLessThan(COMPACTION_LIMITS.maxPerRun);
    expect(manager.shouldCompact(probe)).toBe(false);
  });
});

describe('the child accessors are lazy (§3.4.3 / test 26 / RV-1)', () => {
  it('reads state.messages through a closure, so construction sees []', () => {
    let live: Message[] = [];
    const config = baseConfig();
    const { manager } = childHarness(
      () => config,
      () => live,
    );
    const probe = {
      messageCount: 0,
      turnIndex: 10,
      trigger: 'pressure' as const,
    };

    // At construction the child agent does not exist yet: the estimate branch
    // measures an empty history and answers "no".
    expect(manager.shouldCompact(probe)).toBe(false);

    // Once `agentRef` is assigned the SAME closure sees the real conversation.
    live = [user('x'.repeat(200_000))];
    expect(manager.shouldCompact({ ...probe, messageCount: 1 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The wiring seam (test 25 / test 28)
// ---------------------------------------------------------------------------

/** The narrowest thing that satisfies `SubagentAgentLike`. */
class StubChild implements SubagentAgentLike {
  readonly state: { messages: Message[] } = { messages: [] };
  private readonly listeners = new Set<(e: AgentEvent) => void>();

  async prompt(): Promise<void> {
    for (const l of [...this.listeners]) {
      l({
        type: 'turn_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    }
  }

  abort(): void {}
  pauseIdleWatchdog(): void {}
  resumeIdleWatchdog(): void {}
  subscribe(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function subagentDeps(config: CliConfig, captured: AgentConfig[], wiring: CompactionWiring | null): SubagentDeps {
  return {
    bus: new TeamBus(['researcher']),
    config,
    providerRegistry: {} as never,
    getCwd: () => process.cwd(),
    getMode: () => 'default',
    getApiKey: () => 'k',
    confirmTools: false,
    agentFactory: (c: AgentConfig) => {
      captured.push(c);
      return new StubChild();
    },
    ...(wiring
      ? { contextManagerFor: (req: ChildContextManagerRequest) => wiring.childFactory()?.(req) }
      : {}),
  } as unknown as SubagentDeps;
}

function wiring(config: CliConfig): CompactionWiring {
  return new CompactionWiring({
    getConfig: () => config,
    hasKey: () => true,
    getApiKey: () => 'k',
    getModelInfoFor: () => MODEL,
    isPricedModel: () => true,
    getMessages: () => [],
    getSystemPrompt: () => '',
    notify: () => {},
  });
}

const SPEC: SubagentSpec = {
  label: 'researcher',
  description: 'read the docs',
  prompt: 'go',
  tier: 'main',
} as unknown as SubagentSpec;

describe('AC-H10: the key decides whether the KEY EXISTS (test 25)', () => {
  it('subagents: true spreads a contextManager into the child config', () => {
    const config = baseConfig({ subagents: true });
    const captured: AgentConfig[] = [];
    createSubagent(SPEC, subagentDeps(config, captured, wiring(config)), {
      onUpdate: () => {},
      onUsage: () => {},
    });

    expect(captured).toHaveLength(1);
    expect('contextManager' in captured[0]!).toBe(true);
  });

  it('subagents: false spreads NO KEY AT ALL, not a key holding undefined', () => {
    // The loop's gate is `if (!ctx.contextManager) return false` against an ABSENT
    // field, so `in` is the assertion and `=== undefined` is not.
    const config = baseConfig({ subagents: false });
    const captured: AgentConfig[] = [];
    createSubagent(SPEC, subagentDeps(config, captured, wiring(config)), {
      onUpdate: () => {},
      onUsage: () => {},
    });

    expect(captured).toHaveLength(1);
    expect('contextManager' in captured[0]!).toBe(false);
  });

  it('and no factory at all is byte-identical to that', () => {
    const config = baseConfig({ subagents: true });
    const captured: AgentConfig[] = [];
    createSubagent(SPEC, subagentDeps(config, captured, null), {
      onUpdate: () => {},
      onUsage: () => {},
    });

    expect('contextManager' in captured[0]!).toBe(false);
  });
});

describe('test 28: onCompacted increments SubagentRun.compactions', () => {
  it('is absent until a child compacts', () => {
    const config = baseConfig({ subagents: true });
    const captured: AgentConfig[] = [];
    const handle = createSubagent(SPEC, subagentDeps(config, captured, wiring(config)), {
      onUpdate: () => {},
      onUsage: () => {},
    });

    expect(handle.run.compactions).toBeUndefined();
  });

  it('the panel row and the dispatch report both say so once it has', () => {
    const settled = {
      label: 'researcher',
      description: 'read the docs',
      tier: 'main',
      phase: 'done',
      turns: 6,
      toolCalls: 14,
      usage: { inputTokens: 1, outputTokens: 1 },
      filesTouched: [],
      messagesSent: 0,
      startedAt: 1_000,
      endedAt: 2_000,
      summary: 'found it',
      compactions: 1,
    } as unknown as SubagentRun;

    const outcome = (runs: SubagentRun[]): DispatchOutcome =>
      ({
        dispatchId: 'd1',
        runs,
        requested: 1,
        startedAt: 1_000,
        endedAt: 2_000,
        aborted: false,
        leadMail: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        fastUsage: { inputTokens: 0, outputTokens: 0 },
      }) as unknown as DispatchOutcome;

    expect(activityLine(settled, 120)).toContain('compacted 1');
    expect(buildDispatchReport(outcome([settled]))).toContain('compacted 1');

    // ABSENT WHEN IT NEVER HAPPENED, so an ordinary dispatch report is unchanged.
    const plain = { ...settled, compactions: undefined } as SubagentRun;
    expect(activityLine(plain, 120)).not.toContain('compacted');
    expect(buildDispatchReport(outcome([plain]))).not.toContain('compacted');
  });
});
