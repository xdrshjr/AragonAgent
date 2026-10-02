/**
 * The two P0 regressions, end to end (context-usage-gauge-accuracy §7.1,
 * T6-T9).
 *
 * A REAL `Agent`, A REAL `CompactionWiring` AND A REAL `ContextMeter`, but no
 * `AgentController` where one is avoidable - the harness shape
 * `compaction-e2e.test.ts` argues for (DH-12), and for the same reason: a
 * harness that is expensive to stand up is a harness nobody extends. The two
 * rows that are ABOUT the controller (T8's `replaceMessages`, T9's
 * compaction-off session) build one, because the wiring they pin lives there.
 *
 * WHAT MAKES THESE WORTH THE COST. Both P0s are silent: the gauge shows a
 * plausible number that is simply the wrong one, no log line mentions it, and
 * the shape of the failure (P0-1's bounce) is visible for a single frame. Unit
 * tests over the pieces cannot see either, because both are defects of the SEAM.
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
import { ContextMeter } from '../compaction/meter.js';
import type { CompactionEvent, CompactionRecord } from '../compaction/types.js';
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
} from '../config/schema.js';
import { AgentController } from '../agent/controller.js';
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
  script?: ScriptStep[];
  seed?: Message[];
  /**
   * Whether the METER subscribes to the agent stream before or after the wiring.
   *
   * T7'S ENTIRE POINT. The v1 design put the splice notification on the meter's
   * own `compaction_end` subscription, which makes the answer depend on this
   * flag - true in every unit test that happens to pick the lucky order, false
   * in production import order.
   */
  meterFirst?: boolean;
}

function harness(opts: HarnessOpts = {}) {
  const info = modelInfo(opts.contextWindow ?? 200_000);
  const config = {
    provider: PROVIDER_ID,
    model: 'claude-sonnet-4-5',
    maxTokens: 4_096,
    contextWindow: null,
    fast: { ...DEFAULT_FAST_CONFIG },
    compaction: { ...DEFAULT_COMPACTION_CONFIG, archive: false, ...opts.compaction },
  } as unknown as CliConfig;

  const provider = scriptedProvider(PROVIDER_ID, opts.script ?? []);
  const registry = new ProviderRegistry({ retryPolicy: null });
  registry.register(provider);

  const events: CompactionEvent[] = [];
  const published: number[] = [];
  let agent: Agent | null = null;

  const meter = new ContextMeter({
    getMessages: () => agent?.state.messages ?? [],
    getSystemPrompt: () => agent?.state.systemPrompt ?? '',
    getModelInfo: () => info,
    isWindowKnown: () => true,
    getWindowOverride: () => config.contextWindow,
  });
  meter.subscribe((u) => published.push(u.occupied));

  const wiring = new CompactionWiring({
    getConfig: () => config,
    hasKey: () => true,
    getApiKey: () => 'k',
    getModelInfoFor: () => info,
    isPricedModel: () => true,
    getMessages: () => agent?.state.messages ?? [],
    getSystemPrompt: () => agent?.state.systemPrompt ?? '',
    notify: () => {},
    createRegistry: () => registry,
    // ONE METER PER PROCESS. Production injects the controller's; a wiring that
    // built its own would put the trigger and the gauge on two numbers.
    meter,
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

  const attachMeter = (): void => meter.attach((l) => agent!.subscribe(l as (e: AgentEvent) => void));
  const attachWiring = (): void => wiring.attach((l) => agent!.subscribe(l));
  if (opts.meterFirst) {
    attachMeter();
    attachWiring();
  } else {
    attachWiring();
    attachMeter();
  }
  if (opts.seed) agent.replaceMessages(opts.seed);

  const ends = (): CompactionRecord[] =>
    events
      .filter((e): e is Extract<CompactionEvent, { type: 'compaction_end' }> => e.type === 'compaction_end')
      .map((e) => e.record);

  /**
   * The occupancy on the `snapshot` that IMMEDIATELY FOLLOWS the applied
   * `compaction_end`.
   *
   * THAT PAIR IS THE BUG'S EXACT SHAPE. `settlePending` emits the two in one
   * synchronous loop, `App` renders the card from the first and the gauge from
   * the second, so a stale second event is what bounced the bar back up inside a
   * single frame. Looking at "the last snapshot of the run" instead would be
   * answered by the next `turn_end` and would pass against the bug.
   */
  const occupancyAfterCompaction = (): number | null => {
    for (let i = 0; i < events.length - 1; i += 1) {
      const end = events[i]!;
      const next = events[i + 1]!;
      if (end.type !== 'compaction_end' || !end.record.applied) continue;
      if (next.type !== 'snapshot') return null;
      return next.snapshot.pressure.occupied;
    }
    return null;
  };

  return { agent, wiring, meter, provider, events, ends, occupancyAfterCompaction, published, config };
}

const SUCCESSFUL_COMPACTION: ScriptStep[] = [
  { kind: 'summary', text: '## Task\ncompacted' },
  { kind: 'assistant', text: 'answered' },
];

describe('T6 - P0-1: the gauge falls and STAYS down', () => {
  it('the snapshot emitted after `compaction_end` carries the POST-compaction occupancy', async () => {
    // THE BUG, PRECISELY. `settlePending` emits `compaction_end` and then
    // `snapshot`, in one synchronous loop. `snapshot()` used to prefer
    // `compactor.lastMeasured()` - the measurement that TRIGGERED this
    // compaction - so the second event carried the PRE-compaction figure and
    // bounced the bar straight back up. `isApproximate` is true whenever there
    // are tool results, so the overwrite in `App` was not even conditional.
    const h = harness({ seed: historyOfSize(190_000), script: SUCCESSFUL_COMPACTION });

    await h.agent.prompt('continue');

    const record = h.ends()[0]!;
    expect(record.applied).toBe(true);

    const afterCompaction = h.occupancyAfterCompaction();
    expect(afterCompaction).not.toBeNull();
    // The compacted history is a small fraction of the 190k it replaced. Before
    // the fix this equalled `record.tokensBefore` almost exactly, because the
    // snapshot reported the measurement that TRIGGERED the compaction.
    expect(afterCompaction!).toBeLessThan(record.tokensBefore / 2);
    // And the published stream carried that same drop to the reducer, which is
    // what makes the bar fall in the SAME frame rather than 400 ms later.
    expect(h.published).toContain(afterCompaction);
  });
});

describe('T7 - and it does so regardless of subscription order (I-9 / RV-2)', () => {
  /**
   * MUTATION-VERIFIED. Move the splice notification off `settlePending`'s own
   * synchronous code and onto the meter's `compaction_end` subscription - the v1
   * design - and the `meterFirst: false` case goes red, because the wiring's
   * `snapshot()` then runs before the meter has heard anything. That asymmetry
   * is the whole reason this row exists in two directions rather than one.
   */
  for (const meterFirst of [true, false]) {
    it(`meter attached ${meterFirst ? 'BEFORE' : 'AFTER'} the wiring`, async () => {
      const h = harness({ seed: historyOfSize(190_000), script: SUCCESSFUL_COMPACTION, meterFirst });

      await h.agent.prompt('continue');

      const record = h.ends()[0]!;
      expect(record.applied).toBe(true);
      const afterCompaction = h.occupancyAfterCompaction();
      expect(afterCompaction).not.toBeNull();
      expect(afterCompaction!).toBeLessThan(record.tokensBefore / 2);
    });
  }
});

describe('T7b - `tokensBefore` is the PRE-compaction figure', () => {
  /**
   * THE USER-VISIBLE CLAIM ONLY. The I-10 MUTATION GUARD IS NOT HERE, and that
   * is an implementation finding rather than an oversight (spec IF-2): pointing
   * `Compactor.lastMeasured()` at `meter.current()` leaves this row GREEN,
   * because `settlePending` overrides `record.tokensBefore` from core's own
   * estimator on both the in-loop and the idle path. What the wrong forwarder
   * really breaks is the seam - an accounting read that measures and publishes -
   * and that is asserted, mutation-verified, in
   * `compaction-compactor.test.ts::lastMeasured() is the ACCOUNTING read`.
   */
  it('a successful compaction reclaims a positive number of tokens', async () => {
    const h = harness({ seed: historyOfSize(190_000), script: SUCCESSFUL_COMPACTION });

    await h.agent.prompt('continue');

    const record = h.ends()[0]!;
    expect(record.applied).toBe(true);
    expect(record.tokensBefore).toBeGreaterThan(record.tokensAfter);
    expect(h.wiring.snapshot().tokensReclaimed).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The two rows that are ABOUT `AgentController`
// ---------------------------------------------------------------------------

function controllerConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    fast: DEFAULT_FAST_CONFIG,
    update: DEFAULT_UPDATE_CONFIG,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
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
    log: DEFAULT_LOG_CONFIG,
    submitCount: 0,
    startInPlanMode: false,
    planModeMaxAskRounds: 4,
    planModeHumanTimeoutMs: 1_800_000,
    skills: { ...DEFAULT_SKILLS_CONFIG, enabled: false },
    skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    team: { ...DEFAULT_TEAM_CONFIG, enabled: false },
    todo: { ...DEFAULT_TODO_CONFIG, enabled: false },
    bash: DEFAULT_BASH_CONFIG,
    retry: DEFAULT_RETRY_CONFIG,
    compaction: { ...DEFAULT_COMPACTION_CONFIG },
    cwd: process.cwd(),
    color: true,
    ...overrides,
  };
}

describe('T8 - P0-2: `/resume` reports a real occupancy with no turn at all', () => {
  it('replaceMessages of a huge history moves the gauge immediately', () => {
    // BEFORE THIS FEATURE the two calls below did nothing observable:
    // `replaceMessages` only invalidated a prefix length, nothing re-measured,
    // nothing published, and the mount-time "empty history" reading stood until
    // the next completed turn. `/resume` of a 180k session read 0 %.
    const controller = new AgentController(controllerConfig());
    try {
      expect(controller.getContextUsage().pct).toBeLessThan(5);

      controller.replaceMessages(historyOfSize(180_000));

      const usage = controller.getContextUsage();
      expect(usage.pct).toBeGreaterThan(80);
      // It is honest about being an estimate: `/resume` drops the calibration
      // with the history (I-8's deep reset), so the first reading is a bare
      // estimate that the next `turn_end` corrects.
      expect(usage.source).toBe('estimate');
    } finally {
      controller.dispose();
    }
  });

  it('there is exactly ONE meter, and the wiring reads it (R-1)', () => {
    const controller = new AgentController(controllerConfig());
    try {
      const meter = controller.getContextMeter();
      controller.replaceMessages(historyOfSize(180_000));
      // `/compact status` and the status bar both come from here, so a second
      // meter anywhere in the process is two answers to one question.
      expect(controller.getCompactionSnapshot().pressure.occupied).toBe(
        meter.current().occupied,
      );
    } finally {
      controller.dispose();
    }
  });
});

describe('T9 - P1-4: a compaction-OFF session still has a working gauge', () => {
  it('measures on demand with no `CompactionWiring` in the process', () => {
    // THE ASYMMETRY THAT JUSTIFIES THE WHOLE DESIGN. `AgentController` builds no
    // wiring at all when `compaction.enabled` is false, and before this feature
    // that took the only measuring code in the process with it - such a session
    // had one gauge sample per turn and read 0 % after a `/resume`.
    const controller = new AgentController(
      controllerConfig({ compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false } }),
    );
    try {
      expect(controller.isCompactionRegistered()).toBe(false);
      controller.replaceMessages(historyOfSize(180_000));
      expect(controller.getContextUsage().pct).toBeGreaterThan(80);
    } finally {
      controller.dispose();
    }
  });

  it('an in-turn tick moves the reading without any turn boundary', () => {
    const controller = new AgentController(
      controllerConfig({ compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false } }),
    );
    try {
      controller.replaceMessages([user('short')]);
      const before = controller.getContextUsage().occupied;
      controller.replaceMessages(historyOfSize(120_000));
      // `scheduleTick` is what `tool_execution_end` calls; `current()` is what
      // the screen reads, and it re-measures on demand rather than waiting for
      // the 400 ms publish.
      controller.getContextMeter().scheduleTick();
      expect(controller.getContextUsage().occupied).toBeGreaterThan(before * 10);
    } finally {
      controller.dispose();
    }
  });
});
