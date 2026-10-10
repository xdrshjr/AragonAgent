/**
 * The reviewer's own fail-fast provider registry (fast-model-tier-hardening W2 /
 * §7.1 tests 9-11).
 *
 * THE DEFECT THIS CLOSES. `ProviderRegistry.complete()` routes through a
 * RETRYING `stream()`, the policy is per-registry, and `LLMRequest` carries no
 * per-request override (round 1's IF-3) - so the background review inherited the
 * lead's `DEFAULT_RETRY_POLICY` with `maxRetries: 10`. During the one condition
 * where the fast tier is most likely to be failing (a rate-limited or overloaded
 * provider), an advisory nobody asked for retried ten times against the same
 * provider quota the user's actual work needs.
 *
 * IT NEEDS NO `packages/core` CHANGE, which is what made it cheap enough to fix
 * here: `initProviders()` is exported and returns a FRESH registry per call with
 * all three adapters registered - exactly the set `resolveFastTier` rule 4 gates
 * on. These cases pin the three properties that make the fix real: the reviewer
 * does NOT call the lead's transport, the policy it does call under is one
 * retry, and nothing at all is constructed while the tier is off (which is what
 * keeps the off path byte-identical to round 1).
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AssistantMessage } from '@aragon-agent/core';
import {
  DEFAULT_FAST_CONFIG,
  DEFAULT_UPDATE_CONFIG,
  DEFAULT_LOG_CONFIG,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_SKILLS_RUNTIME,
  DEFAULT_TEAM_CONFIG,
  DEFAULT_TODO_CONFIG,
  DEFAULT_BASH_CONFIG,
  type CliConfig,
  type FastConfig,
} from '../config/schema.js';
import { FastWiring } from '../fast/wiring.js';

const mocks = vi.hoisted(() => ({
  /** Every `initProviders()` call the CLI makes, with its options. */
  initCalls: [] as Array<{ retryPolicy?: { maxRetries?: number } | null } | undefined>,
  fastComplete: vi.fn(
    async (): Promise<AssistantMessage> => ({
      role: 'assistant',
      content: [{ type: 'text', text: 'OK - on track.' }],
      usage: { inputTokens: 10, outputTokens: 4 },
    }),
  ),
}));

vi.mock('@aragon-agent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aragon-agent/core')>();
  return {
    ...actual,
    initProviders: (options?: { retryPolicy?: { maxRetries?: number } | null }) => {
      mocks.initCalls.push(options);
      return { complete: mocks.fastComplete } as never;
    },
  };
});

const { DEFAULT_RETRY_POLICY } = await import('@aragon-agent/core');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function cliConfig(fast: Partial<FastConfig>): CliConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    thinkingLevel: 'high',
    showThinking: false,
    liveToolOutput: false,
    contextWindow: null,
    theme: 'auto',
    reducedMotion: false,
    exitTranscript: true,
    transcriptWindow: 300,
    transcriptRetain: 1000,
    renderGovernor: true,
    maxRenderIntervalMs: 320,
    diffRender: true,
    syncOutput: true,
    confirmTools: false,
    toolTimeoutMs: 180_000,
    idleTimeoutMs: 210_000,
    apiKeys: { anthropic: 'k' },
    historyEnabled: true,
    density: 'comfortable',
    hints: true,
    mouse: true,
    mouseSelect: true,
    paste: true,
    scrollResumeMs: 5000,
    startInPlanMode: false,
    planModeMaxAskRounds: 4,
    planModeHumanTimeoutMs: 1_800_000,
    skills: DEFAULT_SKILLS_CONFIG,
    skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    log: DEFAULT_LOG_CONFIG,
    team: DEFAULT_TEAM_CONFIG,
    todo: DEFAULT_TODO_CONFIG,
    bash: DEFAULT_BASH_CONFIG,
    retry: DEFAULT_RETRY_CONFIG,
    // The NINTH nested section. `enabled: false` on purpose: these fixtures
    // are about other subsystems, and the same `enabled: false` appears above
    // for `skills`, `team` and `todo` for exactly that reason.
    compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false },
    fast: {
      ...DEFAULT_FAST_CONFIG,
      enabled: true,
      model: 'claude-haiku-4-5',
      reviewEveryTurns: 1,
      ...fast,
    },
    update: DEFAULT_UPDATE_CONFIG,
    submitCount: 0,
    cwd: process.cwd(),
    color: true,
    keyboardEnhancement: false,
  };
}

interface Rig {
  wiring: FastWiring;
  /** The LEAD's transport, which the reviewer must never touch. */
  leadComplete: ReturnType<typeof vi.fn>;
  replayTurn(): Promise<void>;
}

function rig(fast: Partial<FastConfig>): Rig {
  mocks.initCalls.length = 0;
  mocks.fastComplete.mockClear();
  const listeners = new Set<(e: AgentEvent) => void>();
  const config = cliConfig(fast);
  const leadComplete = vi.fn(
    async (): Promise<AssistantMessage> => ({ role: 'assistant', content: [] }),
  );

  const wiring = new FastWiring({
    getConfig: () => config,
    hasKey: () => true,
    getApiKey: () => 'k',
    isPricedModel: () => true,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    complete: leadComplete,
    steer: () => {},
    isRunning: () => true,
    isAbortRequested: () => false,
    userSteerCount: () => 0,
    clearAllQueues: () => {},
    notify: () => {},
    onPromptChanged: () => {},
  });

  const emit = (event: AgentEvent): void => {
    for (const l of [...listeners]) l(event);
  };

  return {
    wiring,
    leadComplete,
    replayTurn: async () => {
      emit({ type: 'agent_start' });
      emit({ type: 'turn_start' });
      emit({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', toolCallId: 'c0', toolName: 'read_file', args: {} }],
        },
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      emit({
        type: 'tool_execution_end',
        toolCallId: 'c0',
        toolName: 'read_file',
        result: { content: [] },
        isError: false,
        duration: 5,
      });
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

// ---------------------------------------------------------------------------

describe('the reviewer does not call through the lead`s registry (test 9 / AC-H9)', () => {
  it('routes the review to the fast registry and leaves the lead untouched', async () => {
    const r = rig({});
    await r.replayTurn();

    expect(mocks.fastComplete).toHaveBeenCalledTimes(1);
    expect(r.leadComplete).not.toHaveBeenCalled();
    r.wiring.dispose();
  });
});

describe('the fast policy is one retry (test 10 / D-H3)', () => {
  it('constructs the registry with `maxRetries: 1` and logs it', async () => {
    const r = rig({});
    await r.replayTurn();

    expect(mocks.initCalls).toHaveLength(1);
    expect(mocks.initCalls[0]?.retryPolicy?.maxRetries).toBe(1);
    r.wiring.dispose();
  });

  it('spreads the default rather than replacing it, and never mutates it', async () => {
    const r = rig({});
    await r.replayTurn();

    const policy = mocks.initCalls[0]?.retryPolicy as Record<string, unknown>;
    // `respectRetryAfter` and the transient classification stay exactly as the
    // lead's; only the attempt count differs. And the shared default object is
    // untouched, which a mutating "optimisation" would silently break for the
    // user's own work.
    expect(policy['respectRetryAfter']).toBe(DEFAULT_RETRY_POLICY.respectRetryAfter);
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(10);
    r.wiring.dispose();
  });

  it('builds ONE registry however many reviews run', async () => {
    const r = rig({ reviewMaxPerSession: 5 });
    await r.replayTurn();
    await r.replayTurn();
    await r.replayTurn();

    expect(mocks.fastComplete.mock.calls.length).toBeGreaterThan(1);
    expect(mocks.initCalls).toHaveLength(1);
    r.wiring.dispose();
  });
});

describe('nothing is constructed while the tier is idle (test 11 / AC-H13)', () => {
  it('builds no registry when `review` is off', async () => {
    const r = rig({ review: false });
    await r.replayTurn();

    expect(mocks.initCalls).toHaveLength(0);
    expect(mocks.fastComplete).not.toHaveBeenCalled();
    r.wiring.dispose();
  });

  it('builds no registry when the tier itself is off', async () => {
    const r = rig({ enabled: false });
    await r.replayTurn();

    // The byte-identity guarantee: a session that never uses the tier allocates
    // no registry and registers no adapters.
    expect(mocks.initCalls).toHaveLength(0);
    expect(r.wiring.available()).toBe(false);
    r.wiring.dispose();
  });
});
