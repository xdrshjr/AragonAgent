/**
 * The session review budget (fast-model-tier-hardening W1 / §7.1 tests 1-8).
 *
 * WHAT THIS FILE IS ABOUT. Round 1 bounded review spend structurally (a
 * 4 000-char digest in, 512 tokens out) and per RUN (`maxReviewsPerRun`), but a
 * long working session is not one run - it is one run per user message, and
 * `reviewsThisRun` is reset by every one of them. Thirty messages therefore
 * bought up to 180 unrequested review calls, and the product's only response was
 * to tell you afterwards. These cases pin the bound that closes that, and three
 * of them pin the ways a budget can quietly become a lie:
 *
 *   - it counts the SAME number `/fast status` prints, so the gate and the
 *     numerator cannot disagree (test 3a / AC-H3b);
 *   - a suppression is neither a success nor a failure, so it must not move the
 *     strike counter (test 5 / AC-H6) - the distinction IF-7 was filed for,
 *     applied to a second cause;
 *   - and it must be raisable LIVE, or the notice names a remedy that does not
 *     work until relaunch (test 4 / AC-H4).
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AssistantMessage, LLMRequest } from '@aragon-agent/core';
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
import { FastReviewer } from '../fast/reviewer.js';
import { FastWiring } from '../fast/wiring.js';
import type { FastEvent, FastTier } from '../fast/types.js';

// The reviewer's own transport is `FastWiring`'s registry since W2, so the
// wiring-level case below must not reach the network. The reviewer-level cases
// take `complete` by injection and are untouched by this.
const mocks = vi.hoisted(() => ({
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
    initProviders: () => ({ complete: mocks.fastComplete }) as never,
  };
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TIER: FastTier = {
  ok: true,
  ref: { providerId: 'anthropic', modelId: 'claude-haiku-4-5' },
  thinkingLevel: 'off',
  sameAsMain: false,
};

function ok(text = 'OK - on track.'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { inputTokens: 10, outputTokens: 4 },
  };
}

interface Harness {
  reviewer: FastReviewer;
  emit(event: AgentEvent): void;
  complete: ReturnType<typeof vi.fn>;
  notices: Array<[string, string]>;
  events: FastEvent[];
  /** What `/fast budget <n>` does to the LIVE config, without a restart. */
  setBudget(n: number): void;
}

function harness(
  over: Partial<FastConfig>,
  complete?: (providerId: string, request: LLMRequest) => Promise<AssistantMessage>,
): Harness {
  const listeners = new Set<(e: AgentEvent) => void>();
  const events: FastEvent[] = [];
  const notices: Array<[string, string]> = [];
  const cfg: FastConfig = {
    ...DEFAULT_FAST_CONFIG,
    enabled: true,
    model: 'claude-haiku-4-5',
    reviewEveryTurns: 1,
    ...over,
  };
  const completeFn = vi.fn(complete ?? (async () => ok()));

  let reviewerRef: FastReviewer | null = null;
  const reviewer = new FastReviewer({
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    complete: completeFn,
    steer: () => {},
    isRunning: () => true,
    isAbortRequested: () => false,
    userSteerCount: () => 0,
    clearAllQueues: () => {},
    getTier: () => TIER,
    getConfig: () => cfg,
    available: () => true,
    getApiKey: () => 'k',
    emit: (e) => events.push(e),
    // The reviewer announces its own self-disable with a `tier_changed`, and
    // the snapshot for it can only come from the wiring. A minimal stand-in is
    // enough here: the field under test is `selfDisabled`, which the reviewer
    // answers itself.
    snapshot: () => ({
      live: true,
      selfDisabled: reviewerRef?.isSelfDisabled() ?? false,
      model: TIER.ok ? TIER.ref.modelId : '',
      sameAsMain: false,
      reviews: 0,
      reviewBudget: 0,
      budgetReached: false,
      usage: { inputTokens: 0, outputTokens: 0 },
      pricingUnknown: false,
      inFlight: false,
    }),
    notify: (level, text) => notices.push([level, text]),
    now: () => 1_000_000,
  });
  reviewerRef = reviewer;

  return {
    reviewer,
    emit: (event) => {
      for (const l of [...listeners]) l(event);
    },
    complete: completeFn,
    notices,
    events,
    setBudget: (n) => {
      cfg.reviewMaxPerSession = n;
    },
  };
}

function turnEnd(n: number): AgentEvent {
  return {
    type: 'turn_end',
    message: {
      role: 'assistant',
      content: Array.from({ length: n }, (_, i) => ({
        type: 'tool_call' as const,
        toolCallId: `c${i}`,
        toolName: 'read_file',
        args: {},
      })),
    },
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

const toolEnd = (id: string): AgentEvent => ({
  type: 'tool_execution_end',
  toolCallId: id,
  toolName: 'read_file',
  result: { content: [] },
  isError: false,
  duration: 5,
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** One complete turn with one tool call. */
async function turn(h: Harness): Promise<void> {
  h.emit({ type: 'turn_start' });
  h.emit(turnEnd(1));
  h.emit(toolEnd('c0'));
  await settle();
}

/** A whole run of `n` turns, the way a single user message replays. */
async function run(h: Harness, n: number): Promise<void> {
  h.emit({ type: 'agent_start' });
  for (let i = 0; i < n; i += 1) await turn(h);
  h.emit({ type: 'agent_end', messages: [] });
  await settle();
}

const warns = (h: Harness): Array<[string, string]> =>
  h.notices.filter(([level]) => level === 'warn');

// ---------------------------------------------------------------------------
// Enforcement (AC-H1 / AC-H2)
// ---------------------------------------------------------------------------

describe('the budget bounds the SESSION, not the run (test 1 / AC-H1)', () => {
  it('three runs that each hit cadence start exactly `reviewMaxPerSession` calls', async () => {
    const h = harness({ reviewMaxPerSession: 2 });
    await run(h, 2);
    await run(h, 2);
    await run(h, 2);
    expect(h.complete).toHaveBeenCalledTimes(2);
  });

  it('`beginRun()` does not reset the session counter (test 2)', async () => {
    // The counter the gate compares against is `reviewIndex`, which is never
    // reset - tidying it into `beginRun()` beside `reviewsThisRun` would
    // silently remove the budget, so this is the case that catches that.
    const h = harness({ reviewMaxPerSession: 2 });
    await run(h, 1);
    expect(h.complete).toHaveBeenCalledTimes(1);
    await run(h, 1);
    expect(h.complete).toHaveBeenCalledTimes(2);
    await run(h, 1);
    expect(h.complete).toHaveBeenCalledTimes(2);
  });
});

describe('the announcement (test 3 / AC-H2 / AC-H3)', () => {
  it('is emitted ONCE across five further cadence hits, and emits no card', async () => {
    const h = harness({ reviewMaxPerSession: 2 });
    h.emit({ type: 'agent_start' });
    await turn(h);
    await turn(h);
    expect(h.complete).toHaveBeenCalledTimes(2);

    const before = h.events.length;
    for (let i = 0; i < 5; i += 1) await turn(h);

    expect(h.notices).toHaveLength(1);
    // `info`, not `warn`: D-24 reserves the alarming register for a
    // MISCONFIGURED tier, which never fixes itself. A budget reached is the
    // system working as configured.
    expect(h.notices[0]![0]).toBe('info');
    expect(h.notices[0]![1]).toContain('session budget reached (2)');
    // The reasonable wrong inference this clause exists to prevent.
    // The reasonable wrong inference this clause exists to prevent:
    // reviews stopping is not the fast tier switching off.
    expect(h.notices[0]![1]).toContain('/fast budget');

    // NO CARD (§3.1.3): a suppressed review never started and has no index.
    expect(h.events.length).toBe(before);
  });

  it('suppression never advances `reviewCount()` (test 3a / AC-H3b)', async () => {
    // THE REGRESSION GUARD ON THE SINGLE-COUNTER RULE. Minting an index to hang
    // a card on would advance the very number `/fast status` renders as the
    // numerator, so the first suppression would display `3/2`.
    const h = harness({ reviewMaxPerSession: 2 });
    h.emit({ type: 'agent_start' });
    for (let i = 0; i < 7; i += 1) await turn(h);

    expect(h.reviewer.reviewCount()).toBe(2);
    expect(h.reviewer.budgetLimit()).toBe(2);
    expect(h.reviewer.isBudgetReached()).toBe(true);
  });

  it('fires only on a turn where cadence was hit (test 7 / AC-H2)', async () => {
    const h = harness({ reviewMaxPerSession: 1, reviewEveryTurns: 5 });
    h.emit({ type: 'agent_start' });
    for (let i = 0; i < 5; i += 1) await turn(h);
    expect(h.complete).toHaveBeenCalledTimes(1);

    // Turns 6-9 are not cadence hits. Gating BEFORE the cadence test would
    // announce on every one of them, and the notice would be tied to the clock
    // rather than to a review the user actually lost.
    for (let i = 0; i < 4; i += 1) await turn(h);
    expect(h.notices).toHaveLength(0);

    await turn(h);
    expect(h.notices).toHaveLength(1);
  });
});

describe('raising and lowering the budget (AC-H4 / AC-H5)', () => {
  it('a raise re-arms the tier AND the notice (test 4)', async () => {
    const h = harness({ reviewMaxPerSession: 2 });
    h.emit({ type: 'agent_start' });
    for (let i = 0; i < 3; i += 1) await turn(h);
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(h.notices).toHaveLength(1);

    // `/fast budget 4` - live, no restart, because `budgetLimit()` reads config.
    h.setBudget(4);
    await turn(h);
    await turn(h);
    expect(h.complete).toHaveBeenCalledTimes(4);

    // The latch is keyed on the LIMIT, so the new exhaustion announces again.
    await turn(h);
    expect(h.notices).toHaveLength(2);
    expect(h.notices[1]![1]).toContain('(4)');
  });

  it('lowering below the current count suppresses at once, announcing once', async () => {
    const h = harness({ reviewMaxPerSession: 10 });
    h.emit({ type: 'agent_start' });
    for (let i = 0; i < 3; i += 1) await turn(h);
    expect(h.complete).toHaveBeenCalledTimes(3);
    expect(h.notices).toHaveLength(0);

    h.setBudget(1);
    await turn(h);
    await turn(h);
    expect(h.complete).toHaveBeenCalledTimes(3);
    expect(h.notices).toHaveLength(1);
  });
});

describe('a suppression is neither a success nor a failure (test 5-6 / AC-H6)', () => {
  it('does not move the strike counter', async () => {
    // One genuine failure, then suppressions, then two more failures. The warn
    // must land on the THIRD failure. If a suppression scored, it would land on
    // the first one after the raise instead.
    const h = harness({ reviewMaxPerSession: 1 }, async () => {
      throw Object.assign(new Error('boom'), { errorType: 'server_error' });
    });

    h.emit({ type: 'agent_start' });
    await turn(h);
    expect(h.complete).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 4; i += 1) await turn(h);
    expect(warns(h)).toHaveLength(0);

    h.setBudget(10);
    await turn(h);
    expect(warns(h)).toHaveLength(0);
    await turn(h);
    expect(warns(h)).toHaveLength(1);
  });

  it('does not self-disable the reviewer', async () => {
    const h = harness({ reviewMaxPerSession: 1 });
    h.emit({ type: 'agent_start' });
    for (let i = 0; i < 6; i += 1) await turn(h);
    expect(h.complete).toHaveBeenCalledTimes(1);

    // Self-disable is for a tier that will never work again on its own. A budget
    // stop is the system obeying the user, so raising it must revive the tier on
    // the next sealed frame with no restart and no re-resolution.
    h.setBudget(5);
    await turn(h);
    expect(h.complete).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// The budget/review boundary (test 8 / D-H7)
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

describe('the budget applies to REVIEW only (test 8 / D-H7)', () => {
  it('an exhausted session still resolves the tier - reviews and child reviewers included', async () => {
    const listeners = new Set<(e: AgentEvent) => void>();
    const config = cliConfig({ reviewMaxPerSession: 1 });
    const wiring = new FastWiring({
      getConfig: () => config,
      hasKey: () => true,
      getApiKey: () => 'k',
      isPricedModel: () => true,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      complete: async () => ok(),
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
    emit({ type: 'agent_start' });
    for (let i = 0; i < 4; i += 1) {
      emit({ type: 'turn_start' });
      emit(turnEnd(1));
      emit(toolEnd('c0'));
      await settle();
    }

    const snapshot = wiring.snapshot();
    expect(snapshot.reviews).toBe(1);
    expect(snapshot.reviewBudget).toBe(1);
    expect(snapshot.budgetReached).toBe(true);

    // The tier still resolves after the budget ran out: per-child reviews
    // share it, and a budgeted review cadence must not take the tier with
    // it (main-agent parity keeps every child on the lead's model either
    // way - there is no delegation path left to cap).
    expect(wiring.available()).toBe(true);
    expect(wiring.fastRef()!.modelId).toBe('claude-haiku-4-5');

    wiring.dispose();
  });
});
