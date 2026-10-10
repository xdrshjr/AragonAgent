import { describe, expect, it } from 'vitest';
import type { AgentEvent, Message, ProviderRegistry } from '@aragon-agent/core';
import { TeamRuntime } from '../team/runtime.js';
import type { OverseerProvider } from '../team/overseer.js';
import type { SubagentAgentLike } from '../team/subagent.js';
import type { OverseerDecision, SubagentSpec, TeamEvent } from '../team/types.js';
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

/**
 * The SUPERVISED DISPATCH under subagent-overseer-v2 §7.1-4: the no-kill
 * gate (R-P0-2 / G-2), the cadence tick's one batch call, degradation when
 * the fast tier disappears, the queued-child exclusion (R-P1-5) and the
 * single-flight skip (R-P1-4). Everything is scripted; nothing touches a
 * network.
 */

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

interface Script {
  ms?: number;
  turns?: number;
  summary?: string;
  throws?: string;
  hang?: boolean;
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

interface ProviderScript {
  /** Whether the fast tier answers right now - read per call (R-P0-2). */
  active?: () => boolean;
  /** The batch answer for one cadence tick, by label. */
  batch?: (labels: string[]) => Array<Record<string, unknown>>;
  /** The single-inspection answer (silence path). */
  single?: () => OverseerDecision;
  /** Artificially delay the batch call, to hold it in flight. */
  batchDelayMs?: number;
  /** Artificially delay the single call, to hold it in flight. */
  singleDelayMs?: number;
}

function scriptedProvider(script: ProviderScript): {
  provider: OverseerProvider;
  batches: string[][];
  digests: string[];
  /** High-water mark of concurrent inspections of ONE label (R-P1-4). */
  maxConcurrentPerLabel: () => number;
} {
  const batches: string[][] = [];
  const digests: string[] = [];
  const inFlight = new Map<string, number>();
  let highWater = 0;
  const enter = (label: string): void => {
    const n = (inFlight.get(label) ?? 0) + 1;
    inFlight.set(label, n);
    highWater = Math.max(highWater, n);
  };
  const exit = (label: string): void => {
    inFlight.set(label, (inFlight.get(label) ?? 1) - 1);
  };
  return {
    batches,
    digests,
    maxConcurrentPerLabel: () => highWater,
    provider: {
      active: () => script.active?.() ?? true,
      inspect: async (req) => {
        enter(req.label);
        try {
          digests.push(req.digest);
          if (script.singleDelayMs) await sleep(script.singleDelayMs);
          return script.single?.() ?? { action: 'wait', reason: 'single default' };
        } finally {
          exit(req.label);
        }
      },
      inspectBatch: async (req) => {
        for (const r of req) enter(r.label);
        try {
          batches.push(req.map((r) => r.label));
          for (const r of req) digests.push(r.digest);
          if (script.batchDelayMs) await sleep(script.batchDelayMs);
          return script.batch?.(req.map((r) => r.label)) ?? [];
        } finally {
          for (const r of req) exit(r.label);
        }
      },
      usage: () => ({ inputTokens: 3, outputTokens: 4 }),
    },
  };
}

interface Harness {
  runtime: TeamRuntime;
  specs: SubagentSpec[];
  agents: StubAgent[];
  events: TeamEvent[];
  batches: string[][];
  digests: string[];
  maxConcurrentPerLabel: () => number;
}

function harness(
  scripts: Script[],
  script: ProviderScript,
  opts: { team?: Partial<TeamConfig>; idleTimeoutMs?: number; count?: number } = {},
): Harness {
  const agents: StubAgent[] = [];
  const events: TeamEvent[] = [];
  const stub = scriptedProvider(script);
  const runtime = new TeamRuntime({
    getConfig: () => config(opts.team, opts.idleTimeoutMs ?? 210_000),
    providerRegistry: {} as ProviderRegistry,
    getCwd: () => process.cwd(),
    getMode: () => 'build',
    getApiKey: () => 'k',
    agentFactory: () => {
      const agent = new StubAgent(scripts[agents.length] ?? {});
      agents.push(agent);
      return agent;
    },
    overseer: stub.provider,
  });
  runtime.subscribe((event) => events.push(event));
  const count = opts.count ?? scripts.length;
  const specs: SubagentSpec[] = Array.from({ length: count }, (_, i) => ({
    label: `a${i + 1}`,
    description: `job ${i + 1}`,
    prompt: `do ${i + 1}`,
    readOnly: false,
  }));
  return {
    runtime,
    specs,
    agents,
    events,
    batches: stub.batches,
    digests: stub.digests,
    maxConcurrentPerLabel: stub.maxConcurrentPerLabel,
  };
}

describe('4a: no-kill with the fast tier missing from the START (G-2 / R-P0-2)', () => {
  it('arms the cadence loop, waits unassisted, never aborts, latches degraded', async () => {
    const h = harness(
      [{ ms: 120, summary: 'slow but unmolested' }],
      { active: () => false },
      { team: { subagentTimeoutMs: 40 }, idleTimeoutMs: 500 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);

    // No provider call was ever made (the tier is off), but the loop RAN:
    // unassisted-wait events were emitted and the outcome latches degraded.
    expect(h.batches).toHaveLength(0);
    const overseerEvents = h.events.filter((e) => e.type === 'overseer');
    expect(overseerEvents.length).toBeGreaterThanOrEqual(1);
    for (const event of overseerEvents) {
      expect(event.type === 'overseer' && event.decision.action).toBe('wait');
    }
    // Degraded ticks do NOT enter the interventions ledger (D-10).
    expect(outcome.interventions ?? []).toHaveLength(0);
    expect(outcome.overseerDegraded).toBe(true);
    expect(outcome.overseerDegradedTicks!).toBeGreaterThanOrEqual(1);
    // THE promise: subagentTimeoutMs > 0 aborted nothing. The child finished.
    expect(outcome.runs[0]!.phase).toBe('done');
    expect(outcome.runs[0]!.summary).toBe('slow but unmolested');
  });

  it('overseer:false keeps the LEGACY hard abort (regression)', async () => {
    const h = harness(
      [{ hang: true }],
      {},
      { team: { overseer: false, subagentTimeoutMs: 50 }, idleTimeoutMs: 500 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);
    expect(h.digests).toHaveLength(0);
    expect(outcome.runs[0]!.phase).toBe('failed');
    expect(outcome.runs[0]!.error).toMatch(/subagent exceeded/);
  });

  it('no provider wired at all + overseer on: no hard abort either (D-4 boundary)', async () => {
    // The provider-absent boundary: children keep their un-lengthened
    // watchdog and NO wall clock; nothing is killed by time.
    const agents: StubAgent[] = [];
    const events: TeamEvent[] = [];
    const runtime = new TeamRuntime({
      getConfig: () => config({ subagentTimeoutMs: 40 }, 500),
      providerRegistry: {} as ProviderRegistry,
      getCwd: () => process.cwd(),
      getMode: () => 'build',
      getApiKey: () => 'k',
      agentFactory: () => {
        const agent = new StubAgent({ ms: 120, summary: 'finished alone' });
        agents.push(agent);
        return agent;
      },
    });
    runtime.subscribe((event) => events.push(event));
    const specs: SubagentSpec[] = [
      { label: 'a1', description: 'job', prompt: 'do', readOnly: false },
    ];
    const outcome = await runtime.dispatch(specs, 1);
    expect(outcome.runs[0]!.phase).toBe('done');
    expect(events.filter((e) => e.type === 'overseer')).toHaveLength(0);
  });
});

describe('the cadence tick (D-3)', () => {
  it('one tick is ONE batch call carrying every live child, applied one by one (AC-4)', async () => {
    const h = harness(
      [
        { ms: 150, summary: 'one' },
        { ms: 150, summary: 'two' },
      ],
      {
        batch: (labels) =>
          labels.map((label) => ({
            label,
            action: label === 'a1' ? 'nudge' : 'wait',
            reason: 'tick',
            guidance: 'try the other file',
          })),
      },
      { team: { overseerIntervalMs: 40 }, idleTimeoutMs: 500 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);

    // THE first tick carried BOTH live children in ONE call (AC-4), sorted
    // (D-3). Later ticks carry only a1: its nudge resets its ladder to the
    // base rung while a2's wait grows to the clamped next rung.
    expect(h.batches[0]).toEqual(['a1', 'a2']);
    for (const batch of h.batches) {
      expect(batch.length).toBeLessThanOrEqual(2);
      expect(batch).toEqual([...batch].sort());
    }
    // The nudge was steered into exactly its child, and never past the
    // per-child nudge budget (D-5)...
    expect(h.agents[0]!.steered.length).toBeLessThanOrEqual(3);
    expect(h.agents[1]!.steered).toEqual([]);
    // ...both children finished, each with one intervention per tick it was in.
    expect(outcome.runs.every((r) => r.phase === 'done')).toBe(true);
    expect(outcome.runs[0]!.interventions).toBe(h.batches.length);
    expect(outcome.runs[1]!.interventions).toBe(1);
    // The supervisor's own spend reached the outcome (D-7): one call per tick.
    expect(outcome.overseerUsage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(outcome.overseerCalls).toBe(h.batches.length);
  });

  it('4d: a QUEUED child is never in a batch, and its ladder arms at start (R-P1-5)', async () => {
    const h = harness(
      [
        { ms: 200, summary: 'first slot' },
        { ms: 30, summary: 'second slot' },
      ],
      { batch: (labels) => labels.map((label) => ({ label, action: 'wait', reason: 'fine' })) },
      { team: { overseerIntervalMs: 40, maxConcurrent: 1 }, idleTimeoutMs: 500 },
    );
    await h.runtime.dispatch(h.specs, h.specs.length);

    // maxConcurrent 1: while a1 ran, a2 was QUEUED - the first tick (40 ms,
    // before a2 ever started) must carry a1 alone.
    expect(h.batches[0]).toEqual(['a1']);
    // And no batch ever carried a label that had not started.
    for (const batch of h.batches) expect(batch).not.toContain('a2');
  });

  it('4e: a label whose single inspection is in flight is skipped by the tick (R-P1-4)', async () => {
    const h = harness(
      [{ ms: 400, summary: 'inspected the slow way' }],
      {
        batch: (labels) => labels.map((label) => ({ label, action: 'wait', reason: 'tick' })),
        singleDelayMs: 120,
      },
      { team: { overseerIntervalMs: 30 }, idleTimeoutMs: 30 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);

    // The single-flight invariant, asserted as the thing it protects: at no
    // moment were two inspections of the SAME child running concurrently,
    // even though the silence window and the cadence tick came due together.
    expect(h.maxConcurrentPerLabel()).toBe(1);
    expect(outcome.runs[0]!.phase).toBe('done');
    // And the silence look actually happened (the skip was of the BATCH, not
    // of supervision itself).
    expect(h.digests.length).toBeGreaterThanOrEqual(1);
  });

  it('a mid-dispatch /fast off degrades the NEXT tick (4 / D-4)', async () => {
    let active = true;
    const h = harness(
      [{ ms: 220, summary: 'survives the outage' }],
      {
        active: () => active,
        // A nudge keeps the ladder at the base rung, so a second tick comes
        // within the test window AFTER the tier went away.
        batch: () => [{ label: 'a1', action: 'nudge', reason: 'assisted', guidance: 'g' }],
      },
      { team: { overseerIntervalMs: 40 }, idleTimeoutMs: 500 },
    );
    const pending = h.runtime.dispatch(h.specs, h.specs.length);
    await sleep(70);
    active = false;
    const outcome = await pending;

    // One assisted tick happened before the outage...
    expect(h.batches.length).toBeGreaterThanOrEqual(1);
    // ...a tick ran after it with the tier gone: degraded is latched, the
    // tick was announced per child, and NO provider call was made for it...
    expect(outcome.overseerDegraded).toBe(true);
    expect(outcome.overseerDegradedTicks!).toBeGreaterThanOrEqual(1);
    const overseerEvents = h.events.filter((e) => e.type === 'overseer');
    expect(overseerEvents.length).toBeGreaterThan(h.batches.length);
    // ...and the child was still never killed.
    expect(outcome.runs[0]!.phase).toBe('done');
    // The assisted tick is in the ledger; the degraded ticks are not.
    const triggers = new Set((outcome.interventions ?? []).map((i) => i.trigger));
    expect(triggers.has('clock')).toBe(true);
    expect((outcome.interventions ?? []).filter((i) => i.reason.includes('unassisted'))).toHaveLength(0);
  });

  it('decisions arriving after an abort are dropped (existing guard, regression)', async () => {
    const controller = new AbortController();
    const h = harness(
      [{ hang: true }],
      {
        batchDelayMs: 60,
        batch: (labels) => labels.map((label) => ({ label, action: 'abandon', reason: 'late' })),
      },
      { team: { overseerIntervalMs: 20 }, idleTimeoutMs: 500 },
    );
    const pending = h.runtime.dispatch(h.specs, h.specs.length, controller.signal);
    await sleep(35);
    controller.abort();
    const outcome = await pending;
    // The dispatch aborted for the user's reason, not the supervisor's.
    expect(outcome.aborted).toBe(true);
    expect(outcome.runs[0]!.error ?? '').not.toContain('overseer abandoned');
    expect(h.agents[0]!.steered).toEqual([]);
  });

  it('replace and abandon decisions land a transcript-visible badge on the run (AC-5 data)', async () => {
    const h = harness(
      [{ hang: true }],
      { batch: () => [{ label: 'a1', action: 'abandon', reason: 'not worth it' }] },
      { team: { overseerIntervalMs: 30 }, idleTimeoutMs: 500 },
    );
    const outcome = await h.runtime.dispatch(h.specs, h.specs.length);
    expect(outcome.runs[0]!.lastIntervention).toBeDefined();
    expect(outcome.runs[0]!.lastIntervention!.action).toBe('abandon');
    expect(outcome.runs[0]!.lastIntervention!.reasonHead).toBe('not worth it');
    expect(typeof outcome.runs[0]!.lastIntervention!.at).toBe('number');
  });
});
