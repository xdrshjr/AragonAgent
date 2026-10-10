/**
 * TEMPORARY REPRO HARNESS (diagnosis node) — delete after the analysis is filed.
 *
 * Drives the REAL AgentController + REAL ContextMeter + REAL reducer/status-bar
 * projection against a scripted provider, replicating what the TUI user sees.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { AgentEvent, TokenUsage } from '@aragon-agent/core';
import { AgentController } from '../agent/controller.js';
import { initialViewState, reduceEvent, viewReducer, type ViewState } from '../agent/reducer.js';
import { planPrimaryStatusFields } from '../ui/layout/status-layout.js';
import { scriptedProvider, type ScriptStep } from './helpers/scripted-provider.js';
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
import type { ContextUsageSnapshot } from '../compaction/types.js';

vi.mock('../config/store.js', () => ({
  updatePersistedConfig: vi.fn(() => ({})),
  getSessionsDir: () => '/tmp/aragon-sessions',
  getConfigPath: () => '/tmp/aragon-config.json',
  readConfigFile: () => ({ config: null }),
}));

function controllerConfig(overrides: Partial<CliConfig> = {}, compaction: Partial<CliConfig['compaction']> = {}): CliConfig {
  return {
    fast: DEFAULT_FAST_CONFIG,
    update: DEFAULT_UPDATE_CONFIG,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    baseUrl: undefined,
    thinkingLevel: 'off',
    showThinking: false,
    liveToolOutput: false,
    contextWindow: null,
    maxTokens: undefined,
    theme: 'auto',
    reducedMotion: false,
    confirmTools: false,
    exitTranscript: true,
    transcriptWindow: 300,
    transcriptRetain: 1000,
    renderGovernor: true,
    maxRenderIntervalMs: 320,
    diffRender: true,
    syncOutput: true,
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
    team: { ...DEFAULT_TEAM_CONFIG, enabled: false },
    submitCount: 0,
    startInPlanMode: false,
    planModeMaxAskRounds: 4,
    planModeHumanTimeoutMs: 1_800_000,
    skills: DEFAULT_SKILLS_CONFIG,
    skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    todo: { ...DEFAULT_TODO_CONFIG, enabled: false },
    bash: DEFAULT_BASH_CONFIG,
    retry: DEFAULT_RETRY_CONFIG,
    compaction: { ...DEFAULT_COMPACTION_CONFIG, archive: false, ...compaction },
    cwd: process.cwd(),
    color: true,
    keyboardEnhancement: false,
    colorLevel: 3,
    unicode: true,
    ...overrides,
  } as CliConfig;
}

interface Trace { when: string; usage: ContextUsageSnapshot; status: string }

function usage(input: number, output: number): TokenUsage {
  return { inputTokens: input, outputTokens: output };
}

afterEach(() => vi.unstubAllGlobals());

describe('repro: adapter drops gateway-reported input tokens', () => {
  it('message_delta carries input_tokens but the adapter yields inputTokens=0', async () => {
    const { AnthropicProvider } = await import('@aragon-agent/core');
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      // What Anthropic-compatible relays (bigmodel /api/anthropic, api.deepseek.com
      // /anthropic, api.kimi.com/coding) send: message_start WITHOUT usable usage,
      // final message_delta WITH the real numbers.
      ['message_start', { message: { usage: { input_tokens: 0 } } }],
      ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } }],
      ['content_block_stop', { index: 0 }],
      ['message_delta', { delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 95_123, output_tokens: 245 } }],
      ['message_stop', {}],
    ])));
    const provider = new AnthropicProvider();
    const events: unknown[] = [];
    for await (const e of provider.stream({ model: 'glm-5.3', messages: [],
      systemPrompt: '', apiKey: 'k', baseUrl: 'https://relay.test' } as never)) {
      events.push(e);
    }
    const done = events.at(-1) as { usage: { inputTokens: number; outputTokens: number } };
    console.log('adapter done usage:', JSON.stringify(done.usage));
    expect(done.usage.outputTokens).toBe(245);
    expect(done.usage.inputTokens).toBe(0); // <-- the discarded 95,123
  });

  it('that zero-input usage collapses the meter gauge and never triggers compaction', async () => {
    const { ContextMeter } = await import('../compaction/meter.js');
    const { shouldCompactAt } = await import('../compaction/pressure.js');
    const messages: never[] = [];
    for (let i = 0; i < 30; i += 1) {
      messages.push({ role: 'user', content: `turn ${i}: ${'x'.repeat(2_000)}`, timestamp: 0 } as never);
      messages.push({ role: 'assistant', content: [{ type: 'text', text: 'answer '.repeat(200) }] } as never);
    }
    const meter = new ContextMeter({
      getMessages: () => messages,
      getSystemPrompt: () => 'sys',
      getModelInfo: () => ({ contextWindow: 200_000, contextWindowSource: 'user' }) as never,
      isWindowKnown: () => true,
      getWindowOverride: () => null,
    });
    const published: number[] = [];
    meter.subscribe((u) => published.push(u.pct));
    meter.onTurnEnd({ inputTokens: 0, outputTokens: 245 });
    const after = meter.currentUsage();
    console.log('meter after zero-input turn_end: occupied=', after.occupied,
      'pct=', after.pct, 'source=', after.source);
    console.log('shouldCompactAt(0.9)?', shouldCompactAt(
      { occupied: after.occupied, contextWindow: 200_000 } as never, 0.9));
    expect(after.pct).toBeLessThan(1);
  });
});

describe('repro: context display during a live agent run', () => {
  it('agentic run with tool calls — what the status bar shows', async () => {
    const script: ScriptStep[] = [
      { kind: 'assistant', text: 'let me read', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'package.json' } }], usage: usage(90_000, 1_000) },
      { kind: 'assistant', text: 'done, here is the answer', usage: usage(96_000, 1_500) },
    ];
    const controller = new AgentController(controllerConfig());
    try {
      const provider = scriptedProvider('anthropic', script);
      controller.getProviderRegistry().register(provider);

      let view: ViewState = initialViewState();
      const trace: Trace[] = [];
      controller.subscribeContextUsage((u) => trace.push({ when: 'publish', usage: u, status: statusText(u) }));
      controller.subscribe((e: AgentEvent) => {
        for (const action of reduceEvent(e)) view = viewReducer(view, action);
      });

      await controller.prompt('inspect the repo');

      const finalUsage = controller.getContextUsage();
      trace.push({ when: 'final', usage: finalUsage, status: statusText(finalUsage) });
      console.log('TRACE:\n' + trace.map((t) =>
        `${t.when} occupied=${t.usage.occupied} pct=${t.usage.pct} window=${t.usage.window} source=${t.usage.source} delta=${t.usage.deltaTokens} bar="${t.status}"`).join('\n'));
      console.log('view context:', JSON.stringify(view.context));
      console.log('requests sent:', provider.agentRequests.map((r) => r.messages.length));
      console.log('usage total:', JSON.stringify(view.usageTotal));
    } finally {
      controller.dispose();
    }
  });

  it('auto-compaction fires at the user threshold and the gauge falls', async () => {
    const script: ScriptStep[] = [
      { kind: 'assistant', text: 'answered', usage: usage(30_000, 200) },
    ];
    // The compactor's summarizer uses its OWN registry (initProviders) — the only
    // way to script it through a real controller is the global transport.
    const summaryText = JSON.stringify({ schemaVersion: 2, additions: [{
      section: 'facts', text: 'The first repository file was read.',
      sources: [{ messageId: 'g1:m2', role: 'tool_result', excerpt: 'result 0:' }],
    }] });
    let summarizerCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      summarizerCalls += 1;
      return sseResponse([
        ['message_start', { message: { usage: { input_tokens: 150_000 } } }],
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: summaryText } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 400 } }],
        ['message_stop', {}],
      ]);
    }));
    const controller = new AgentController(controllerConfig({}, { threshold: 0.5 }));
    try {
      const provider = scriptedProvider('anthropic', script);
      controller.getProviderRegistry().register(provider);

      const trace: string[] = [];
      controller.subscribeContextUsage((u) => trace.push(`publish occupied=${u.occupied} pct=${u.pct} source=${u.source}`));
      const events: string[] = [];
      controller.subscribeCompaction((e) => events.push(e.type +
        ('record' in e ? ` applied=${(e.record as { applied?: boolean }).applied}` : '')));

      seedHistory(controller, 190_000);
      const seeded = controller.getContextUsage();
      console.log('seeded:', seeded.occupied, seeded.pct, seeded.source, seeded.window, 'known=', seeded.windowKnown);

      await controller.prompt('continue');

      const finalUsage = controller.getContextUsage();
      console.log('events:', events.join(','));
      console.log('TRACE:\n' + trace.join('\n'));
      console.log('final:', finalUsage.occupied, finalUsage.pct, finalUsage.source);
      console.log('summarizer fetch calls:', summarizerCalls,
        'agent requests:', provider.agentRequests.map((r) => r.messages.length).join(','));
      console.log('history length now:', controller.getMessages().length);
    } finally {
      controller.dispose();
    }
  }, 30_000);
});

// --- helpers ---------------------------------------------------------------

/** An Anthropic-style SSE Response built from [event, data] pairs. */
function sseResponse(events: readonly [string, Record<string, unknown>][]): Response {
  const encoder = new TextEncoder();
  const body = events.map(([event, data]) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200,
    headers: { 'content-type': 'text/event-stream' } });
}

function statusText(u: ContextUsageSnapshot): string {
  const plan = planPrimaryStatusFields({
    columns: 120, phase: 'tool', pendingCount: 0, context: u,
    usageTotal: { inputTokens: 0, outputTokens: 0, costUsd: 0 } as never,
    thinkingLevel: 'off', elapsedMs: 1000, tokPerSec: 10, speedKnown: true,
  });
  return plan.fields.map((f) => f.text).join(' | ');
}

function seedHistory(controller: AgentController, tokens: number): void {
  const out: never[] = [];
  const count = 12;
  const perMessage = Math.ceil((tokens * 4) / count);
  for (let i = 0; i < count; i += 1) {
    out.push({ role: 'user', content: `turn ${i}: inspect the repository`, timestamp: 0 } as never);
    out.push({ role: 'assistant', content: [{ type: 'tool_call', toolCallId: `read-${i}`,
      toolName: 'read_file', args: { path: `file-${i}.txt` } }] } as never);
    out.push({ role: 'tool_result', toolCallId: `read-${i}`, isError: false,
      content: `result ${i}: ${'q'.repeat(perMessage)}` } as never);
    out.push({ role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } as never);
  }
  controller.replaceMessages(out);
}
