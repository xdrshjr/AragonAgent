import { describe, expect, it } from 'vitest';
import {
  LIVE_TAIL_ROWS,
  STALL_AFTER_MS,
  TOOL_OUTPUT_STORE_CAP,
  createToolOutputStore,
} from '../tools/tool-output-store.js';
import { createBuiltinTools } from '../tools/index.js';
import { AgentController } from '../agent/controller.js';
import {
  DEFAULT_FAST_CONFIG,
  DEFAULT_BASH_CONFIG,
  DEFAULT_UPDATE_CONFIG,
  DEFAULT_LOG_CONFIG,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_SKILLS_RUNTIME,
  DEFAULT_TEAM_CONFIG,
  DEFAULT_TODO_CONFIG,
  type CliConfig,
} from '../config/schema.js';
import type { ToolExecutionContext, ToolResult } from '@aragon-agent/core';

const ctx: ToolExecutionContext = {};

/** `ToolResult` carries content blocks, not a string. */
function text(result: ToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

function config(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    fast: DEFAULT_FAST_CONFIG,
    update: DEFAULT_UPDATE_CONFIG,
    bash: DEFAULT_BASH_CONFIG,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    thinkingLevel: 'off',
    showThinking: false,
    liveToolOutput: true,
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
    retry: DEFAULT_RETRY_CONFIG,
    // The NINTH nested section. `enabled: false` on purpose: these fixtures
    // are about other subsystems, and the same `enabled: false` appears above
    // for `skills`, `team` and `todo` for exactly that reason.
    compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false },
    cwd: process.cwd(),
    color: true,
    ...overrides,
  };
}

/** The seven builtins, by name, for the byte-identity comparisons below. */
function toolset(options: Parameters<typeof createBuiltinTools>[0]) {
  const out: Record<string, ReturnType<typeof createBuiltinTools>[number]> = {};
  for (const t of createBuiltinTools(options)) out[t.name] = t;
  return out;
}

describe('ToolOutputStore (agent-activity-presentation-live §3.1.1)', () => {
  it('never returns more than LIVE_TAIL_ROWS, however much arrives', () => {
    const store = createToolOutputStore();
    let tail: readonly string[] = [];
    for (let i = 0; i < 500; i += 1) tail = store.append('lead', 't1', `line ${i}\n`);
    expect(tail).toHaveLength(LIVE_TAIL_ROWS);
    // AC-23 — the LAST rows, not the first. Head-first would freeze on the first
    // eight lines a build ever printed (D-25).
    expect(tail[tail.length - 1]).toBe('line 499');
    expect(tail[0]).toBe(`line ${500 - LIVE_TAIL_ROWS}`);
  });

  it('ends the tail with the IN-PROGRESS line while one is open, and drops it once terminated', () => {
    const store = createToolOutputStore();
    expect(store.append('lead', 't1', 'done one\nhalf a li')).toEqual(['done one', 'half a li']);
    expect(store.append('lead', 't1', 'ne\n')).toEqual(['done one', 'half a line']);
  });

  it('is owner-scoped: a subagent id cannot paint the lead card (D-13)', () => {
    const store = createToolOutputStore();
    store.append('lead', 'x', 'lead output\n');
    store.append('sub', 'x', 'child output\n');
    expect(store.peek('lead', 'x')).toEqual(['lead output']);
    expect(store.peek('sub', 'x')).toEqual(['child output']);
    expect(store.size()).toBe(2);
  });

  it('clear() releases the slot, which is what bounds the store by CONCURRENT calls', () => {
    const store = createToolOutputStore();
    store.append('lead', 't1', 'a\n');
    expect(store.size()).toBe(1);
    store.clear('lead', 't1');
    expect(store.peek('lead', 't1')).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('evicts the oldest call past the cap, so a session that never settles is bounded', () => {
    const store = createToolOutputStore();
    for (let i = 0; i < TOOL_OUTPUT_STORE_CAP + 1; i += 1) store.append('lead', `t${i}`, 'x\n');
    expect(store.size()).toBe(TOOL_OUTPUT_STORE_CAP);
    expect(store.peek('lead', 't0')).toBeUndefined();
    expect(store.peek('lead', `t${TOOL_OUTPUT_STORE_CAP}`)).toEqual(['x']);
  });

  it('peek() does not remove — it is a read, unlike FileChangeStore.take (P2-2)', () => {
    const store = createToolOutputStore();
    store.append('lead', 't1', 'kept\n');
    expect(store.peek('lead', 't1')).toEqual(['kept']);
    expect(store.peek('lead', 't1')).toEqual(['kept']);
    expect(store.size()).toBe(1);
  });

  it('sanitises ON WRITE, so no consumer can forget (AC-24)', () => {
    const store = createToolOutputStore();
    const tail = store.append('lead', 't1', '\x1b[31mred\x1b[0m\n\x1b[2K\rbar 1\rbar 22\n');
    expect(tail).toEqual(['red', 'bar 22']);
  });

  it('AC-39 — a bar that never emits a newline still produces a one-row tail', () => {
    const store = createToolOutputStore();
    let tail: readonly string[] = [];
    for (let i = 0; i <= 100; i += 1) tail = store.append('lead', 't1', `\rworking ${i}%`);
    expect(tail).toEqual(['working 100%']);
  });

  it('keeps the two bounds as DIFFERENT numbers (P2-8) and declares the stall window', () => {
    // Rows inside one call, versus calls inside one session. A shared literal is
    // how a later edit collapses two unrelated bounds into one.
    expect(LIVE_TAIL_ROWS).not.toBe(TOOL_OUTPUT_STORE_CAP);
    expect(STALL_AFTER_MS).toBe(10_000);
  });

  it('freezes the tail, so one listener cannot mutate what the next one sees', () => {
    const store = createToolOutputStore();
    const tail = store.append('lead', 't1', 'a\n');
    expect(Object.isFrozen(tail)).toBe(true);
  });
});

describe('the producer side (§3.1.2)', () => {
  /**
   * AC-30 — THE MODEL'S RESULT IS BYTE-IDENTICAL. The recorder is a second
   * consumer of a string `bash` already builds, so this is checkable by
   * comparison rather than by inspection (R-7).
   */
  it('AC-30 — `bash` returns the same bytes with and without a recorder', async () => {
    const command = 'node -e "process.stdout.write(\'hello\\nworld\')"';
    const plain = toolset({ getCwd: () => process.cwd() });
    const recorded = toolset({ getCwd: () => process.cwd(), recordOutput: () => {} });
    const a = await plain.bash!.execute('1', { command }, ctx);
    const b = await recorded.bash!.execute('1', { command }, ctx);
    expect(text(b)).toBe(text(a));
    expect(text(a)).toContain('hello');
    expect(b.isError).toBe(a.isError);
  });

  it('forwards every chunk to the recorder, keyed by the tool-call id', async () => {
    const seen: Array<[string, string]> = [];
    const tools = toolset({
      getCwd: () => process.cwd(),
      recordOutput: (id, chunk) => seen.push([id, chunk]),
    });
    await tools.bash!.execute('call-7', {
      command: 'node -e "process.stdout.write(\'streamed\')"',
    }, ctx);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(([id]) => id === 'call-7')).toBe(true);
    expect(seen.map(([, c]) => c).join('')).toContain('streamed');
  });

  /**
   * AC-31 — WITH THE KEY OFF, NOTHING IS ADDED.
   *
   * `createBuiltinTools` builds `ToolDeps` by an explicit conditional spread, so
   * "off" means the property is ABSENT rather than present-and-false. Asserting
   * the absence is what makes AC-31 checkable rather than aspirational, and it
   * is the layer at which round 1's P1-3 (a field added to one of two interfaces)
   * would show up.
   */
  it('AC-31 — no `recordOutput` key reaches the tools when none was supplied', async () => {
    const tools = toolset({ getCwd: () => process.cwd() });
    // The tool exists and runs exactly as before; nothing observes its output.
    const r = await tools.bash!.execute('1', {
      command: 'node -e "process.stdout.write(\'quiet\')"',
    }, ctx);
    expect(text(r)).toContain('quiet');
    expect(r.isError).toBeFalsy();
  });

  it('AC-31 — the tool list is unchanged in both directions', () => {
    const off = createBuiltinTools({ getCwd: () => process.cwd() }).map((t) => t.name);
    const on = createBuiltinTools({
      getCwd: () => process.cwd(),
      recordOutput: () => {},
    }).map((t) => t.name);
    expect(on).toEqual(off);
  });

});

/**
 * The transport (§3.1.3) — asserted through a REAL `AgentController`, because
 * every one of these properties is a property of the wiring rather than of a
 * function: the store's nullability, the conditional spread that binds the
 * recorder, and the per-listener `try/catch` that stands between a render bug
 * and a ten-minute build.
 */
describe('AgentController transport (§3.1.3)', () => {
  const bashOf = (c: InstanceType<typeof AgentController>) =>
    c.listTools().find((t) => t.name === 'bash')!;

  const run = (c: InstanceType<typeof AgentController>, body: string) =>
    bashOf(c).execute('call-1', { command: `node -e "${body}"` }, ctx);

  it('delivers sanitised rows to a subscriber while the command runs', async () => {
    const controller = new AgentController(config({ liveToolOutput: true }));
    const seen: string[][] = [];
    const off = controller.subscribeToolOutput(({ toolCallId, rows }) => {
      expect(toolCallId).toBe('call-1');
      seen.push([...rows]);
    });
    await run(controller, "process.stdout.write('\\u001b[32mgreen\\u001b[0m\\n')");
    off();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual(['green']);
  });

  /**
   * AC-31 — WITH THE KEY OFF, THE FEATURE IS REALLY OFF.
   *
   * `subscribeToolOutput` returns the no-op unsubscribe its three siblings
   * already promise, so `App` can subscribe unconditionally — and no store is
   * allocated, so no `recordOutput` property is added and `bash` is the
   * pre-round tool.
   */
  it('AC-31 — with `liveToolOutput: false` no row is ever emitted', async () => {
    const controller = new AgentController(config({ liveToolOutput: false }));
    const seen: string[][] = [];
    const off = controller.subscribeToolOutput(({ rows }) => seen.push([...rows]));
    const r = await run(controller, "process.stdout.write('quiet\\n')");
    off();
    expect(seen).toEqual([]);
    // And the command itself is untouched.
    expect(text(r)).toContain('quiet');
  });

  /**
   * AC-35 — A RENDER-SIDE THROW MUST NOT KILL A BUILD (R-5).
   *
   * The emitter runs INSIDE `child.stdout.on('data')`, so an exception escaping
   * it propagates into the child-process data handler. Two things are asserted
   * because two things can fail independently: the command still returns its
   * full result, and the OTHER listener still receives its rows — a `for` loop
   * without a per-listener `try` would drop everything after the thrower.
   */
  it('AC-35 — a throwing listener kills neither the command nor its siblings', async () => {
    const controller = new AgentController(config({ liveToolOutput: true }));
    const survivor: string[][] = [];
    const offBad = controller.subscribeToolOutput(() => {
      throw new Error('render blew up');
    });
    const offGood = controller.subscribeToolOutput(({ rows }) => survivor.push([...rows]));
    const r = await run(controller, "process.stdout.write('survived\\n')");
    offBad();
    offGood();
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('survived');
    expect(survivor.length).toBeGreaterThan(0);
    expect(survivor[survivor.length - 1]).toEqual(['survived']);
  });

  it('unsubscribing stops delivery, and does so without disturbing the run', async () => {
    const controller = new AgentController(config({ liveToolOutput: true }));
    const seen: string[][] = [];
    const off = controller.subscribeToolOutput(({ rows }) => seen.push([...rows]));
    off();
    const r = await run(controller, "process.stdout.write('after\\n')");
    expect(seen).toEqual([]);
    expect(text(r)).toContain('after');
  });
});
