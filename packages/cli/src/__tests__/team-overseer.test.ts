import { describe, expect, it } from 'vitest';
import type { AgentEvent, Message, ProviderRegistry } from '@aragon-agent/core';
import { TeamRuntime } from '../team/runtime.js';
import {
  buildChildDigest,
  buildReplacementPrompt,
  clampNextCheckMs,
  createFastOverseerProvider,
  normalizeOverseerDecision,
  parseOverseerDecisionText,
  TeamOverseer,
  type OverseerProvider,
} from '../team/overseer.js';
import type { SubagentAgentLike } from '../team/subagent.js';
import type { OverseerDecision, SubagentSpec, TeamEvent } from '../team/types.js';
import { TEAM_LIMITS } from '../team/limits.js';
import {
  DEFAULT_BASH_CONFIG,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_FAST_CONFIG,
  DEFAULT_LOG_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_SKILLS_RUNTIME,
  DEFAULT_TEAM_CONFIG,
  DEFAULT_TODO_CONFIG,
  DEFAULT_UPDATE_CONFIG,
  type CliConfig,
  type TeamConfig,
} from '../config/schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function config(team: Partial<TeamConfig> = {}, idleTimeoutMs = 210_000): CliConfig {
  return {
    fast: DEFAULT_FAST_CONFIG,
    update: DEFAULT_UPDATE_CONFIG,
    provider: 'anthropic',
    model: 'm',
    thinkingLevel: 'off',
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
    idleTimeoutMs,
    apiKeys: { anthropic: 'k' },
    historyEnabled: true,
    density: 'comfortable',
    hints: true,
    mouse: true,
    mouseSelect: true,
    paste: true,
    scrollResumeMs: 5000,
    submitCount: 0,
    startInPlanMode: false,
    planModeMaxAskRounds: 4,
    planModeHumanTimeoutMs: 1_800_000,
    skills: DEFAULT_SKILLS_CONFIG,
    skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    log: DEFAULT_LOG_CONFIG,
    team: { ...DEFAULT_TEAM_CONFIG, ...team },
    todo: DEFAULT_TODO_CONFIG,
    bash: DEFAULT_BASH_CONFIG,
    retry: DEFAULT_RETRY_CONFIG,
    compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false },
    cwd: process.cwd(),
    color: true,
    keyboardEnhancement: false,
  };
}

/** How one stubbed child behaves. Everything is scripted; nothing touches a network. */
interface Script {
  /** Wall time before the child finishes. Cut short by `abort()`. */
  ms?: number;
  /** `turn_end` events emitted before finishing. */
  turns?: number;
  /** The final assistant text; omit for "produced no output". */
  summary?: string;
  /** Throw out of `prompt()` (a real `Agent` resolves instead). */
  throws?: string;
  /** Never settles on its own; only an `abort()` ends it. */
  hang?: boolean;
  /** Emit a `team_wait` tool pair for this many ms before the settle. */
  waitToolMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class StubAgent implements SubagentAgentLike {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  readonly state: { messages: Message[] } = { messages: [] };
  private wake: (() => void) | null = null;
  aborted = false;
  steered: string[] = [];
  promptText = '';

  constructor(private readonly script: Script) {}

  subscribe(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent): void {
    for (const l of [...this.listeners]) l(event);
  }

  pauseIdleWatchdog(): void {}
  resumeIdleWatchdog(): void {}
  steer(text: string): void {
    this.steered.push(text);
  }
  clearAllQueues(): void {}

  abort(): void {
    this.aborted = true;
    this.wake?.();
  }

  async prompt(text = ''): Promise<void> {
    this.promptText = text;
    if (this.script.throws) throw new Error(this.script.throws);
    this.emit({ type: 'turn_start' });
    if (this.script.waitToolMs !== undefined) {
      this.emit({
        type: 'tool_execution_start',
        toolCallId: 'w1',
        toolName: 'team_wait',
        args: {},
      });
      await this.settle(this.script.waitToolMs);
      if (!this.aborted) {
        this.emit({
          type: 'tool_execution_end',
          toolCallId: 'w1',
          toolName: 'team_wait',
          result: { content: [] },
          isError: false,
          duration: this.script.waitToolMs,
        });
      }
    }
    for (let i = 0; i < (this.script.turns ?? 1); i += 1) {
      if (this.aborted) break;
      this.emit({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: this.script.summary ? [{ type: 'text', text: this.script.summary }] : [],
        },
        usage: { inputTokens: 100, outputTokens: 20 },
      });
    }
    if (!this.aborted) await this.settle(this.script.hang ? 60_000 : this.script.ms ?? 5);
    this.emit({ type: 'agent_end', messages: [] });
  }

  private settle(ms: number): Promise<void> {
    if (this.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.wake = done;
    });
  }
}

/**
 * A scripted supervisor provider: returns `plan`'s entries in order, then the
 * last forever. Both inspection shapes route through the same plan; the batch
 * answer is a raw ARRAY (the shape `TeamOverseer.inspectBatch` normalizes).
 */
function stubProvider(plan: OverseerDecision[]): {
  provider: OverseerProvider;
  digests: string[];
  batches: string[][];
} {
  const digests: string[] = [];
  const batches: string[][] = [];
  let index = 0;
  const next = (): OverseerDecision => {
    const decision =
      plan[Math.min(index, plan.length - 1)] ?? { action: 'wait', reason: 'plan exhausted' };
    index += 1;
    return decision;
  };
  return {
    provider: {
      active: () => true,
      inspect: async (req) => {
        digests.push(req.digest);
        return next();
      },
      inspectBatch: async (req) => {
        batches.push(req.map((r) => r.label));
        for (const r of req) digests.push(r.digest);
        return req.map((r) => ({ label: r.label, ...next() }));
      },
      usage: () => ({ inputTokens: 0, outputTokens: 0 }),
    },
    digests,
    batches,
  };
}

interface Harness {
  runtime: TeamRuntime;
  specs: SubagentSpec[];
  agents: StubAgent[];
  events: TeamEvent[];
  digests: string[];
  /** Labels carried by each batch (cadence) call, in call order. */
  batches: string[][];
}

/** One supervised dispatch, fully scripted. `idleTimeoutMs` IS the silence window. */
function harness(
  scripts: Script[],
  decisions: OverseerDecision[],
  opts: {
    team?: Partial<TeamConfig>;
    idleTimeoutMs?: number;
    provider?: OverseerProvider;
    supervise?: boolean;
    /** Children in the batch. Defaults to `scripts.length`; replacement-body
     *  scripts sit BEYOND it (the factory indexes by agents built, not specs). */
    count?: number;
  } = {},
): Harness {
  const agents: StubAgent[] = [];
  const events: TeamEvent[] = [];
  const stub = stubProvider(decisions);
  const provider = opts.provider ?? stub.provider;
  const supervise = opts.supervise ?? true;
  const runtime = new TeamRuntime({
    getConfig: () =>
      config({ ...opts.team, ...(supervise ? {} : { overseer: false }) }, opts.idleTimeoutMs ?? 210_000),
    providerRegistry: {} as ProviderRegistry,
    getCwd: () => process.cwd(),
    getMode: () => 'build',
    getApiKey: () => 'k',
    agentFactory: () => {
      const agent = new StubAgent(scripts[agents.length] ?? {});
      agents.push(agent);
      return agent;
    },
    ...(supervise ? { overseer: provider } : {}),
  });
  runtime.subscribe((event) => events.push(event));
  const count = opts.count ?? scripts.length;
  const specs: SubagentSpec[] = Array.from({ length: count }, (_, i) => ({
    label: `a${i + 1}`,
    description: `job ${i + 1}`,
    prompt: `do ${i + 1}`,
    readOnly: false,
  }));
  return { runtime, specs, agents, events, digests: stub.digests, batches: stub.batches };
}

// ---------------------------------------------------------------------------
// Pure protocol functions
// ---------------------------------------------------------------------------

describe('normalizeOverseerDecision', () => {
  it('repairs an unparseable answer into wait, never rejects (I-OV2)', () => {
    const decision = normalizeOverseerDecision({ action: 'explode', reason: '' }, true);
    expect(decision.action).toBe('wait');
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('normalizes wait/nudge to abandon for a dead child (post-mortem mode)', () => {
    const wait = normalizeOverseerDecision({ action: 'wait', reason: 'looks fine' }, false);
    expect(wait.action).toBe('abandon');
    expect(wait.reason).toContain('looks fine');
    const nudge = normalizeOverseerDecision({ action: 'nudge', reason: 'try again' }, false);
    expect(nudge.action).toBe('abandon');
  });

  it('clamps reason, guidance and nextCheckMs to the structural bounds', () => {
    const decision = normalizeOverseerDecision(
      {
        action: 'nudge',
        reason: 'r'.repeat(500),
        guidance: 'g'.repeat(2000),
        nextCheckMs: 5,
      },
      true,
    );
    expect(decision.reason.length).toBe(TEAM_LIMITS.overseerReasonChars);
    expect(decision.guidance?.length).toBe(TEAM_LIMITS.overseerGuidanceChars);
    // nextCheckMs only rides a wait; a nudge drops it.
    expect(decision.nextCheckMs).toBeUndefined();
  });

  it('clamps the model-chosen next check into the structural range', () => {
    expect(clampNextCheckMs(100)).toBe(TEAM_LIMITS.overseerNextCheckMinMs);
    expect(clampNextCheckMs(10_000_000)).toBe(TEAM_LIMITS.overseerNextCheckMaxMs);
    expect(clampNextCheckMs(120_000)).toBe(120_000);
    expect(clampNextCheckMs(-1)).toBeUndefined();
  });
});

describe('parseOverseerDecisionText', () => {
  it('parses JSON wrapped in prose and fences', () => {
    const text = 'Sure!\n```json\n{"action":"nudge","reason":"looping","guidance":"skip tests"}\n```';
    const decision = parseOverseerDecisionText(text, true);
    expect(decision.action).toBe('nudge');
    expect(decision.guidance).toBe('skip tests');
  });

  it('falls back to wait on garbage', () => {
    const decision = parseOverseerDecisionText('I cannot answer that.', true);
    expect(decision.action).toBe('wait');
  });
});

describe('buildChildDigest', () => {
  const baseRun = {
    label: 'a1',
    description: 'check api',
    phase: 'tool' as const,
    turns: 3,
    toolCalls: 7,
    lastTool: 'bash',
    usage: { inputTokens: 0, outputTokens: 0 },
    filesTouched: ['src/a.ts'],
    messagesSent: 0,
    startedAt: Date.now() - 60_000,
  };

  it('carries the facts the decision needs', () => {
    const digest = buildChildDigest({
      run: baseRun,
      childAlive: true,
      trigger: 'silence',
      messages: [],
      memory: [{ atSec: 30, action: 'wait', reason: 'normal' }],
      elapsedSec: 90,
    });
    expect(digest).toContain('a1');
    expect(digest).toContain('trigger: event silence');
    expect(digest).toContain('phase: tool');
    expect(digest).toContain('lastTool');
    expect(digest).toContain('files: src/a.ts');
    expect(digest).toContain('[30s] wait: normal');
  });

  it('is byte-bounded no matter how large the history tail is', () => {
    const messages: Message[] = Array.from({ length: 40 }, (_, i) => ({
      role: 'user' as const,
      content: 'x'.repeat(1000),
      timestamp: i,
    }));
    const digest = buildChildDigest({
      run: baseRun,
      childAlive: true,
      trigger: 'clock',
      messages,
      memory: [],
      elapsedSec: 1,
    });
    expect(Buffer.byteLength(digest, 'utf8')).toBeLessThanOrEqual(TEAM_LIMITS.overseerDigestBytes);
  });
});

describe('buildReplacementPrompt', () => {
  it('prepends the supervisor note, the dead attempt facts and the guidance', () => {
    const spec: SubagentSpec = {
      label: 'a1',
      description: 'job',
      prompt: 'do the thing',
      readOnly: false,
    };
    const prompt = buildReplacementPrompt(
      spec,
      { action: 'replace', reason: 'stuck in a loop', guidance: 'avoid the flaky suite' },
      {
        ...spec,
        phase: 'tool',
        turns: 5,
        toolCalls: 9,
        usage: { inputTokens: 0, outputTokens: 0 },
        filesTouched: ['src/a.ts'],
        messagesSent: 0,
      },
    );
    expect(prompt).toContain('[supervisor note]');
    expect(prompt).toContain('stuck in a loop');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('avoid the flaky suite');
    expect(prompt.endsWith('do the thing')).toBe(true);
  });

  it('bounds the amended brief to the structural prompt clamp', () => {
    const spec: SubagentSpec = {
      label: 'a1',
      description: 'job',
      prompt: 'y'.repeat(TEAM_LIMITS.promptChars + 500),
      readOnly: false,
    };
    const prompt = buildReplacementPrompt(
      spec,
      { action: 'replace', reason: 'r' },
      { ...spec, phase: 'tool', turns: 1, toolCalls: 1, usage: { inputTokens: 0, outputTokens: 0 }, filesTouched: [], messagesSent: 0 },
    );
    expect(prompt.length).toBeLessThanOrEqual(TEAM_LIMITS.promptChars + 10);
  });
});

// ---------------------------------------------------------------------------
// TeamOverseer state
// ---------------------------------------------------------------------------

describe('TeamOverseer budgets', () => {
  const run = {
    label: 'a1',
    description: 'd',
    phase: 'thinking' as const,
    turns: 0,
    toolCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    filesTouched: [],
    messagesSent: 0,
  };

  it('stops inspecting after the structural budget, then goes quiet', async () => {
    const calls: string[] = [];
    const overseer = new TeamOverseer(
      {
        active: () => true,
        inspect: async () => {
          calls.push('single');
          return { action: 'wait', reason: 'fine' };
        },
        inspectBatch: async (req) => {
          calls.push(`batch:${req.length}`);
          return [];
        },
        usage: () => ({ inputTokens: 0, outputTokens: 0 }),
      },
      { startedAt: Date.now() },
    );
    for (let i = 0; i < TEAM_LIMITS.overseerMaxLooksPerChild + 3; i += 1) {
      await overseer.inspect({ run: { ...run }, messages: [], trigger: 'clock', childAlive: true });
    }
    expect(calls).toHaveLength(TEAM_LIMITS.overseerMaxLooksPerChild);
    expect(overseer.looksExhausted(run.label)).toBe(true);
  });

  it('a throwing provider resolves to wait, never throws (I-OV2)', async () => {
    const overseer = new TeamOverseer(
      {
        active: () => true,
        inspect: async () => {
          throw new Error('provider exploded');
        },
        inspectBatch: async () => {
          throw new Error('provider exploded');
        },
        usage: () => ({ inputTokens: 0, outputTokens: 0 }),
      },
      { startedAt: Date.now() },
    );
    const decision = await overseer.inspect({
      run: { ...run },
      messages: [],
      trigger: 'silence',
      childAlive: true,
    });
    expect(decision?.action).toBe('wait');
    // The same fail-soft contract on the batch path: every carried child
    // gets wait, and nobody is killed by a transport failure (G-6).
    const batch = await overseer.inspectBatch([
      { run: { ...run, label: 'a1' }, messages: [], trigger: 'clock', childAlive: true },
      { run: { ...run, label: 'a2' }, messages: [], trigger: 'clock', childAlive: true },
    ]);
    expect([...batch.keys()].sort()).toEqual(['a1', 'a2']);
    for (const decision of batch.values()) expect(decision.action).toBe('wait');
  });
});

// ---------------------------------------------------------------------------
// The supervised dispatch (integration through TeamRuntime, stub agents only)
// ---------------------------------------------------------------------------

describe('supervised dispatch', () => {
  it('silence triggers exactly one inspection; a wait decision lets the child finish', async () => {
    const h = harness(
      [{ ms: 45, summary: 'slow but fine' }],
      [{ action: 'wait', reason: 'working', nextCheckMs: 60_000 }],
      { idleTimeoutMs: 30 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);

    expect(h.digests).toHaveLength(1);
    expect(h.digests[0]).toContain('trigger: event silence');
    expect(outcome.runs[0]!.phase).toBe('done');
    expect(outcome.runs[0]!.summary).toBe('slow but fine');
    expect(outcome.runs[0]!.interventions).toBe(1);
    const overseerEvents = h.events.filter((e) => e.type === 'overseer');
    expect(overseerEvents).toHaveLength(1);
    expect(outcome.interventions).toHaveLength(1);
    expect(outcome.interventions![0]!.action).toBe('wait');
  });

  it('a wall-clock check fires at subagentTimeoutMs and no longer hard-aborts', async () => {
    const h = harness(
      [{ ms: 150, summary: 'deliberate' }],
      [{ action: 'wait', reason: 'healthy' }],
      { team: { subagentTimeoutMs: 40 }, idleTimeoutMs: 500 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);

    // The check fired, the child was NOT killed, and it finished on its own.
    expect(h.digests).toHaveLength(1);
    expect(h.digests[0]).toContain('trigger: wall-clock check');
    // subagent-overseer-v2 D-8: the compat-derived first check is a CADENCE
    // TICK, i.e. one BATCH call, not a single-child inspection.
    expect(h.batches).toEqual([['a1']]);
    expect(outcome.runs[0]!.phase).toBe('done');
  });

  it('a nudge steers the guidance into the live child (I-OV4 path)', async () => {
    const h = harness(
      [{ ms: 45, summary: 'recovered' }],
      [{ action: 'nudge', reason: 'circling', guidance: 'skip the flaky suite' }],
      { idleTimeoutMs: 30 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);

    expect(h.agents[0]!.steered).toEqual(['skip the flaky suite']);
    expect(outcome.runs[0]!.phase).toBe('done');
    expect(outcome.interventions![0]!.action).toBe('nudge');
  });

  it('a replace verdict rebuilds through the worker loop with an amended brief (I-OV1)', async () => {
    const h = harness(
      [{ hang: true }, { ms: 5, summary: 'fresh body finished' }],
      [{ action: 'replace', reason: 'wedged on a dead endpoint', guidance: 'use the mock' }],
      { idleTimeoutMs: 30, count: 1 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);

    // A SECOND body existed, was driven, and finished.
    expect(h.agents).toHaveLength(2);
    expect(outcome.runs[0]!.phase).toBe('done');
    expect(outcome.runs[0]!.summary).toBe('fresh body finished');
    expect(outcome.runs[0]!.replacements).toBe(1);
    // The fresh brief carries the supervisor note and the original task.
    expect(h.agents[1]!.promptText).toContain('[supervisor note]');
    expect(h.agents[1]!.promptText).toContain('wedged on a dead endpoint');
    expect(h.agents[1]!.promptText).toContain('do 1');
    expect(outcome.interventions![0]!.action).toBe('replace');
  });

  it('an abandon verdict settles the run failed with the supervisor reason', async () => {
    const h = harness(
      [{ hang: true }],
      [{ action: 'abandon', reason: 'task is not worth more attempts' }],
      { idleTimeoutMs: 30 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);

    expect(outcome.runs[0]!.phase).toBe('failed');
    expect(outcome.runs[0]!.error).toContain('overseer abandoned');
    expect(outcome.runs[0]!.error).toContain('not worth more attempts');
  });

  it('the look budget stops the supervisor after the structural cap, quietly (D-5)', async () => {
    const h = harness(
      [{ ms: 500, summary: 'very slow but healthy' }],
      [{ action: 'wait', reason: 'fine' }],
      { idleTimeoutMs: 30 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);

    // Twelve looks through the silence path, then QUIET - one intervention
    // with trigger 'quiet' and nothing more (G-1 closed: the supervisor says
    // it is going quiet instead of silently disappearing).
    expect(h.digests).toHaveLength(TEAM_LIMITS.overseerMaxLooksPerChild);
    expect(outcome.runs[0]!.phase).toBe('done');
    expect(outcome.runs[0]!.interventions).toBe(TEAM_LIMITS.overseerMaxLooksPerChild + 1);
    const quiet = outcome.interventions!.filter((i) => i.trigger === 'quiet');
    expect(quiet).toHaveLength(1);
    expect(quiet[0]!.label).toBe('a1');
    expect(quiet[0]!.action).toBe('wait');
  });

  it('a child blocked in team_wait does not burn inspections (I-OV3)', async () => {
    const h = harness(
      [{ waitToolMs: 90, ms: 5, summary: 'waited then finished' }],
      [{ action: 'wait', reason: 'should never be consulted' }],
      { idleTimeoutMs: 30 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);

    expect(h.digests).toHaveLength(0);
    expect(outcome.runs[0]!.phase).toBe('done');
  });

  it('a silent death gets ONE post-mortem look and may be replaced', async () => {
    const h = harness(
      [{ ms: 40 /* no summary: silent death */ }, { ms: 5, summary: 'post-mortem rescue' }],
      [{ action: 'replace', reason: 'watchdog death; retry once' }],
      { idleTimeoutMs: 500 /* no live inspection: the post-mortem is the only look */, count: 1 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);

    expect(h.digests).toHaveLength(1);
    expect(h.digests[0]).toContain('post-mortem');
    expect(h.agents).toHaveLength(2);
    expect(outcome.runs[0]!.phase).toBe('done');
    expect(outcome.runs[0]!.summary).toBe('post-mortem rescue');
    expect(outcome.runs[0]!.replacements).toBe(1);
  });

  it('team.overseer=false disables supervision entirely (config gate)', async () => {
    const h = harness([{ hang: true }], [{ action: 'wait', reason: 'unused' }], {
      team: { overseer: false, subagentTimeoutMs: 60 },
      idleTimeoutMs: 30,
      supervise: false,
    });
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);

    // No inspection, and the LEGACY hard timeout applies again.
    expect(h.digests).toHaveLength(0);
    expect(outcome.runs[0]!.phase).toBe('failed');
    expect(outcome.runs[0]!.error).toMatch(/subagent exceeded/);
    expect(outcome.interventions ?? []).toHaveLength(0);
  });

  it('a second replace past the budget downgrades to abandon with the budget stated', async () => {
    const h = harness(
      [{ hang: true }, { hang: true }],
      [
        { action: 'replace', reason: 'first wedge' },
        { action: 'replace', reason: 'second wedge' },
      ],
      { idleTimeoutMs: 30, count: 1 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);

    expect(h.agents).toHaveLength(2);
    expect(outcome.runs[0]!.phase).toBe('failed');
    expect(outcome.runs[0]!.error).toContain('replacement budget exhausted');
    expect(outcome.runs[0]!.error).toContain('second wedge');
    expect(outcome.runs[0]!.replacements).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The fast-tier provider (fail-soft, no network)
// ---------------------------------------------------------------------------

describe('createFastOverseerProvider', () => {
  it('resolves to wait when the fast tier is unavailable (I-OV2)', async () => {
    const provider = createFastOverseerProvider({
      getConfig: () => config(),
      hasKey: () => false,
      getApiKey: () => undefined,
      complete: async () => {
        throw new Error('must not be called');
      },
      available: () => false,
    });
    expect(provider.active()).toBe(false);
    const decision = await provider.inspect({ label: 'a1', goal: 'g', digest: 'd' });
    expect(decision.action).toBe('wait');
  });

  it('resolves to wait when the call throws or times out', async () => {
    const provider = createFastOverseerProvider({
      getConfig: () => ({
        ...config(),
        fast: { ...DEFAULT_FAST_CONFIG, enabled: true, model: 'fast-model' },
      }),
      hasKey: () => true,
      getApiKey: () => 'k',
      complete: async () => {
        throw new Error('boom');
      },
      available: () => true,
    });
    expect(provider.active()).toBe(true);
    const decision = await provider.inspect({ label: 'a1', goal: 'g', digest: 'd' });
    expect(decision.action).toBe('wait');
    expect(decision.reason).toContain('failed');
  });
});
