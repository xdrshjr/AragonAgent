/**
 * Follow-through, mounted through the real `App`
 * (todo-plan-followthrough §3.4 / AC-7, AC-16..AC-22, AC-36, AC-40).
 *
 * The decision TABLE is tested purely in `todo-follow-through.test.ts`. What can
 * only be tested here is the WIRING: that the mode is read live rather than from
 * a captured `cfg`, that the end reason survives without a render between the
 * error and `agent_end`, that the timer fires through `submitMessage`, and that
 * all three cancellation triggers reach it.
 *
 * A SEPARATE FILE FROM `app.test.tsx` on purpose: these cases wait out a real
 * 3-second grace window, and folding them into a suite that runs in five would
 * quadruple its wall time for every unrelated change.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { AgentEvent, ModelInfo } from '@aragon-agent/core';

// Keep the app hermetic — never write the developer's real config file.
vi.mock('../config/store.js', () => ({
  updatePersistedConfig: vi.fn(() => ({})),
  getSessionsDir: () => '/tmp/aragon-sessions',
  getConfigPath: () => '/tmp/aragon-config.json',
  readConfigFile: () => ({ config: null }),
}));

const promptHistoryMock = vi.hoisted(() => ({ entries: [] as string[] }));
vi.mock('../config/prompt-history.js', () => ({
  loadPromptHistory: () => promptHistoryMock.entries,
  appendPrompt: (text: string) => {
    promptHistoryMock.entries = [
      ...promptHistoryMock.entries.filter((p) => p !== text),
      text,
    ];
    return promptHistoryMock.entries;
  },
}));
vi.mock('../config/ui-state.js', () => ({
  bumpSubmitCount: () => 1,
  setMouseNoticeSeen: () => {},
  getMouseNoticeSeen: () => true,
}));

beforeEach(() => {
  promptHistoryMock.entries = [];
});

const { App } = await import('../ui/App.js');
import type { AgentController } from '../agent/controller.js';
import {
  DEFAULT_LOG_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_SKILLS_RUNTIME,
  DEFAULT_TEAM_CONFIG,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_TODO_CONFIG,
  DEFAULT_BASH_CONFIG,
  type CliConfig,
  type TodoConfig,
} from '../config/schema.js';
import type { SkillService } from '../skills/service.js';
import type { AgentMode } from '../agent/agent-mode.js';
import type { TeamEvent, TeamSnapshot } from '../team/types.js';
import type { TodoEvent, TodoSnapshot } from '../todo/types.js';
import { offFastStatus, type FastStatus } from '../fast/wiring.js';
import { offCompactionSnapshot } from '../compaction/wiring.js';
import type {
  CompactionEvent,
  CompactionSnapshot,
  ContextUsageSnapshot,
} from '../compaction/types.js';
import type { FastEvent } from '../fast/types.js';
import type {
  ToolOutputEvent,
  ToolOutputListener,
} from '../tools/tool-output-store.js';
import type { ProcEvent, ProcEventListener } from '../proc/types.js';
import { DEFAULT_FAST_CONFIG, DEFAULT_UPDATE_CONFIG } from '../config/schema.js';

const delay = (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** Written as an escape, not a raw byte, so a stripping editor cannot silently
 *  turn these into tests that assert nothing and still pass. */
const ESC = '\u001B';

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/** Comfortably past `TODO_FOLLOW_LIMITS.graceMs` (3000). */
const PAST_GRACE = 3400;

const MODEL: ModelInfo = {
  id: 'm',
  name: 'M',
  provider: 'anthropic',
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  supportsThinking: true,
  supportsTools: true,
  supportsImages: false,
  cost: { input: 0, output: 0 },
};

const CONFIG: CliConfig = {
  fast: DEFAULT_FAST_CONFIG,
  update: DEFAULT_UPDATE_CONFIG,
  provider: 'anthropic',
  model: 'm',
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
  team: DEFAULT_TEAM_CONFIG,
  submitCount: 0,
  startInPlanMode: false,
  planModeMaxAskRounds: 4,
  planModeHumanTimeoutMs: 1_800_000,
  skills: DEFAULT_SKILLS_CONFIG,
  skillsRuntime: DEFAULT_SKILLS_RUNTIME,
  todo: DEFAULT_TODO_CONFIG,
  bash: DEFAULT_BASH_CONFIG,
  retry: DEFAULT_RETRY_CONFIG,
  // The NINTH nested section, and it is read at CONSTRUCTION by
  // `AgentController` — so a fixture without it crashes before the first
  // frame, exactly as the `todo` note above records.
  compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false },
  cwd: '/work',
  color: true,
  colorLevel: 3,
  unicode: true,
};

const EMPTY_SKILL_SERVICE = {
  list: () => [],
  untrustedDirs: () => [],
  getRegistry: () => ({ activeNames: [] as string[] }),
} as unknown as SkillService;

/**
 * The third hand-written `FakeController` in this package, and it carries the
 * same warning the other two do: it is handed over as
 * `fc as unknown as AgentController`, so a MISSING MEMBER IS NOT A COMPILE
 * ERROR — it is `controller.<x> is not a function` at mount or at the first
 * `agent_end`.
 */
class FakeController {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  onPrompt: ((text: string) => Promise<void>) | null = null;
  config: CliConfig = CONFIG;
  aborted = false;
  running = false;

  subscribe(l: (e: AgentEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: AgentEvent): void {
    for (const l of this.listeners) l(e);
  }
  getConfig(): CliConfig {
    return this.config;
  }
  hasApiKey(): boolean {
    return true;
  }
  setTheme(): void {}
  setSubmitCount(n: number): void {
    this.config = { ...this.config, submitCount: n };
  }
  getCwd(): string {
    return '/work';
  }
  getModelInfo(): ModelInfo {
    return MODEL;
  }
  /**
   * The fast tier (fast-model-tier §3.6). The App calls these on mount and in
   * its team/fast usage handlers, so a stub needs all four or every render
   * throws before the first frame — the SAME TypeScript blindness the note on
   * `subscribeTodos` below records: this class is handed over as
   * `fc as unknown as AgentController`, so an omission is not a compile error.
   */
  getModelInfoFor(): ModelInfo {
    return MODEL;
  }
  isPricedModel(): boolean {
    return true;
  }
  getFastStatus(): FastStatus {
    return offFastStatus();
  }
  fastListeners = new Set<(e: FastEvent) => void>();
  subscribeFast(l: (e: FastEvent) => void): () => void {
    this.fastListeners.add(l);
    return () => this.fastListeners.delete(l);
  }
  /**
   * Context compaction (context-auto-compaction §5.2). The App calls these on
   * mount, so a stub needs all three or every render throws before the first
   * frame — the SAME TypeScript blindness the fast note above records: this
   * class is handed over as `... as unknown as AgentController`, so an omission
   * is not a compile error.
   */
  isCompactionRegistered(): boolean {
    return false;
  }
  isCompactionEnabled(): boolean {
    return false;
  }
  /**
   * Context occupancy (context-usage-gauge-accuracy §4.2). The App subscribes on
   * mount and seeds from `getContextUsage()`, so a stub without both throws
   * before the first frame - the same TypeScript blindness the note above
   * records, since this class is handed over as `... as unknown as AgentController`.
   */
  contextUsageListeners = new Set<(u: ContextUsageSnapshot) => void>();
  subscribeContextUsage(l: (u: ContextUsageSnapshot) => void): () => void {
    this.contextUsageListeners.add(l);
    return () => this.contextUsageListeners.delete(l);
  }
  getContextUsage(): ContextUsageSnapshot {
    return {
      occupied: 0,
      window: 200_000,
      pct: 0,
      source: 'estimate',
      deltaTokens: 0,
      windowKnown: true,
      windowOverridden: false,
    };
  }
  getCompactionSnapshot(): CompactionSnapshot {
    return offCompactionSnapshot();
  }
  getCompactionSummarizerRef(): null {
    return null;
  }
  compactionListeners = new Set<(e: CompactionEvent) => void>();
  subscribeCompaction(l: (e: CompactionEvent) => void): () => void {
    this.compactionListeners.add(l);
    return () => this.compactionListeners.delete(l);
  }
  emitCompaction(e: CompactionEvent): void {
    for (const l of this.compactionListeners) l(e);
  }
  emitFast(e: FastEvent): void {
    for (const l of this.fastListeners) l(e);
  }
  getModelRegistry() {
    return { getModel: () => undefined, getModels: () => [] };
  }
  preflight() {
    return { ok: true as const };
  }
  abort(): void {
    this.aborted = true;
  }
  steer(): void {}
  prompt(text: string): Promise<void> {
    return this.onPrompt ? this.onPrompt(text) : Promise.resolve();
  }
  isRunning(): boolean {
    return this.running;
  }
  getSkillService(): SkillService {
    return EMPTY_SKILL_SERVICE;
  }
  setOnSkillsChanged(): void {}
  /**
   * The diff side channel (agent-activity-presentation §3.3.7). `App` memoizes a
   * `PatchSource` over this and calls it on EVERY `tool_execution_end`, so a stub
   * without it throws `controller.takeFilePatch is not a function` the first time
   * a tool finishes — and the cast above means TypeScript cannot say so.
   *
   * This suite does not emit a tool event today. The method is here because the
   * one that does (`app.test.tsx`) is a SEPARATE hand-written stub, so the day a
   * follow-through case grows a tool call is the day this file would fail for a
   * reason nowhere near what it was testing.
   */
  takeFilePatch(): undefined {
    return undefined;
  }

  /**
   * The live tool-output side channel (agent-activity-presentation-live §3.1.3),
   * here for the reason stated one comment up and one round later: `App`
   * subscribes UNCONDITIONALLY on mount, so a stub without this throws
   * `controller.subscribeToolOutput is not a function` before the first frame,
   * and the cast means TypeScript cannot say so (R-4).
   */
  outputListeners = new Set<ToolOutputListener>();
  subscribeToolOutput(l: ToolOutputListener): () => void {
    this.outputListeners.add(l);
    return () => this.outputListeners.delete(l);
  }
  emitToolOutput(event: ToolOutputEvent): void {
    for (const l of this.outputListeners) l(event);
  }

  /**
   * The CLI-local background-service stream (background-service-supervision
   * §3.8). `App` subscribes on mount UNCONDITIONALLY - the supervisor exists
   * whether or not services are on - so a stub that omits this throws
   * `controller.subscribeProc is not a function` before the first frame, and,
   * per the note above, TypeScript cannot catch that.
   */
  procListeners = new Set<ProcEventListener>();
  subscribeProc(l: ProcEventListener): () => void {
    this.procListeners.add(l);
    return () => this.procListeners.delete(l);
  }
  emitProc(event: ProcEvent): void {
    for (const l of this.procListeners) l(event);
  }
  /** Rung two of the Esc ladder; counted so the ladder tests can assert on it. */
  forceStopCalls = 0;
  runGen = 0;
  get runGeneration(): number {
    return this.runGen;
  }
  forceStop(): void {
    this.forceStopCalls += 1;
    this.runGen += 1;
    this.aborted = true;
  }
  stopAllServicesCalls: Array<{ force?: boolean }> = [];
  stopAllServices(opts: { force?: boolean } = {}): Promise<never[]> {
    this.stopAllServicesCalls.push(opts);
    return Promise.resolve([]);
  }
  isBackgroundRegistered(): boolean {
    return true;
  }
  listServices(): never[] {
    return [];
  }
  liveServiceCount(): number {
    return 0;
  }
  reapServicesSync(): void {}

  teamListeners = new Set<(e: TeamEvent) => void>();
  subscribeTeam(l: (e: TeamEvent) => void): () => void {
    this.teamListeners.add(l);
    return () => this.teamListeners.delete(l);
  }
  getTeamSnapshot(): TeamSnapshot | null {
    return null;
  }
  dispose(): void {}

  todoListeners = new Set<(e: TodoEvent) => void>();
  subscribeTodos(l: (e: TodoEvent) => void): () => void {
    this.todoListeners.add(l);
    return () => this.todoListeners.delete(l);
  }
  emitTodo(e: TodoEvent): void {
    for (const l of this.todoListeners) l(e);
  }
  todoSnapshot: TodoSnapshot | null = null;
  getTodoSnapshot(): TodoSnapshot | null {
    return this.todoSnapshot;
  }
  /** Replaced WHOLESALE by `/todo follow`, exactly as `setTodoConfig` does. */
  todoConfig: TodoConfig = { ...DEFAULT_TODO_CONFIG };
  getTodoConfig(): TodoConfig {
    return this.todoConfig;
  }

  agentMode: AgentMode = 'build';
  getAgentMode(): AgentMode {
    return this.agentMode;
  }
  setAgentMode(next: AgentMode) {
    this.agentMode = next;
    return { effective: next, pending: null };
  }
  applyPendingMode() {
    return null;
  }
  getPlanStatus() {
    return { effective: this.agentMode, pending: null, askRoundsUsed: 0, maxAskRounds: 4 };
  }
}

function mount(fc: FakeController, extra: { initialPrompt?: string } = {}) {
  return render(
    <App
      controller={fc as unknown as AgentController}
      version="0.0.0"
      mode="inline"
      initialPrompt={extra.initialPrompt}
    />,
  );
}

const PLAN: TodoSnapshot = {
  items: [
    { content: 'Read the reducer', activeForm: 'Reading the reducer', status: 'completed' },
    { content: 'Design the store', activeForm: 'Designing the store', status: 'in_progress' },
    { content: 'Add the test', activeForm: 'Adding the test', status: 'pending' },
  ],
  total: 3,
  doneCount: 1,
  activeIndex: 1,
  updatedAt: 1,
};

/** A run that ends leaving `PLAN` unfinished. */
function planRun(fc: FakeController, opts: { errored?: boolean } = {}): () => Promise<void> {
  return async () => {
    fc.emit({ type: 'agent_start' } as AgentEvent);
    fc.todoSnapshot = PLAN;
    fc.emitTodo({ type: 'updated', snapshot: PLAN });
    if (opts.errored) {
      // THE SAME-TICK SEQUENCE AC-40 IS ABOUT: a stream error immediately
      // followed by `agent_end`, with no render between them. Core does exactly
      // this — it throws in the loop and emits `agent_end` from
      // `runLoopWithLifecycle`'s `finally`, microtasks apart.
      fc.emit({
        type: 'message_update',
        streamEvent: { type: 'error', error: new Error('401 unauthorized') },
      } as AgentEvent);
    } else {
      fc.emit({
        type: 'turn_end',
        message: { role: 'assistant', content: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      } as AgentEvent);
    }
    fc.emit({ type: 'agent_end', messages: [] } as AgentEvent);
  };
}

/** A controller whose first run leaves `PLAN` unfinished and records re-prompts. */
function armedController(): { fc: FakeController; seen: string[] } {
  const fc = new FakeController();
  fc.todoConfig = { ...fc.todoConfig, followThrough: 'auto' };
  const seen: string[] = [];
  fc.onPrompt = async (text) => {
    seen.push(text);
    if (seen.length > 1) return;
    await planRun(fc)();
  };
  return { fc, seen };
}

describe('the decision reaches the transcript', () => {
  it('AC-1: the default mode still prints round 1s notice, unchanged', async () => {
    const fc = new FakeController();
    fc.onPrompt = planRun(fc);
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(150);
    expect(stripAnsi(lastFrame() ?? '')).toContain('2 todo items are unfinished');
    unmount();
  });

  it('AC-36 (P1-1): `auto` set MID-SESSION changes the very next decision', async () => {
    // The regression test for reading the mode through
    // `controller.getTodoConfig()` rather than the `cfg` the subscription effect
    // captured at mount. With a captured `cfg` the second run below still prints
    // the `notify` notice and `/todo follow auto` is inert until relaunch — the
    // defect class this package has paid for twice.
    const fc = new FakeController();
    fc.onPrompt = planRun(fc);
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(150);
    expect(stripAnsi(lastFrame() ?? '')).toContain('2 todo items are unfinished');

    // What `/todo follow auto` does: `setTodoConfig` replaces the OBJECT, so a
    // closure holding the old one can never observe this.
    fc.todoConfig = { ...fc.todoConfig, followThrough: 'auto' };
    await fc.prompt('again');
    await delay(150);
    expect(stripAnsi(lastFrame() ?? '')).toContain('Continuing with 2 remaining steps');
    unmount();
  });

  it('AC-40 (P1-6): an error in the SAME TICK as agent_end never continues', async () => {
    const fc = new FakeController();
    fc.todoConfig = { ...fc.todoConfig, followThrough: 'auto' };
    fc.onPrompt = planRun(fc, { errored: true });
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(150);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('ended with an error');
    expect(frame).not.toContain('Continuing with');
    unmount();
  });

  it('AC-7: an ABORTED run says nothing at all', async () => {
    const fc = new FakeController();
    fc.todoConfig = { ...fc.todoConfig, followThrough: 'auto' };
    fc.onPrompt = async () => {
      fc.running = true;
      fc.emit({ type: 'agent_start' } as AgentEvent);
      fc.todoSnapshot = PLAN;
      fc.emitTodo({ type: 'updated', snapshot: PLAN });
    };
    const { lastFrame, stdin, unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(150);
    // Esc while running: `controller.abort()` + `abortMark` + the ref.
    stdin.write(ESC);
    await delay(60);
    expect(fc.aborted).toBe(true);
    fc.running = false;
    fc.emit({ type: 'agent_end', messages: [] } as AgentEvent);
    await delay(150);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Run aborted.');
    expect(frame).not.toContain('unfinished');
    expect(frame).not.toContain('Continuing with');
    unmount();
  });
});

describe('arming, firing and cancelling', () => {
  it('AC-16 + AC-17: the armed continuation submits the ENUMERATED message', async () => {
    const { fc, seen } = armedController();
    const { unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(PAST_GRACE);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('These steps are not done yet:');
    expect(seen[1]).toContain('2. Design the store');
    expect(seen[1]).toContain('3. Add the test');
    expect(seen[1]).not.toBe('Continue with the remaining todo items.');
    // AC-17: the auto-continuation must not reach `recordPrompt`, whose two
    // effects are the history append and the `submitCount` bump. Only the user's
    // own 'go' is recorded.
    expect(promptHistoryMock.entries).toEqual(['go']);
    unmount();
  }, 15_000);

  it('AC-18: Esc during the grace window cancels, and no prompt is issued', async () => {
    const { fc, seen } = armedController();
    const { lastFrame, stdin, unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(250);
    expect(stripAnsi(lastFrame() ?? '')).toContain('Continuing with');
    stdin.write(ESC);
    // ASSERTED BEFORE THE WAIT, not after: the toast auto-dismisses on its own
    // TTL, so checking it at the far side of a 3.4 s sleep would test the toast
    // timer rather than the cancellation.
    await delay(80);
    expect(stripAnsi(lastFrame() ?? '')).toContain('Auto-continue cancelled.');
    await delay(PAST_GRACE);
    expect(seen).toHaveLength(1);
    unmount();
  }, 15_000);

  it('AC-19: a user submit during the grace window wins', async () => {
    const { fc, seen } = armedController();
    const { stdin, unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(250);
    // The text and the Enter go SEPARATELY: Ink hands `useInput` a whole stdin
    // chunk as one key event, so a combined write arrives as a single keypress
    // whose `input` happens to end in a carriage return — which the composer
    // reads as one very long line rather than as "type, then submit".
    stdin.write('never mind');
    await delay(60);
    stdin.write('\r');
    await delay(PAST_GRACE);
    expect(seen).toEqual(['go', 'never mind']);
    unmount();
  }, 15_000);

  it('AC-22: a list finished during the grace window cancels the submit', async () => {
    const { fc, seen } = armedController();
    const { unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(250);
    // The list moved under the timer: everything is done now.
    fc.todoSnapshot = { ...PLAN, doneCount: 3, activeIndex: -1 };
    await delay(PAST_GRACE);
    expect(seen).toHaveLength(1);
    unmount();
  }, 15_000);

  it('AC-20: `isRunning()` at fire time suppresses the submit (C-6)', async () => {
    const { fc, seen } = armedController();
    const { unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(250);
    // Something else started a run inside the window. Without this check the
    // continuation is either swallowed into `steer()` or reaches `prompt()`,
    // which REJECTS while running.
    fc.running = true;
    await delay(PAST_GRACE);
    expect(seen).toHaveLength(1);
    unmount();
  }, 15_000);

  it('AC-21: unmounting during the grace window leaves no pending prompt', async () => {
    const { fc, seen } = armedController();
    const { unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(250);
    unmount();
    await delay(PAST_GRACE);
    expect(seen).toHaveLength(1);
  }, 15_000);
});
