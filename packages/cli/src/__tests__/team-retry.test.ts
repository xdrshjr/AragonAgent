import { describe, expect, it } from 'vitest';
import type { AgentEvent, ModelInfo, ProviderRegistry } from '@aragon-agent/core';
import { TeamRuntime } from '../team/runtime.js';
import { isRetryableStreamError, shouldRetryColdStart } from '../team/retry.js';
import { TEAM_LIMITS } from '../team/limits.js';
import { runHeadless } from '../agent/headless.js';
import type { SubagentAgentLike } from '../team/subagent.js';
import type { SubagentRun, SubagentSpec, TeamEvent } from '../team/types.js';
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function config(team: Partial<TeamConfig> = {}): CliConfig {
  return {
    fast: DEFAULT_FAST_CONFIG,
    update: DEFAULT_UPDATE_CONFIG,
    provider: 'anthropic',
    model: 'm',
    thinkingLevel: 'off',
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
  };
}

/** What one ATTEMPT does. A retry builds a fresh child, which takes the next entry. */
interface Attempt {
  /** Emit a `message_update` error carrying this `retryable` flag, then resolve. */
  streamError?: { message: string; retryable: boolean };
  /** `turn_end` events emitted before the error. */
  turns?: number;
  /** `tool_execution_start` events emitted before the error. */
  toolCalls?: number;
  /** The final assistant text. */
  summary?: string;
  /** Never settles on its own; only `abort()` ends it. */
  hang?: boolean;
  ms?: number;
}

class ScriptedAgent implements SubagentAgentLike {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  /** The narrow member `SubagentAgentLike` gained for child compaction (W3). */
  readonly state = { messages: [] };
  private wake: (() => void) | null = null;
  aborts = 0;
  aborted = false;

  constructor(private readonly script: Attempt) {}

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent): void {
    for (const l of [...this.listeners]) l(event);
  }

  pauseIdleWatchdog(): void {}
  resumeIdleWatchdog(): void {}

  abort(): void {
    this.aborts += 1;
    this.aborted = true;
    this.wake?.();
  }

  async prompt(): Promise<void> {
    this.emit({ type: 'turn_start' } as AgentEvent);
    for (let i = 0; i < (this.script.toolCalls ?? 0); i += 1) {
      this.emit({
        type: 'tool_execution_start',
        toolCallId: `t${i}`,
        toolName: 'read_file',
        args: { path: 'a.ts' },
      } as AgentEvent);
    }
    for (let i = 0; i < (this.script.turns ?? 0); i += 1) {
      this.emit({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: this.script.summary ? [{ type: 'text', text: this.script.summary }] : [],
        },
        usage: { inputTokens: 100, outputTokens: 20 },
      } as AgentEvent);
    }
    if (this.script.streamError) {
      // Exactly the shape `wrapFetchError` produces: `retryable` lives on the
      // error object, read structurally rather than through `instanceof`.
      const error = Object.assign(new Error(this.script.streamError.message), {
        errorType: 'rate_limit',
        retryable: this.script.streamError.retryable,
      });
      this.emit({ type: 'message_update', streamEvent: { type: 'error', error } } as AgentEvent);
    }
    await this.settle();
    this.emit({ type: 'agent_end', messages: [] } as AgentEvent);
  }

  private settle(): Promise<void> {
    if (this.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, this.script.hang ? 60_000 : (this.script.ms ?? 2));
      (timer as unknown as { unref?: () => void }).unref?.();
      this.wake = done;
    });
  }
}

interface Harness {
  runtime: TeamRuntime;
  specs: SubagentSpec[];
  agents: ScriptedAgent[];
}

/**
 * `attempts` is a QUEUE consumed in factory-call order, so a retry - which
 * builds a fresh child through the same factory - takes the next entry.
 */
function harness(
  attempts: Attempt[],
  specCount: number,
  team: Partial<TeamConfig> = {},
): Harness {
  const agents: ScriptedAgent[] = [];
  const runtime = new TeamRuntime({
    getConfig: () => config(team),
    providerRegistry: {} as ProviderRegistry,
    getCwd: () => process.cwd(),
    getMode: () => 'build',
    getApiKey: () => 'k',
    agentFactory: () => {
      const agent = new ScriptedAgent(attempts[agents.length] ?? { summary: 'ok', turns: 1 });
      agents.push(agent);
      return agent;
    },
  });
  const specs: SubagentSpec[] = Array.from({ length: specCount }, (_, i) => ({
    label: `a${i + 1}`,
    description: `job ${i + 1}`,
    prompt: `do ${i + 1}`,
    readOnly: false,
    tier: 'main',
  }));
  return { runtime, specs, agents };
}

const COLD_START_FAILURE: Attempt = {
  streamError: { message: 'rate limited', retryable: true },
};

function makeRun(over: Partial<SubagentRun> = {}): SubagentRun {
  return {
    label: 'a1',
    description: 'd',
    tier: 'main',
    phase: 'failed',
    turns: 0,
    toolCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    filesTouched: [],
    messagesSent: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The predicate on its own
// ---------------------------------------------------------------------------

describe('shouldRetryColdStart', () => {
  it('reads `retryable` structurally, never through instanceof', () => {
    // The error crosses a package boundary; a duplicated core instance would
    // make `instanceof` false while the field is plainly there, and the failure
    // mode would be "retries silently stopped happening" (D-10).
    expect(isRetryableStreamError(Object.assign(new Error('x'), { retryable: true }))).toBe(true);
    expect(isRetryableStreamError(Object.assign(new Error('x'), { retryable: false }))).toBe(false);
    expect(isRetryableStreamError(new Error('plain'))).toBe(false);
    expect(isRetryableStreamError(undefined)).toBe(false);
    expect(isRetryableStreamError(null)).toBe(false);
    expect(isRetryableStreamError({ retryable: 'yes' })).toBe(false);
  });

  it('permits only a transport failure that touched nothing at all', () => {
    expect(shouldRetryColdStart(makeRun({ retryable: true }), 1)).toBe(true);
    // The side-effect proof: a completed turn wrote to the transcript, and a
    // tool call may have written to disk.
    expect(shouldRetryColdStart(makeRun({ retryable: true, turns: 1 }), 1)).toBe(false);
    expect(shouldRetryColdStart(makeRun({ retryable: true, toolCalls: 1 }), 1)).toBe(false);
    expect(shouldRetryColdStart(makeRun({ retryable: true, truncated: true }), 1)).toBe(false);
    expect(shouldRetryColdStart(makeRun({ retryable: false }), 1)).toBe(false);
    expect(shouldRetryColdStart(makeRun({}), 1)).toBe(false);
  });

  it('spends at most `maxColdStartRetries` attempts', () => {
    expect(shouldRetryColdStart(makeRun({ retryable: true }), TEAM_LIMITS.maxColdStartRetries))
      .toBe(true);
    expect(shouldRetryColdStart(makeRun({ retryable: true }), TEAM_LIMITS.maxColdStartRetries + 1))
      .toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-13 / AC-14 — the happy path and the four refusals
// ---------------------------------------------------------------------------

describe('cold-start retry in TeamRuntime (F-4)', () => {
  it('AC-13: retries a cold start exactly once and reports `retries: 1`', async () => {
    const { runtime, specs, agents } = harness(
      [COLD_START_FAILURE, { summary: 'found it', turns: 1 }],
      1,
    );
    const outcome = await runtime.dispatch(specs, 1);
    expect(agents).toHaveLength(2);
    expect(outcome.runs[0]!.phase).toBe('done');
    expect(outcome.runs[0]!.retries).toBe(1);
    expect(outcome.runs[0]!.summary).toBe('found it');
  }, 15_000);

  it('AC-13: a second failure of the same kind does NOT produce a third attempt', async () => {
    const { runtime, specs, agents } = harness([COLD_START_FAILURE, COLD_START_FAILURE], 1);
    const outcome = await runtime.dispatch(specs, 1);
    expect(agents).toHaveLength(2);
    expect(outcome.runs[0]!.phase).toBe('failed');
    expect(outcome.runs[0]!.retries).toBe(1);
  }, 15_000);

  it('AC-14: a child that completed a turn is not retried', async () => {
    const { runtime, specs, agents } = harness(
      [{ ...COLD_START_FAILURE, turns: 1 }],
      1,
    );
    const outcome = await runtime.dispatch(specs, 1);
    expect(agents).toHaveLength(1);
    expect(outcome.runs[0]!.retries).toBeUndefined();
  });

  it('AC-14: a child that ran a tool is not retried', async () => {
    const { runtime, specs, agents } = harness([{ ...COLD_START_FAILURE, toolCalls: 1 }], 1);
    await runtime.dispatch(specs, 1);
    expect(agents).toHaveLength(1);
  });

  it('AC-14: a NON-retryable error is not retried', async () => {
    const { runtime, specs, agents } = harness(
      [{ streamError: { message: 'bad request', retryable: false } }],
      1,
    );
    await runtime.dispatch(specs, 1);
    expect(agents).toHaveLength(1);
  });

  it('carries usage across the replacement so spend can never be under-reported (D-9)', async () => {
    // Provably zero under the predicate; carried anyway so a future relaxation
    // cannot silently lose it - the most misleading failure this feature can
    // produce.
    const { runtime, specs } = harness([COLD_START_FAILURE, { summary: 'ok', turns: 1 }], 1);
    const outcome = await runtime.dispatch(specs, 1);
    expect(outcome.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  }, 15_000);
});

// ---------------------------------------------------------------------------
// AC-12 — the highest-risk assertion in the round
// ---------------------------------------------------------------------------

describe('AC-12: an aborted child is NEVER retried', () => {
  /**
   * THE TRAP. `wrapFetchError` classifies an `AbortError` as
   * `errorType: 'timeout'` with `retryable: true`, so EVERY abort in this system
   * looks retryable - a user pressing Esc included. Each case below therefore
   * scripts a genuinely retryable error AND an abort, and asserts exactly one
   * attempt. If any of the four exclusions is deleted, exactly one of these
   * turns red.
   */
  const ABORTABLE: Attempt = { ...COLD_START_FAILURE, hang: true };

  it('user abort / AgentController.abort()', async () => {
    const { runtime, specs, agents } = harness([ABORTABLE], 1);
    const pending = runtime.dispatch(specs, 1);
    await sleep(20);
    runtime.abortAll();
    const outcome = await pending;
    expect(agents).toHaveLength(1);
    expect(outcome.runs[0]!.phase).toBe('aborted');
  });

  it('the `task` tool\'s ctx.signal', async () => {
    const { runtime, specs, agents } = harness([ABORTABLE], 1);
    const controller = new AbortController();
    const pending = runtime.dispatch(specs, 1, controller.signal);
    await sleep(20);
    controller.abort();
    const outcome = await pending;
    expect(agents).toHaveLength(1);
    expect(outcome.runs[0]!.phase).toBe('aborted');
  });

  it('the dispatch timeout', async () => {
    const { runtime, specs, agents } = harness([ABORTABLE], 1, { dispatchTimeoutMs: 60 });
    const outcome = await runtime.dispatch(specs, 1);
    expect(agents).toHaveLength(1);
    expect(outcome.runs[0]!.phase).toBe('aborted');
    expect(outcome.aborted).toBe(true);
  });

  it('the per-child timeout', async () => {
    const { runtime, specs, agents } = harness([ABORTABLE], 1, { subagentTimeoutMs: 60 });
    const outcome = await runtime.dispatch(specs, 1);
    expect(agents).toHaveLength(1);
    expect(outcome.runs[0]!.phase).toBe('failed');
    expect(outcome.aborted).toBe(false);
  });

  it('the turn cap, which fails the predicate twice over', async () => {
    const { runtime, specs, agents } = harness(
      [{ ...COLD_START_FAILURE, turns: 30, summary: 'partial' }],
      1,
      { maxTurnsPerSubagent: 2 },
    );
    const outcome = await runtime.dispatch(specs, 1);
    expect(agents).toHaveLength(1);
    expect(outcome.runs[0]!.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-15 / AC-17 / AC-17a — the live list and the backoff window
// ---------------------------------------------------------------------------

describe('the retry swaps the LIVE handle (AC-15 / R-3)', () => {
  it('abortAll during the second attempt aborts the SECOND child', async () => {
    // `TeamRuntime.live` aliases `handles`, so one assignment covers both. If it
    // did not, `abortAll()` would abort the discarded child and leak the live
    // one - a hung dispatch nothing in the report would explain.
    const { runtime, specs, agents } = harness([COLD_START_FAILURE, { hang: true }], 1);
    const pending = runtime.dispatch(specs, 1);
    await sleep(TEAM_LIMITS.retryBackoffMs + 200);
    expect(agents).toHaveLength(2);
    const beforeAbort = agents[1]!.aborts;
    runtime.abortAll();
    const outcome = await pending;

    expect(beforeAbort).toBe(0);
    expect(agents[1]!.aborts).toBeGreaterThanOrEqual(1);
    expect(outcome.runs[0]!.phase).toBe('aborted');
    // AC-20c, this half: the outcome carries the REPLACEMENT's run, which is
    // also what `canSend` reads through its closure over the same array.
    expect(outcome.runs[0]!.retries).toBe(1);
  }, 15_000);
});

describe('the backoff window releases on abort', () => {
  it('AC-17: an abort during the backoff ends the dispatch promptly', async () => {
    const { runtime, specs } = harness([COLD_START_FAILURE, { summary: 'ok', turns: 1 }], 1);
    const started = Date.now();
    const pending = runtime.dispatch(specs, 1);
    await sleep(60);
    runtime.abortAll();
    const outcome = await pending;
    expect(Date.now() - started).toBeLessThan(TEAM_LIMITS.retryBackoffMs);
    expect(outcome.runs[0]!.phase).toBe('aborted');
  });

  it('AC-17a: ...and the same holds when THREE children back off at once (P1-7)', async () => {
    // The simultaneous case is the NORMAL one: the failure that triggers a cold
    // start is usually provider-wide, so a 429 fails every in-flight child's
    // first request in the same tick. With a single stored resolver two of the
    // three are overwritten and only the last is released, and this test waits
    // out the whole backoff instead.
    const { runtime, specs } = harness(
      [COLD_START_FAILURE, COLD_START_FAILURE, COLD_START_FAILURE],
      3,
      { maxConcurrent: 3, maxSubagents: 3 },
    );
    const started = Date.now();
    const pending = runtime.dispatch(specs, 3);
    await sleep(80);
    runtime.abortAll();
    const outcome = await pending;

    expect(Date.now() - started).toBeLessThan(TEAM_LIMITS.retryBackoffMs);
    expect(outcome.runs.map((r) => r.phase)).toEqual(['aborted', 'aborted', 'aborted']);
  });
});

// ---------------------------------------------------------------------------
// AC-16 — headless is unchanged by a retry, as a property rather than an absence
// ---------------------------------------------------------------------------

describe('AC-16: headless prints one start line and one terminal line either way', () => {
  const headlessOf = async (h: Harness, specCount: number): Promise<string> => {
    let stderr = '';
    const sink = {
      write: (s: string) => {
        stderr += s;
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    await runHeadless(
      {
        preflight: () => ({ ok: true }),
        subscribe: () => () => {},
        getModelInfo: () => ({}) as ModelInfo,
        subscribeTeam: (listener: (event: TeamEvent) => void) => h.runtime.subscribe(listener),
        prompt: async () => {
          await h.runtime.dispatch(h.specs, specCount);
        },
      },
      'go',
      { stderr: sink, stdout: sink },
    );
    return stderr;
  };

  it('a retried child produces the same line shape as one that never retried', async () => {
    // The property falls out of the `started` / `finished` Sets: the failed
    // attempt never publishes a terminal phase, because the retry path returns
    // before `settlePhase`. Pinned rather than assumed (D-12).
    const plain = await headlessOf(harness([{ summary: 'ok', turns: 1 }], 1), 1);
    const retried = await headlessOf(
      harness([COLD_START_FAILURE, { summary: 'ok', turns: 1 }], 1),
      1,
    );

    const teamLines = (s: string): string[] => s.split('\n').filter((l) => l.startsWith('[team]'));
    expect(teamLines(plain).filter((l) => l.includes(' start '))).toHaveLength(1);
    expect(teamLines(retried).filter((l) => l.includes(' start '))).toHaveLength(1);
    // One terminal line each: `<label> ok <duration> <n> tools`.
    expect(teamLines(plain).filter((l) => /\ba1 ok\b/.test(l))).toHaveLength(1);
    expect(teamLines(retried).filter((l) => /\ba1 ok\b/.test(l))).toHaveLength(1);
    expect(teamLines(retried).some((l) => /failed|aborted/.test(l))).toBe(false);
  }, 15_000);
});
