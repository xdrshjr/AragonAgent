/**
 * Main-agent model parity for `task` children.
 *
 * EVERY CHILD RUNS THE LEAD'S OWN MODEL - same provider, same model id, same
 * thinking level, resolved from the live config at dispatch - and the fast
 * tier reaches children the same way it reaches the lead (per-child reviews),
 * never as a per-child `model: "fast"` downgrade. These tests pin that
 * contract at every layer it touches:
 *
 *   1. the normalizer silently ignores a stale `model` key (there is no tier
 *      to downgrade TO, and no report line about a capability that no longer
 *      exists);
 *   2. the runtime builds every child with the LEAD's `ModelRef`, even in a
 *      session whose fast tier is live and resolvable;
 *   3. the outcome and the report carry ONE usage total at the lead's price
 *      table - no `fastUsage`, no `downgraded`, no `Fast tier:` line;
 *   4. the no-limit regime: `subagentTimeoutMs` / `dispatchTimeoutMs` /
 *      `maxTurnsPerSubagent` default to 0 = NO ceiling, and an explicit 0
 *      sticks through `clampTeamConfig` (the `scrollResumeMs` trap);
 *   5. the per-child reviewer (`createChildReviewer`) declines when the
 *      wiring is off, attaches when it is live, and runs the SAME review
 *      protocol as the lead's: one call through the shared fast transport,
 *      parked, then steered at the next batch-empty window - never into a
 *      run that is not running.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig, AgentEvent, AssistantMessage, LLMRequest, ProviderRegistry } from '@aragon-agent/core';
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
  clampTeamConfig,
  type CliConfig,
} from '../config/schema.js';
import { normalizeSubagentSpecs } from '../team/normalize.js';
import { buildDispatchReport } from '../team/report.js';
import { TeamRuntime } from '../team/runtime.js';
import { createChildReviewer } from '../team/child-reviewer.js';
import type { SubagentAgentLike } from '../team/subagent.js';
import type { DispatchOutcome, SubagentRun } from '../team/types.js';

// ---------------------------------------------------------------------------
// 1. Normalization: a stale `model` key is silence, not a downgrade
// ---------------------------------------------------------------------------

const raw = (over: Record<string, unknown> = {}) => ({
  label: 'scan',
  description: 'read the auth middleware',
  prompt: 'Read src/auth and report.',
  ...over,
});

describe('normalizeSubagentSpecs - stale `model` keys', () => {
  it('ignores `model:"fast"` from an older prompt: no tier, no downgrade count', () => {
    const out = normalizeSubagentSpecs([raw({ model: 'fast' }), raw({ label: 'b', model: 'main' })], 5);
    expect(out.specs).toHaveLength(2);
    // The spec shape carries NO tier field at all: a delegation is never a
    // model choice, so the type itself must not offer one.
    expect(out.specs.every((s) => !('tier' in s))).toBe(true);
    expect('downgraded' in out).toBe(false);
  });

  it('still caps to the ceiling and reports `requested` honestly', () => {
    const specs = Array.from({ length: 5 }, (_, i) => raw({ label: `a${i}` }));
    const out = normalizeSubagentSpecs(specs, 2);
    expect(out.specs).toHaveLength(2);
    expect(out.requested).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 2/3. The runtime: one model, one total, one price
// ---------------------------------------------------------------------------

function config(over: Partial<CliConfig> = {}): CliConfig {
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
    // All-zero ceilings: the parity default. No wall clock, no turn cap.
    team: { ...DEFAULT_TEAM_CONFIG, maxConcurrent: 2 },
    todo: DEFAULT_TODO_CONFIG,
    bash: DEFAULT_BASH_CONFIG,
    retry: DEFAULT_RETRY_CONFIG,
    compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false },
    // The tier is LIVE and resolvable: the parity assertions below therefore
    // prove there is no code path left that could route a child onto it.
    fast: { ...DEFAULT_FAST_CONFIG, enabled: true, model: 'claude-haiku-4-5' },
    update: DEFAULT_UPDATE_CONFIG,
    submitCount: 0,
    cwd: process.cwd(),
    color: true,
    keyboardEnhancement: false,
    ...over,
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
      steer() {},
      clearAllQueues() {},
      subscribe(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      pauseIdleWatchdog() {},
      resumeIdleWatchdog() {},
      state: { messages: [] },
    };
  };
}

describe('TeamRuntime - every child runs the lead`s model', () => {
  it('builds children with the LEAD ModelRef even while a fast tier is live', async () => {
    const captured: AgentConfig[] = [];
    const runtime = new TeamRuntime({
      getConfig: config,
      providerRegistry: {} as ProviderRegistry,
      getCwd: () => process.cwd(),
      getMode: () => 'build',
      getApiKey: () => 'k',
      agentFactory: stubAgent(captured),
    });

    // One spec carries a stale `model:"fast"` key on purpose: whatever the
    // prompt says, the child that runs is the lead's own model.
    const { specs } = normalizeSubagentSpecs([raw({ model: 'fast' }), raw({ label: 'careful' })], 5);
    const outcome = await runtime.dispatch(specs, 2);

    expect(captured).toHaveLength(2);
    for (const built of captured) {
      expect(built.model.modelId).toBe('claude-sonnet-4-5-20250929');
      expect(built.model.providerId).toBe('anthropic');
      expect(built.thinkingLevel).toBe('high');
    }
    // ONE TOTAL at the lead's price: both children's spend folds into `usage`.
    expect(outcome.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
    expect('fastUsage' in outcome).toBe(false);
    expect('downgraded' in outcome).toBe(false);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 3. The report: one tier, one table, no stale annotations
// ---------------------------------------------------------------------------

function run(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'a1',
    description: 'read the auth middleware',
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
    runs: [run(), run({ label: 'a2' })],
    requested: 2,
    startedAt: 1000,
    endedAt: 3000,
    aborted: false,
    leadMail: [],
    usage: { inputTokens: 200, outputTokens: 40 },
    ...over,
  };
}

describe('buildDispatchReport - one tier, one table', () => {
  it('prices the whole dispatch at the lead`s table and carries no fast sections', () => {
    const text = buildDispatchReport(outcome(), { cost: { input: 3, output: 15 } });
    expect(text).toMatch(/Tokens: in 200, out 40\. Cost: /);
    expect(text).not.toContain('Fast tier:');
    expect(text).not.toContain('[fast]');
    expect(text).not.toContain('main model (fast tier off)');
    expect(text).not.toContain('unknown (no price table)');
  });
});

// ---------------------------------------------------------------------------
// 4. The no-limit regime (0 = no ceiling, and it sticks)
// ---------------------------------------------------------------------------

describe('team limits - 0 means no ceiling', () => {
  it('the defaults are the parity regime: no wall clock, no turn cap', () => {
    expect(DEFAULT_TEAM_CONFIG.subagentTimeoutMs).toBe(0);
    expect(DEFAULT_TEAM_CONFIG.dispatchTimeoutMs).toBe(0);
    expect(DEFAULT_TEAM_CONFIG.maxTurnsPerSubagent).toBe(0);
  });

  it('an EXPLICIT 0 survives the clamp (the `scrollResumeMs` trap)', () => {
    // `coercePositiveInt` folds 0 to the fallback - "my setting won't stick".
    // These three keys must use the allow-zero clamp or a user could never
    // turn a ceiling back off after setting one.
    const zeroed = clampTeamConfig({
      ...DEFAULT_TEAM_CONFIG,
      subagentTimeoutMs: 0,
      dispatchTimeoutMs: 0,
      maxTurnsPerSubagent: 0,
    });
    expect(zeroed.subagentTimeoutMs).toBe(0);
    expect(zeroed.dispatchTimeoutMs).toBe(0);
    expect(zeroed.maxTurnsPerSubagent).toBe(0);
  });

  it('a small positive value is kept, not folded to the old floor', () => {
    // The old floors (30 s / 60 s / 4 turns) are gone with the old defaults;
    // anything positive inside the range is the user's own ceiling now.
    const low = clampTeamConfig({
      ...DEFAULT_TEAM_CONFIG,
      subagentTimeoutMs: 5_000,
      dispatchTimeoutMs: 10_000,
      maxTurnsPerSubagent: 2,
    });
    expect(low.subagentTimeoutMs).toBe(5_000);
    expect(low.dispatchTimeoutMs).toBe(10_000);
    expect(low.maxTurnsPerSubagent).toBe(2);
  });

  it('the upper bounds still clamp', () => {
    const high = clampTeamConfig({
      ...DEFAULT_TEAM_CONFIG,
      subagentTimeoutMs: 99_000_000,
      dispatchTimeoutMs: 99_000_000,
      maxTurnsPerSubagent: 9999,
    });
    expect(high.subagentTimeoutMs).toBe(1_800_000);
    expect(high.dispatchTimeoutMs).toBe(3_600_000);
    expect(high.maxTurnsPerSubagent).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 5. The per-child reviewer factory
// ---------------------------------------------------------------------------

/** Everything `createChildReviewer` needs about its child, stubbed. */
function childStub() {
  const listeners = new Set<(e: AgentEvent) => void>();
  const steered: string[] = [];
  const agent = {
    subscribe(l: (e: AgentEvent) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    steer(text: string) {
      steered.push(text);
    },
    clearAllQueues() {},
  };
  const emit = (event: AgentEvent): void => {
    for (const l of [...listeners]) l(event);
  };
  return { agent, steered, emit };
}

function reviewerDeps(over: Partial<Parameters<typeof createChildReviewer>[1]> = {}) {
  return {
    getConfig: config,
    hasKey: () => true,
    getApiKey: () => 'k',
    complete: async () => ({ role: 'assistant', content: [] }) as AssistantMessage,
    available: () => true,
    ...over,
  };
}

/** A config whose review cadence fires on every completed turn. */
const everyTurnFast = {
  ...DEFAULT_FAST_CONFIG,
  enabled: true,
  model: 'claude-haiku-4-5',
  review: true,
  reviewEveryTurns: 1,
};

/** One complete child turn: a tool call, then the result that empties the batch. */
function driveTurn(emit: (e: AgentEvent) => void, n: number): void {
  emit({ type: 'turn_start' });
  emit({ type: 'turn_end', message: { role: 'assistant', content: [{
    type: 'tool_call', toolCallId: `c${n}`, toolName: 'read_file', args: {},
  }] }, usage: { inputTokens: 10, outputTokens: 2 } });
  emit({ type: 'tool_execution_end', toolCallId: `c${n}`, toolName: 'read_file',
    result: { content: [] }, isError: false, duration: 5 });
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createChildReviewer - same gates as the lead`s reviewer', () => {
  it('declines (undefined) when the wiring is not live', () => {
    const { agent } = childStub();
    const handle = createChildReviewer(
      { label: 'a1', goal: 'read the auth middleware', agent, isRunning: () => true, isAbortRequested: () => false },
      reviewerDeps({ available: () => false }),
    );
    expect(handle).toBeUndefined();
  });

  it('declines when `fast.review` is off, even with a live tier', () => {
    const { agent } = childStub();
    const handle = createChildReviewer(
      { label: 'a1', goal: 'g', agent, isRunning: () => true, isAbortRequested: () => false },
      reviewerDeps({ getConfig: () => config({ fast: { ...everyTurnFast, review: false } }) }),
    );
    expect(handle).toBeUndefined();
  });

  it('attaches a reviewer when the tier is live and review is on', () => {
    const { agent } = childStub();
    const handle = createChildReviewer(
      { label: 'a1', goal: 'g', agent, isRunning: () => true, isAbortRequested: () => false },
      reviewerDeps(),
    );
    expect(handle).toBeDefined();
    // Idempotent dispose: `TeamRuntime.unsubscribe` may call it from two paths.
    expect(() => {
      handle!.dispose();
      handle!.dispose();
    }).not.toThrow();
  });

  it('runs the review on the FAST model and steers the critique into the child', async () => {
    const requests: LLMRequest[] = [];
    const { agent, steered, emit } = childStub();
    const handle = createChildReviewer(
      { label: 'a1', goal: 'check the auth middleware', agent, isRunning: () => true, isAbortRequested: () => false },
      reviewerDeps({
        getConfig: () => config({ fast: everyTurnFast }),
        complete: async (_providerId, request) => {
          requests.push(request);
          const first = requests.length === 1;
          return {
            role: 'assistant',
            content: [{
              type: 'text',
              text: first
                ? 'The middleware import in src/auth is failing.'
                : 'OK - on track.',
            }],
          } as AssistantMessage;
        },
      }),
    );

    // Turn 1 completes; its sealed frame starts one review through the shared
    // transport - on the FAST model, while the child itself runs the lead's.
    emit({ type: 'agent_start' });
    driveTurn(emit, 1);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.model).toBe('claude-haiku-4-5');
    // One macrotask, so the completion callback parks its critique BEFORE the
    // next injection window opens (the callback runs one microtask later than
    // the transport stub is entered).
    await settle();

    // The critique parks; the NEXT batch-empty window injects it. Later
    // reviews answer on-track so exactly one injection ever happens.
    driveTurn(emit, 2);
    await vi.waitFor(() => expect(steered).toHaveLength(1));
    expect(steered[0]).toContain('<fast_review turn="1" model="claude-haiku-4-5">');
    expect(steered[0]).toContain('The middleware import in src/auth is failing.');

    handle?.dispose();
  });

  it('drops a critique that arrives while the child is not running - never steers', async () => {
    const { agent, steered, emit } = childStub();
    const handle = createChildReviewer(
      { label: 'a1', goal: 'g', agent, isRunning: () => false, isAbortRequested: () => false },
      reviewerDeps({
        getConfig: () => config({ fast: everyTurnFast }),
        complete: async () => ({
          role: 'assistant',
          content: [{ type: 'text', text: 'Something is wrong upstream.' }],
        }) as AssistantMessage,
      }),
    );

    emit({ type: 'agent_start' });
    driveTurn(emit, 1);
    // The call itself starts (the lead's reviewer behaves the same); the
    // guard is at landing: a run that is not running gets nothing steered.
    driveTurn(emit, 2);
    await settle();
    await settle();
    expect(steered).toHaveLength(0);

    handle?.dispose();
  });
});
