import { describe, expect, it, vi } from 'vitest';
import {
  IdleWatchdog,
  type AgentEvent,
  type AgentTool,
  type Message,
  type ProviderRegistry,
} from '@aragon-agent/core';
import { TeamRuntime } from '../team/runtime.js';
import { buildProjectGuidanceBlock } from '../agent/project-guidance-prompt.js';
import { TeamHumanQueue } from '../team/human-queue.js';
import { createTaskTool } from '../team/task-tool.js';
import { normalizeSubagentSpecs } from '../team/normalize.js';
import type { SubagentAgentLike } from '../team/subagent.js';
import type { SubagentSpec, TeamEvent } from '../team/types.js';
import {
  DEFAULT_FAST_CONFIG,
  DEFAULT_UPDATE_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_SKILLS_RUNTIME,
  DEFAULT_TEAM_CONFIG,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_TODO_CONFIG,
  DEFAULT_BASH_CONFIG,
  DEFAULT_LOG_CONFIG,
  type CliConfig,
  type TeamConfig,
} from '../config/schema.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function config(team: Partial<TeamConfig> = {}): CliConfig {
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
    idleTimeoutMs: 210_000,
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
    // The NINTH nested section. `enabled: false` on purpose: these fixtures
    // are about other subsystems, and the same `enabled: false` appears above
    // for `skills`, `team` and `todo` for exactly that reason.
    compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false },
    cwd: process.cwd(),
    color: true,
    keyboardEnhancement: false,
  };
}

/** How one stubbed child behaves. Everything is scripted; nothing goes near a network. */
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
}

/**
 * A stub `Agent` injected through `TeamRuntime`'s `agentFactory` option — the
 * seam §8.1 requires so no test in this file touches a network. It mirrors the
 * `HeadlessController` pattern: a minimal structural interface the real class
 * already satisfies.
 */
class StubAgent implements SubagentAgentLike {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  /**
   * The narrow member `SubagentAgentLike` gained so a child can read its OWN
   * history for compaction (hardening W3 / RV-1).
   *
   * A REAL ARRAY THAT THIS STUB MUTATES, not the literal `[]` the simpler stubs
   * use: this file drives real histories, so a child manager built against it
   * would measure what the child actually accumulated - which is what makes the
   * laziness assertion meaningful rather than tautological.
   */
  readonly state: { messages: Message[] } = { messages: [] };
  private wake: (() => void) | null = null;
  aborted = false;
  pauses = 0;

  constructor(
    private readonly script: Script,
    private readonly census: { live: number; peak: number },
  ) {}

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent): void {
    for (const l of [...this.listeners]) l(event);
  }

  pauseIdleWatchdog(): void {
    this.pauses += 1;
  }
  steer(_text: string): void {}
  clearAllQueues(): void {}

  resumeIdleWatchdog(): void {
    this.pauses -= 1;
  }

  abort(): void {
    this.aborted = true;
    this.wake?.();
  }

  async prompt(): Promise<void> {
    this.census.live += 1;
    this.census.peak = Math.max(this.census.peak, this.census.live);
    try {
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
      await this.settle();
      this.emit({ type: 'agent_end', messages: [] });
    } finally {
      this.census.live -= 1;
    }
  }

  /** Sleep for the scripted duration, or until `abort()` wakes us. */
  private settle(): Promise<void> {
    if (this.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, this.script.hang ? 60_000 : this.script.ms ?? 5);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.wake = done;
    });
  }
}

function runtimeWith(
  scripts: Script[],
  teamOverrides: Partial<TeamConfig> = {},
): { runtime: TeamRuntime; specs: SubagentSpec[]; census: { live: number; peak: number }; agents: StubAgent[] } {
  const census = { live: 0, peak: 0 };
  const agents: StubAgent[] = [];
  const runtime = new TeamRuntime({
    getConfig: () => config(teamOverrides),
    providerRegistry: {} as ProviderRegistry,
    getCwd: () => process.cwd(),
    getMode: () => 'build',
    getApiKey: () => 'k',
    agentFactory: () => {
      const agent = new StubAgent(scripts[agents.length] ?? {}, census);
      agents.push(agent);
      return agent;
    },
  });
  const { specs } = normalizeSubagentSpecs(
    scripts.map((_, i) => ({ label: `a${i + 1}`, description: `job ${i + 1}`, prompt: `do ${i + 1}` })),
    10,
  );
  return { runtime, specs, census, agents };
}

describe('TeamRuntime project guidance', () => {
  it.each([false, true])('PG-07: passes guidance to a readOnly=%s child', async (readOnly) => {
    const prompts: string[] = [];
    const census = { live: 0, peak: 0 };
    const runtime = new TeamRuntime({
      getConfig: () => config(),
      providerRegistry: {} as ProviderRegistry,
      getCwd: () => process.cwd(),
      getMode: () => 'build',
      getApiKey: () => 'k',
      agentFactory: (agentConfig) => {
        prompts.push(agentConfig.systemPrompt ?? '');
        return new StubAgent({ summary: 'done' }, census);
      },
    });
    const { specs } = normalizeSubagentSpecs([
      { label: 'reader', description: 'Inspect module', prompt: 'Explain module', readOnly },
    ], 10);
    const outcome = await runtime.dispatch(specs, specs.length);

    expect(outcome.runs.map((run) => run.phase)).toEqual(['done']);
    expect(census.live).toBe(0);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt).toContain(buildProjectGuidanceBlock());
    expect(prompt.match(/<project_guidance>/g)).toHaveLength(1);
    expect(prompt.match(/<\/project_guidance>/g)).toHaveLength(1);
    expect(prompt.match(/<subagent_role>/g)).toHaveLength(1);
    expect(prompt.includes('<plan_mode>')).toBe(readOnly);
  });
});

describe('TeamRuntime slot pool', () => {
  it('never runs more than maxConcurrent children at once (AC-1)', async () => {
    // `maxConcurrent` is a separate knob from `maxSubagents` because provider
    // rate limits are a different constraint from context economics (D-6): five
    // simultaneous streams against one key is a reliable way to collect 429s.
    const { runtime, specs, census } = runtimeWith(
      Array.from({ length: 6 }, () => ({ ms: 30, summary: 'ok' })),
      { maxConcurrent: 2, maxSubagents: 6 },
    );
    const outcome = await runtime.dispatch(specs, specs.length);
    expect(census.peak).toBe(2);
    expect(outcome.runs).toHaveLength(6);
    expect(outcome.runs.every((r) => r.phase === 'done')).toBe(true);
  });

  it('runs everything when maxConcurrent covers the whole batch', async () => {
    const { runtime, specs, census } = runtimeWith(
      Array.from({ length: 3 }, () => ({ ms: 30, summary: 'ok' })),
      { maxConcurrent: 5 },
    );
    await runtime.dispatch(specs, specs.length);
    expect(census.peak).toBe(3);
  });
});

describe('TeamRuntime outcomes', () => {
  it('ONE FAILURE DOES NOT FAIL THE DISPATCH (D-14)', async () => {
    // Partial results are the normal outcome of a fan-out. An all-or-nothing
    // result would throw away two successes because of one 429.
    const { runtime, specs } = runtimeWith([
      { summary: 'found it' },
      { throws: 'rate limited' },
      { summary: 'mapped it' },
    ]);
    const outcome = await runtime.dispatch(specs, specs.length);
    expect(outcome.runs.map((r) => r.phase)).toEqual(['done', 'failed', 'done']);
    expect(outcome.runs[1]!.error).toContain('rate limited');
    expect(outcome.aborted).toBe(false);
  });

  it('marks a child that produced nothing as failed, not as an empty success', async () => {
    const { runtime, specs } = runtimeWith([{ summary: undefined }]);
    const outcome = await runtime.dispatch(specs, specs.length);
    expect(outcome.runs[0]!.phase).toBe('failed');
    expect(outcome.runs[0]!.error).toBe('run produced no output');
  });

  it('stops a child at the turn cap and marks it truncated', async () => {
    const { runtime, specs, agents } = runtimeWith([{ turns: 30, summary: 'partial' }], {
      maxTurnsPerSubagent: 4,
    });
    const outcome = await runtime.dispatch(specs, specs.length);
    expect(agents[0]!.aborted).toBe(true);
    expect(outcome.runs[0]!.truncated).toBe(true);
    expect(outcome.runs[0]!.turns).toBeGreaterThanOrEqual(4);
  });

  it('aborts a child that overruns its own wall clock, without touching the others', async () => {
    // A wedged child dies on its own ceiling and does NOT take the dispatch with
    // it (§3.8). `config()` here bypasses `clampTeamConfig` deliberately so the
    // timer is short enough to be a real timer rather than a mocked one.
    const { runtime, specs, agents } = runtimeWith([{ hang: true }, { ms: 10, summary: 'fine' }], {
      subagentTimeoutMs: 60,
      maxConcurrent: 2,
      // subagent-overseer-v2 D-4: the hard wall clock is the LEGACY
      // regime, armed only under `team.overseer: false`.
      overseer: false,
    });
    const outcome = await runtime.dispatch(specs, specs.length);
    expect(agents[0]!.aborted).toBe(true);
    expect(outcome.runs[0]!.phase).toBe('failed');
    expect(outcome.runs[0]!.error).toContain('exceeded');
    expect(outcome.runs[1]!.phase).toBe('done');
    expect(outcome.aborted).toBe(false);
  });

  it('sums child usage so the status bar cannot under-report (R-5)', async () => {
    const { runtime, specs } = runtimeWith([{ summary: 'a' }, { summary: 'b' }]);
    const outcome = await runtime.dispatch(specs, specs.length);
    expect(outcome.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
  });

  it('reports `requested` verbatim so a capped fan-out is visible', async () => {
    const { runtime, specs } = runtimeWith([{ summary: 'a' }]);
    const outcome = await runtime.dispatch(specs, 30);
    expect(outcome.requested).toBe(30);
  });
});

describe('TeamRuntime abort and dispose', () => {
  it('propagates ctx.signal to every child within the dispatch (AC-10)', async () => {
    const { runtime, specs, agents } = runtimeWith(
      [{ hang: true }, { hang: true }, { hang: true }],
      { maxConcurrent: 3 },
    );
    const controller = new AbortController();
    const pending = runtime.dispatch(specs, specs.length, controller.signal);
    await sleep(20);
    controller.abort();
    const outcome = await pending;
    expect(outcome.aborted).toBe(true);
    expect(agents.every((a) => a.aborted)).toBe(true);
    expect(outcome.runs.every((r) => r.phase === 'aborted')).toBe(true);
  });

  it('marks children that never started as aborted rather than leaving them queued', async () => {
    const { runtime, specs } = runtimeWith(
      [{ hang: true }, { hang: true }, { hang: true }, { hang: true }],
      { maxConcurrent: 1 },
    );
    const controller = new AbortController();
    const pending = runtime.dispatch(specs, specs.length, controller.signal);
    await sleep(20);
    controller.abort();
    const outcome = await pending;
    // Every accepted spec is accounted for in the report, running or not.
    expect(outcome.runs).toHaveLength(4);
    expect(outcome.runs.every((r) => r.phase === 'aborted')).toBe(true);
  });

  it('dispose() aborts everything and is safe when idle', async () => {
    const { runtime, specs, agents } = runtimeWith([{ hang: true }]);
    const pending = runtime.dispatch(specs, specs.length);
    await sleep(20);
    runtime.dispose();
    await pending;
    expect(agents[0]!.aborted).toBe(true);
    expect(() => runtime.dispose()).not.toThrow();
  });

  it('isBusy() gates a second dispatch (R-14)', async () => {
    const { runtime, specs } = runtimeWith([{ ms: 40, summary: 'ok' }]);
    expect(runtime.isBusy()).toBe(false);
    const pending = runtime.dispatch(specs, specs.length);
    await sleep(10);
    expect(runtime.isBusy()).toBe(true);
    await pending;
    expect(runtime.isBusy()).toBe(false);
  });
});

describe('TeamRuntime event stream', () => {
  it('brackets the dispatch with dispatch_start / dispatch_end', async () => {
    const { runtime, specs } = runtimeWith([{ summary: 'a' }, { summary: 'b' }]);
    const events: TeamEvent[] = [];
    const unsubscribe = runtime.subscribe((e) => events.push(e));
    await runtime.dispatch(specs, 5);
    unsubscribe();

    expect(events[0]!.type).toBe('dispatch_start');
    expect(events[events.length - 1]!.type).toBe('dispatch_end');
    const start = events[0] as Extract<TeamEvent, { type: 'dispatch_start' }>;
    expect(start.requested).toBe(5);
    expect(start.specs).toHaveLength(2);
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'agent_update').length).toBeGreaterThan(0);
  });

  it('a throwing subscriber cannot take the dispatch down with it', async () => {
    const { runtime, specs } = runtimeWith([{ summary: 'a' }]);
    runtime.subscribe(() => {
      throw new Error('bad subscriber');
    });
    await expect(runtime.dispatch(specs, 1)).resolves.toBeTruthy();
  });
});

describe('AC-20b/AC-20c — `canSend` end to end, through the bus the runtime built', () => {
  /**
   * THE ONE PLACE THE REAL `canSend` CLOSURE IS OBSERVABLE.
   *
   * `TeamBus` is internal to `dispatch()`, but the child's tool array is not:
   * `agentFactory` receives the `AgentConfig` the runtime assembled, and that
   * carries the very `team_wait` the child would have called. Driving it
   * directly asserts the production predicate rather than a re-statement of it
   * in a test.
   */
  function withTools(scripts: Script[], teamOverrides: Partial<TeamConfig> = {}) {
    const census = { live: 0, peak: 0 };
    const agents: StubAgent[] = [];
    const tools: AgentTool[][] = [];
    const runtime = new TeamRuntime({
      getConfig: () => config(teamOverrides),
      providerRegistry: {} as ProviderRegistry,
      getCwd: () => process.cwd(),
      getMode: () => 'build',
      getApiKey: () => 'k',
      agentFactory: (agentConfig) => {
        tools.push(agentConfig.tools ?? []);
        const agent = new StubAgent(scripts[agents.length] ?? {}, census);
        agents.push(agent);
        return agent;
      },
    });
    const { specs } = normalizeSubagentSpecs(
      scripts.map((_, i) => ({ label: `a${i + 1}`, description: `job ${i + 1}`, prompt: `do ${i + 1}` })),
      10,
    );
    const waitOf = (index: number): AgentTool =>
      tools[index]!.find((t) => t.name === 'team_wait')!;
    return { runtime, specs, agents, waitOf };
  }

  const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
    r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

  it('AC-20b: a wait on a QUEUED peer is PERMITTED, on the shipped default shape', async () => {
    // `maxConcurrent: 3` with five children means a4 and a5 sit in `queued` for
    // the first part of every dispatch. A `canSend` written the natural way -
    // "the phase is running" - refuses this wait as "a5 already finished", on
    // the DEFAULT configuration rather than on an edge case (P0-2).
    const { runtime, specs, waitOf } = withTools(
      Array.from({ length: 5 }, () => ({ hang: true })),
      { maxConcurrent: 3, maxSubagents: 5 },
    );
    const pending = runtime.dispatch(specs, specs.length);
    await sleep(30);

    const wait = waitOf(0).execute('1', { from: 'a5', timeoutSeconds: 120 }, {});
    // A refusal returns immediately; a permitted wait parks. That IS the claim.
    const verdict = await Promise.race([
      wait.then(() => 'returned'),
      sleep(80).then(() => 'parked'),
    ]);
    expect(verdict).toBe('parked');

    runtime.abortAll();
    expect(textOf(await wait)).toContain('No message arrived');
    await pending;
  });

  it('AC-18/AC-20c: ...and it is REFUSED once that peer has actually settled', async () => {
    // The other half of the same predicate, read through the same closure over
    // the live handles.
    const { runtime, specs, waitOf } = withTools(
      [{ hang: true }, { ms: 5, summary: 'done early' }],
      { maxConcurrent: 2, maxSubagents: 2 },
    );
    const pending = runtime.dispatch(specs, specs.length);
    await sleep(60); // long enough for a2 to finish

    const result = await waitOf(0).execute('1', { from: 'a2', timeoutSeconds: 120 }, {});
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('already finished');

    runtime.abortAll();
    await pending;
  });
});

describe('the `task` tool guards (§3.3)', () => {
  const deps = (over: Record<string, unknown> = {}) => {
    const { runtime } = runtimeWith([{ summary: 'ok' }]);
    return {
      runtime,
      isTeamEnabled: () => true,
      maxSubagents: () => 5,
      hasApiKey: () => true,
      activeProvider: () => 'anthropic',
      modelCost: () => undefined,
      withPausedWatchdog: <T,>(fn: () => Promise<T>) => fn(),
      ...over,
    };
  };

  const call = (tool: ReturnType<typeof createTaskTool>, params: unknown) =>
    tool.execute('1', params as Record<string, unknown>, {});

  const textOf = (r: { content: Array<{ type: string; text?: string }> }) =>
    r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

  it('refuses as a NON-ERROR when team mode was switched off mid-session', async () => {
    const tool = createTaskTool(deps({ isTeamEnabled: () => false }) as never);
    const result = await call(tool, { subagents: [{ description: 'd', prompt: 'p' }] });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Team mode is off');
  });

  it('refuses as a NON-ERROR when the API key was emptied mid-session (P2-3)', async () => {
    // `preflight()` runs before the LOOP, not before a tool call, so without
    // this guard a key cleared from the settings screen produces N identical
    // stream failures instead of one cheap refusal.
    const tool = createTaskTool(deps({ hasApiKey: () => false }) as never);
    const result = await call(tool, { subagents: [{ description: 'd', prompt: 'p' }] });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('no API key for anthropic');
  });

  it('zero usable specs is the ONE hard failure', async () => {
    const tool = createTaskTool(deps() as never);
    const result = await call(tool, { subagents: [{ description: '', prompt: '' }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No usable subagent specs');
  });

  it('returns a NON-ERROR report even when every child failed (D-14)', async () => {
    const { runtime } = runtimeWith([{ throws: 'boom' }, { throws: 'boom' }]);
    const tool = createTaskTool(deps({ runtime }) as never);
    const result = await call(tool, {
      subagents: [
        { label: 'a1', description: 'one', prompt: 'p' },
        { label: 'a2', description: 'two', prompt: 'p' },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('(0 ok, 2 failed)');
  });
});

describe('AC-14 — the lead watchdog regression guard (I-3 / R-3)', () => {
  /**
   * THE SINGLE MOST LIKELY WAY TO SHIP THIS FEATURE BROKEN.
   *
   * The watchdog fires on EVENT SILENCE, not on inactivity, and a lead blocked
   * inside `task` emits nothing — so a dispatch longer than `idleTimeoutMs` is
   * aborted with `[Agent] idle watchdog fired` on stderr and no other
   * explanation.
   *
   * REAL TIMERS, REAL WATCHDOG, past a REAL idle timeout (spec §12 condition 2):
   * a test that mocked the clock away would test nothing here. The timeout is
   * shortened rather than faked, so the test is fast and still genuine.
   */
  const IDLE_MS = 120;
  const DISPATCH_MS = 400;

  it('a dispatch longer than the idle timeout survives when the watchdog is paused', async () => {
    let fired = false;
    const watchdog = new IdleWatchdog(IDLE_MS, () => {
      fired = true;
    });
    watchdog.start();

    const { runtime } = runtimeWith([{ ms: DISPATCH_MS, summary: 'ok' }]);
    const tool = createTaskTool({
      runtime,
      isTeamEnabled: () => true,
      maxSubagents: () => 5,
      hasApiKey: () => true,
      activeProvider: () => 'anthropic',
      modelCost: () => undefined,
      // Exactly what `AgentController.withPausedWatchdog` does.
      withPausedWatchdog: async (fn) => {
        watchdog.pause();
        try {
          return await fn();
        } finally {
          watchdog.resume();
        }
      },
    });

    await tool.execute('1', { subagents: [{ description: 'd', prompt: 'p' }] }, {});
    expect(fired).toBe(false);
    watchdog.stop();
  });

  it('...and the same dispatch DOES trip it without the pause (the guard has teeth)', async () => {
    let fired = false;
    const watchdog = new IdleWatchdog(IDLE_MS, () => {
      fired = true;
    });
    watchdog.start();

    const { runtime } = runtimeWith([{ ms: DISPATCH_MS, summary: 'ok' }]);
    const tool = createTaskTool({
      runtime,
      isTeamEnabled: () => true,
      maxSubagents: () => 5,
      hasApiKey: () => true,
      activeProvider: () => 'anthropic',
      modelCost: () => undefined,
      withPausedWatchdog: (fn) => fn(),
    });

    await tool.execute('1', { subagents: [{ description: 'd', prompt: 'p' }] }, {});
    expect(fired).toBe(true);
    watchdog.stop();
  });
});

describe('AC-16 — the queued-confirm watchdog guard (I-3 one level down, P0-4)', () => {
  /**
   * A child sitting behind another child's dialog is emitting nothing, and its
   * own idle watchdog is armed. `controller.ts` records fixing exactly this for
   * the LEAD's `--confirm` gate; repeating it for children would regress a fix
   * this codebase already paid for.
   *
   * The pause happens ON ENQUEUE, not on display, because the FIFO is where the
   * time actually goes — which is what this test holds open.
   */
  it('holds ONE dialog at a time and pauses each waiting child for its whole queue wait', async () => {
    const IDLE_MS = 80;
    const DIALOG_MS = 300;

    let concurrent = 0;
    let peak = 0;
    const queue = new TeamHumanQueue(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await sleep(DIALOG_MS);
      concurrent -= 1;
      return true;
    });

    const fired: string[] = [];
    const child = (label: string) => {
      const watchdog = new IdleWatchdog(IDLE_MS, () => fired.push(label));
      watchdog.start();
      return {
        watchdog,
        pauseIdleWatchdog: () => watchdog.pause(),
        resumeIdleWatchdog: () => watchdog.resume(),
      };
    };

    const a2 = child('a2');
    const a3 = child('a3');
    // `stop()` on settle models the real thing: once a child's dialog is
    // answered it goes back to emitting events, which kicks its watchdog. What
    // this test is about is the window BEFORE that, spent in the FIFO.
    const results = await Promise.all([
      queue
        .request(a2, 'a2', { tool: 'write_file', summary: 'Write: src/a.ts' })
        .then((v) => {
          a2.watchdog.stop();
          return v;
        }),
      queue
        .request(a3, 'a3', { tool: 'write_file', summary: 'Write: src/b.ts' })
        .then((v) => {
          a3.watchdog.stop();
          return v;
        }),
    ]);

    // One dialog at a time — the single human slot is never double-resolved (I-4).
    expect(peak).toBe(1);
    expect(results).toEqual([true, true]);
    // `a3` waited ~600 ms (300 behind `a2`, then its own 300) against an 80 ms
    // watchdog and survived, which is the whole point of pausing on enqueue.
    expect(fired).toEqual([]);
  });

  it('...and the same wait DOES kill the queued child without the pause (teeth)', async () => {
    const IDLE_MS = 80;
    const queue = new TeamHumanQueue(async () => {
      await sleep(300);
      return true;
    });

    const fired: string[] = [];
    const watchdog = new IdleWatchdog(IDLE_MS, () => fired.push('a3'));
    watchdog.start();
    // `null` is "no child handed to the queue", i.e. exactly what the code looks
    // like if someone drops the pause.
    await Promise.all([
      queue.request(null, 'a2', { tool: 'write_file', summary: 'a' }),
      queue.request(null, 'a3', { tool: 'write_file', summary: 'b' }),
    ]);
    watchdog.stop();
    expect(fired).toEqual(['a3']);
  });

  it('labels each request so the user can tell which agent is asking (P1-3)', async () => {
    const seen: string[] = [];
    const queue = new TeamHumanQueue(async (req) => {
      seen.push(req.summary);
      return true;
    });
    await queue.request(null, 'a2', { tool: 'write_file', summary: 'Write: src/routes.ts' });
    expect(seen).toEqual(['[a2] Write: src/routes.ts']);
  });

  it('an abort resolves the request rather than leaving the child owing an answer', async () => {
    const queue = new TeamHumanQueue(() => new Promise<boolean>(() => {}));
    const controller = new AbortController();
    const pending = queue.request(null, 'a1', { tool: 'bash', summary: 'Run: ls' }, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBe(false);
  });

  it('a rejected confirm denies without poisoning the queue for later requests', async () => {
    // An unhandled rejection would poison the chain and every LATER request
    // would reject without ever being shown — "the second file write silently
    // did nothing".
    const confirm = vi
      .fn<(req: { tool: string; summary: string }) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('overlay gone'))
      .mockResolvedValue(true);
    const queue = new TeamHumanQueue(confirm);
    await expect(queue.request(null, 'a1', { tool: 'bash', summary: 's' })).resolves.toBe(false);
    await expect(queue.request(null, 'a2', { tool: 'bash', summary: 's' })).resolves.toBe(true);
  });
});
