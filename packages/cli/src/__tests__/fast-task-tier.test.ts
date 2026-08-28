/**
 * `model: "fast"` end to end through `task` (fast-model-tier §3.4 / §8.1).
 *
 * THE SILENT DOWNGRADE IS THE FAILURE THESE TESTS EXIST TO PREVENT (R-6): the
 * model asks for a cheap child, gets an expensive one, and has no way to learn
 * that its cost model is wrong. So the downgrade is COUNTED in the normalizer,
 * STATED in the report, and the per-tier `ModelRef` is asserted against a stub
 * factory that captures what each child was actually built with.
 */

import { describe, expect, it } from 'vitest';
import type { AgentConfig, AgentEvent, ProviderRegistry } from '@aragon-agent/core';
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
} from '../config/schema.js';
import { normalizeSubagentSpecs } from '../team/normalize.js';
import { buildDispatchReport } from '../team/report.js';
import { TeamRuntime } from '../team/runtime.js';
import type { SubagentAgentLike } from '../team/subagent.js';
import type { DispatchOutcome, SubagentRun } from '../team/types.js';

// ---------------------------------------------------------------------------
// Normalization (§3.4)
// ---------------------------------------------------------------------------

const raw = (over: Record<string, unknown> = {}) => ({
  label: 'scan',
  description: 'read the auth middleware',
  prompt: 'Read src/auth and report.',
  ...over,
});

describe('normalizeSubagentSpecs - the `model` field', () => {
  it('honours `model:"fast"` when the tier is available', () => {
    const out = normalizeSubagentSpecs([raw({ model: 'fast' })], 5, { fastAvailable: true });
    expect(out.specs[0]!.tier).toBe('fast');
    expect(out.downgraded).toBe(0);
  });

  it('AC-16: downgrades and COUNTS when the tier is not available', () => {
    const out = normalizeSubagentSpecs([raw({ model: 'fast' })], 5, { fastAvailable: false });
    expect(out.specs[0]!.tier).toBe('main');
    expect(out.downgraded).toBe(1);
  });

  it('RV-14: `opts` is OPTIONAL and defaults to "no fast tier"', () => {
    // A pre-feature call site — and there are several, plus their tests — must
    // mean exactly what it always meant. A required third parameter would be a
    // breaking edit that buys nothing.
    const out = normalizeSubagentSpecs([raw({ model: 'fast' })], 5);
    expect(out.specs[0]!.tier).toBe('main');
    expect(out.downgraded).toBe(1);
  });

  it('does not count a spec that never asked for the fast tier', () => {
    const out = normalizeSubagentSpecs(
      [raw(), raw({ label: 'b', model: 'main' }), raw({ label: 'c', model: 'nonsense' })],
      5,
      { fastAvailable: false },
    );
    expect(out.specs.map((s) => s.tier)).toEqual(['main', 'main', 'main']);
    expect(out.downgraded).toBe(0);
  });

  it('counts over the SURVIVORS, not over everything the model wrote', () => {
    // A spec the cap dropped never ran at all, so reporting it as "ran on the
    // main model" would be a second, different lie in a line that exists to stop
    // the first.
    const specs = Array.from({ length: 5 }, (_, i) => raw({ label: `a${i}`, model: 'fast' }));
    const out = normalizeSubagentSpecs(specs, 2, { fastAvailable: false });
    expect(out.specs).toHaveLength(2);
    expect(out.requested).toBe(5);
    expect(out.downgraded).toBe(2);
  });

  it('repairs, never rejects (the file`s own contract)', () => {
    const out = normalizeSubagentSpecs([raw({ model: 42 })], 5, { fastAvailable: true });
    expect(out.specs[0]!.tier).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// Per-tier ModelRef (§3.4)
// ---------------------------------------------------------------------------

function config(): CliConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    thinkingLevel: 'high',
    showThinking: false,
    liveToolOutput: false,
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
    team: { ...DEFAULT_TEAM_CONFIG, maxConcurrent: 2 },
    todo: DEFAULT_TODO_CONFIG,
    bash: DEFAULT_BASH_CONFIG,
    retry: DEFAULT_RETRY_CONFIG,
    // The NINTH nested section. `enabled: false` on purpose: these fixtures
    // are about other subsystems, and the same `enabled: false` appears above
    // for `skills`, `team` and `todo` for exactly that reason.
    compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false },
    fast: { ...DEFAULT_FAST_CONFIG, enabled: true, model: 'claude-haiku-4-5' },
    update: DEFAULT_UPDATE_CONFIG,
    submitCount: 0,
    cwd: process.cwd(),
    color: true,
  };
}

/** A child that answers immediately, so the scheduler runs off the network. */
function stubAgent(captured: AgentConfig[]): (c: AgentConfig) => SubagentAgentLike {
  return (agentConfig) => {
    captured.push(agentConfig);
    const listeners = new Set<(e: AgentEvent) => void>();
    return {
      async prompt() {
        for (const l of [...listeners]) {
          l({
            type: 'turn_end',
            message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
            usage: { inputTokens: 100, outputTokens: 20 },
          });
        }
      },
      abort() {},
      subscribe(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      pauseIdleWatchdog() {},
      resumeIdleWatchdog() {},
      // `SubagentAgentLike` gained `state.messages` so a child can read its own
      // history for compaction (hardening W3 / RV-1). Narrowed to the one field,
      // so a stub satisfies it with an empty array.
      state: { messages: [] },
    };
  };
}

describe('AC-14: a fast child is built with the FAST ModelRef and thinking level', () => {
  it('and a main sibling is byte-identical to a pre-feature child', async () => {
    const captured: AgentConfig[] = [];
    const runtime = new TeamRuntime({
      getConfig: config,
      providerRegistry: {} as ProviderRegistry,
      getCwd: () => process.cwd(),
      getMode: () => 'build',
      getApiKey: () => 'k',
      agentFactory: stubAgent(captured),
      resolveTier: (tier) =>
        tier === 'fast'
          ? {
              ref: { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
              thinkingLevel: 'off',
            }
          : {
              ref: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5-20250929' },
              thinkingLevel: 'high',
            },
    });

    const { specs, downgraded } = normalizeSubagentSpecs(
      [raw({ label: 'cheap', model: 'fast' }), raw({ label: 'careful' })],
      5,
      { fastAvailable: true },
    );
    const outcome = await runtime.dispatch(specs, 2, undefined, { downgraded });

    expect(captured).toHaveLength(2);
    expect(captured[0]!.model.modelId).toBe('claude-haiku-4-5');
    // `thinkingLevel` is PER TIER and defaults to `off` for the fast tier
    // (D-13): a "fast" model asked to think for 32 768 tokens is not fast.
    expect(captured[0]!.thinkingLevel).toBe('off');
    expect(captured[1]!.model.modelId).toBe('claude-sonnet-4-5-20250929');
    expect(captured[1]!.thinkingLevel).toBe('high');

    // AC-17: the two tiers' spend is SPLIT, so the report can price each at its
    // own table.
    expect(outcome.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(outcome.fastUsage).toEqual({ inputTokens: 100, outputTokens: 20 });
    expect(outcome.runs.map((r) => r.tier)).toEqual(['fast', 'main']);
  }, 15_000);

  it('a dispatch with no fast child leaves `fastUsage` ABSENT', async () => {
    const captured: AgentConfig[] = [];
    const runtime = new TeamRuntime({
      getConfig: config,
      providerRegistry: {} as ProviderRegistry,
      getCwd: () => process.cwd(),
      getMode: () => 'build',
      getApiKey: () => 'k',
      agentFactory: stubAgent(captured),
    });
    const { specs } = normalizeSubagentSpecs([raw()], 5);
    const outcome = await runtime.dispatch(specs, 1);
    // The shape of an ordinary dispatch is unchanged, which is what keeps every
    // pre-feature consumer of `DispatchOutcome` working.
    expect(outcome.fastUsage).toBeUndefined();
    expect(outcome.downgraded).toBeUndefined();
    expect(outcome.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  }, 15_000);
});

// ---------------------------------------------------------------------------
// The report (§3.4 / AC-17 / AC-34)
// ---------------------------------------------------------------------------

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'a1',
    description: 'read the auth middleware',
    tier: 'main',
    phase: 'done',
    startedAt: 1000,
    endedAt: 2000,
    turns: 1,
    toolCalls: 1,
    usage: { inputTokens: 100, outputTokens: 20 },
    filesTouched: [],
    messagesSent: 0,
    summary: 's',
    ...over,
  };
}

function outcome(over: Partial<DispatchOutcome> = {}): DispatchOutcome {
  return {
    dispatchId: 'd1',
    runs: [run(), run({ label: 'a2', tier: 'fast' })],
    requested: 2,
    startedAt: 1000,
    endedAt: 3000,
    aborted: false,
    leadMail: [],
    usage: { inputTokens: 100, outputTokens: 20 },
    fastUsage: { inputTokens: 900, outputTokens: 300 },
    ...over,
  };
}

describe('buildDispatchReport - two tiers, two cost tables', () => {
  it('annotates fast rows and prices each tier at its OWN table (AC-17)', () => {
    const text = buildDispatchReport(outcome(), {
      cost: { input: 3, output: 15 },
      fastCost: { input: 1, output: 5 },
    });
    expect(text).toContain('### a2 [fast]');
    expect(text).not.toContain('### a1 [fast]');
    expect(text).toContain('Fast tier: in 900, out 300.');
    // Two lines, never one total: a Haiku child priced at Sonnet rates
    // over-reports by roughly an order of magnitude (R-7).
    expect(text).toMatch(/Tokens: in 100, out 20\. Cost: /);
  });

  it('AC-34: unknown pricing renders as `unknown`, NEVER as `$0.00`', () => {
    const text = buildDispatchReport(outcome(), {
      cost: { input: 3, output: 15 },
      fastPricingUnknown: true,
    });
    expect(text).toContain('Fast tier: in 900, out 300. Cost: unknown (no price table).');
    expect(text).not.toContain('Fast tier: in 900, out 300. Cost: $0.00');
  });

  it('R-6: a downgrade is STATED, never silent', () => {
    const text = buildDispatchReport(
      outcome({ runs: [run(), run({ label: 'a2' })], fastUsage: undefined, downgraded: 2 }),
      { cost: { input: 3, output: 15 } },
    );
    expect(text).toContain('2 subagents ran on the main model (fast tier off).');
  });

  it('a dispatch with no fast child is byte-identical to the pre-feature report', () => {
    const plain = outcome({ runs: [run()], fastUsage: undefined });
    const text = buildDispatchReport(plain, { cost: { input: 3, output: 15 } });
    expect(text).not.toContain('Fast tier:');
    expect(text).not.toContain('[fast]');
    expect(text).not.toContain('main model (fast tier off)');
  });
});
