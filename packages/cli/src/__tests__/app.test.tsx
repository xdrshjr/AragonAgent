import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { AgentEvent, ModelInfo } from '@aragon-agent/core';

// Keep the app hermetic — never write the developer's real config file.
vi.mock('../config/store.js', () => ({
  updatePersistedConfig: vi.fn(() => ({})),
  getSessionsDir: () => '/tmp/aragon-sessions',
  getConfigPath: () => '/tmp/aragon-config.json',
  // `useStartupNotices` asks whether config.json parsed; a healthy file is the
  // right default here, since none of these cases is about that failure.
  readConfigFile: () => ({ config: null }),
}));

/**
 * The prompt history and the UI counters are FILES now, and `App` reads and
 * writes them directly — so without these two mocks every submit in this suite
 * would append to a real `prompt-history.jsonl` and rewrite a real
 * `state.json` under the vitest temp root.
 *
 * `history` is a `let` inside the factory rather than an outer variable because
 * `vi.mock` factories are hoisted above every module-level statement.
 */
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

// The history mock is module state shared by every case in this file; a submit
// in one must not become a recall in the next.
beforeEach(() => {
  promptHistoryMock.entries = [];
});

const { App } = await import('../ui/App.js');
const { runHeadless } = await import('../agent/headless.js');
const { frameHeight } = await import('../ui/layout/frame.js');
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
import type { HeadlessController } from '../agent/headless.js';
import type { RenderMode } from '../ui/layout/frame.js';
import type { AgentMode } from '../agent/agent-mode.js';
import type { TeamEvent, TeamSnapshot } from '../team/types.js';
import type { TodoEvent, TodoSnapshot } from '../todo/types.js';
import { normalizePlan, normalizeQuestions } from '../tools/human-input.js';
import type { HumanInputBridge, HumanResponse } from '../tools/human-input.js';
import type {
  UpdateBridge,
  UpdateServiceHandle,
  UpdateSnapshot,
} from '../update/types.js';
import { offFastStatus, type FastStatus } from '../fast/wiring.js';
import { offCompactionSnapshot } from '../compaction/wiring.js';
import type { CompactionEvent, CompactionSnapshot } from '../compaction/types.js';
import type { FastEvent } from '../fast/types.js';
import type {
  ToolOutputEvent,
  ToolOutputListener,
} from '../tools/tool-output-store.js';
import type { ProcEvent, ProcEventListener } from '../proc/types.js';
import { ACTIVITY_PHRASES, pickActivityPhrase } from '../ui/activity-phrases.js';
import { DEFAULT_FAST_CONFIG, DEFAULT_UPDATE_CONFIG } from '../config/schema.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Written as an escape, not a raw byte, so an editor that stripped the control
 *  character could not leave a test that asserts nothing and still passes. */
const ESC = '\u001B';

/** The gradient wordmark colors every character separately, so assertions on
 *  brand text have to look at the plain glyphs. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

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
  // The three keys `CliConfig` grew after this fixture was written. Absent, they
  // are a typecheck error and NOTHING ELSE — `tsconfig.json` excludes this tree
  // and vitest transpiles without checking, which is the standing debt
  // `tsconfig.test.json` now closes (todo-plan-followthrough W3).
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
  // Read at RENDER time by the rail gate (todo-plan-execution §3.9), so a
  // fixture without it crashes the first full-screen frame.
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

/**
 * The narrow slice of `SkillService` the App touches while mounting: command
 * registration reads `list()`, the trust-gate effect reads `untrustedDirs()`.
 * Kept as a stub rather than a real service so these tests never touch the
 * developer's actual skills directory.
 */
const EMPTY_SKILL_SERVICE = {
  list: () => [],
  untrustedDirs: () => [],
  getRegistry: () => ({ activeNames: [] as string[] }),
} as unknown as SkillService;

class FakeController {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  aborted = false;
  onPrompt: ((text: string) => Promise<void>) | null = null;
  config: CliConfig = CONFIG;

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
  getSkillService(): SkillService {
    return EMPTY_SKILL_SERVICE;
  }
  setOnSkillsChanged(): void {}
  /**
   * The diff side channel (agent-activity-presentation §3.3.7). `App` memoizes a
   * `PatchSource` over this and calls it on every `tool_execution_end`, so a stub
   * that omits it throws `controller.takeFilePatch is not a function` the first
   * time a tool finishes — and, per the note below, TypeScript cannot catch that.
   * `undefined` is the ordinary answer for a tool that recorded nothing.
   */
  takeFilePatch(): undefined {
    return undefined;
  }

  /**
   * The live tool-output side channel (agent-activity-presentation-live §3.1.3).
   * `App` subscribes to it on mount, unconditionally, so a stub that omits it
   * throws `controller.subscribeToolOutput is not a function` before the first
   * frame — and, per the note below, TypeScript cannot catch that (R-4).
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

  // --- Team mode. The App subscribes to the CLI-local team stream on mount and
  // disposes the runtime on unmount, so a controller stub needs both or every
  // render throws before the first frame (team-subagents §5.2 / R-15). ---
  teamListeners = new Set<(e: TeamEvent) => void>();
  subscribeTeam(l: (e: TeamEvent) => void): () => void {
    this.teamListeners.add(l);
    return () => this.teamListeners.delete(l);
  }
  emitTeam(e: TeamEvent): void {
    for (const l of this.teamListeners) l(e);
  }
  getTeamSnapshot(): TeamSnapshot | null {
    return this.teamSnapshot;
  }
  teamSnapshot: TeamSnapshot | null = null;
  dispose(): void {}

  // --- Todo planning. The App subscribes to the CLI-local todo stream on mount
  // and reads the snapshot at every `agent_end`, so a controller stub needs both
  // or every render throws before the first frame (todo-plan-execution §5.2).
  //
  // NOTE THAT TYPESCRIPT CANNOT CATCH THE OMISSION (P1-5): this class is handed
  // over as `fc as unknown as AgentController`, so a missing member is not a
  // compile error — it is `controller.subscribeTodos is not a function` at
  // mount. There is a SECOND hand-written `FakeController` in
  // `mouse-routing.test.tsx` with the same cast and the same exposure.
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
  /**
   * READ LIVE AT EVERY `agent_end` (todo-plan-followthrough §3.4 / P1-1), which
   * is the whole reason the App does not use the `cfg` its subscription effect
   * captured. Mutable here so a test can change the mode MID-SESSION and assert
   * that the very next decision sees it (AC-36) — which is exactly what a
   * captured `cfg` could never do.
   *
   * The same TypeScript blindness the note above records applies: this member is
   * not compile-checked either, and its omission is
   * `controller.getTodoConfig is not a function` at the first run's end.
   */
  todoConfig: TodoConfig = { ...DEFAULT_TODO_CONFIG };
  getTodoConfig(): TodoConfig {
    return this.todoConfig;
  }
  /**
   * Re-checked AT FIRE TIME by the grace timer (C-6), not only at decision time:
   * the window is 3 s and the user can type in it. Backed by the same `running`
   * flag the plan-mode branch below reads, so a test that sets one gets both.
   */
  isRunning(): boolean {
    return this.running;
  }

  // --- Plan mode. The App reads the mode from its OWNER on mount and after
  // every run, so these three are not optional for a controller stub. ---
  agentMode: AgentMode = 'build';
  pendingMode: AgentMode | null = null;
  /** Set by the tests that exercise a mid-run toggle. */
  running = false;
  getAgentMode(): AgentMode {
    return this.agentMode;
  }
  setAgentMode(next: AgentMode, opts: { force?: boolean } = {}) {
    // Same asymmetry as the real controller: tightening lands now, loosening
    // waits for `agent_end` unless it was forced by a plan approval.
    if (next === 'plan') {
      this.agentMode = 'plan';
      this.pendingMode = null;
    } else if (this.agentMode === 'build' || opts.force || !this.running) {
      this.agentMode = 'build';
      this.pendingMode = null;
    } else {
      this.pendingMode = 'build';
    }
    return { effective: this.agentMode, pending: this.pendingMode };
  }
  applyPendingMode() {
    if (!this.pendingMode) return null;
    this.agentMode = this.pendingMode;
    this.pendingMode = null;
    return { effective: this.agentMode, pending: null };
  }
  getPlanStatus() {
    return {
      effective: this.agentMode,
      pending: this.pendingMode,
      askRoundsUsed: 0,
      maxAskRounds: 4,
    };
  }
}

function mount(
  fc: FakeController,
  extra: {
    initialPrompt?: string;
    mode?: RenderMode;
    humanInputBridge?: HumanInputBridge;
    updateBridge?: UpdateBridge;
  } = {},
) {
  return render(
    <App
      controller={fc as unknown as AgentController}
      version="0.0.0"
      mode={extra.mode ?? 'inline'}
      initialPrompt={extra.initialPrompt}
      humanInputBridge={extra.humanInputBridge}
      updateBridge={extra.updateBridge}
    />,
  );
}

describe('App (interactive)', () => {
  it('streams assistant text, renders a tool card, and a status bar', async () => {
    const fc = new FakeController();
    fc.onPrompt = async () => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'Hello' } });
      fc.emit({ type: 'message_update', streamEvent: { type: 'tool_call_start', toolCallId: 't1', toolName: 'bash' } });
      fc.emit({
        type: 'message_update',
        streamEvent: { type: 'tool_call_end', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } },
      });
      fc.emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, usage: { inputTokens: 100, outputTokens: 20 } });
      fc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} });
      fc.emit({
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'ok' }] },
        isError: false,
        duration: 5,
      });
      fc.emit({ type: 'agent_end', messages: [] });
    };

    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'hi' });
    await delay(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Hello');
    expect(frame).toContain('bash');
    expect(frame).toContain('anthropic');
    unmount();
  });

  it('routes /help to the help overlay', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { initialPrompt: '/help' });
    await delay(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Help');
    expect(frame).toContain('Keybindings');
    expect(frame).toContain('Esc close');
    unmount();
  });

  it('aborts the run on Esc', async () => {
    const fc = new FakeController();
    fc.onPrompt = () =>
      new Promise<void>(() => {
        fc.emit({ type: 'agent_start' });
        fc.emit({ type: 'turn_start' });
      });
    const { stdin, unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(40);
    stdin.write('\u001B'); // Esc key (escape)
    await delay(40);
    expect(fc.aborted).toBe(true);
    unmount();
  });

  it('renders the session opener and a context gauge on an empty session', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc);
    await delay(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Full permission, no sandbox');
    expect(frame).toContain('%'); // status-bar context gauge
    unmount();
  });

  it('renders a sign-prefixed diff for an edit_file tool', async () => {
    const fc = new FakeController();
    fc.onPrompt = async () => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({ type: 'message_update', streamEvent: { type: 'tool_call_start', toolCallId: 't1', toolName: 'edit_file' } });
      fc.emit({
        type: 'message_update',
        streamEvent: { type: 'tool_call_end', toolCallId: 't1', toolName: 'edit_file', args: { path: 'a.ts' } },
      });
      fc.emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, usage: { inputTokens: 1, outputTokens: 1 } });
      fc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit_file', args: {} });
      fc.emit({
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'edit_file',
        result: { content: [{ type: 'text', text: 'Applied edit to a.ts:\n--- a.ts\n+++ a.ts\n- old line\n+ new line' }] },
        isError: false,
        duration: 3,
      });
      fc.emit({ type: 'agent_end', messages: [] });
    };
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'edit it' });
    await delay(40);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('- old line');
    expect(frame).toContain('+ new line');
    unmount();
  });

  it('expands the most recent tool card on Ctrl+O', async () => {
    const fc = new FakeController();
    const longText = Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join('\n');
    fc.onPrompt = async () => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({ type: 'message_update', streamEvent: { type: 'tool_call_start', toolCallId: 't1', toolName: 'read_file' } });
      fc.emit({
        type: 'message_update',
        streamEvent: { type: 'tool_call_end', toolCallId: 't1', toolName: 'read_file', args: { path: 'a.txt' } },
      });
      fc.emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, usage: { inputTokens: 1, outputTokens: 1 } });
      fc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read_file', args: {} });
      fc.emit({
        type: 'tool_execution_end',
        toolCallId: 't1',
        toolName: 'read_file',
        result: { content: [{ type: 'text', text: longText }] },
        isError: false,
        duration: 3,
      });
      fc.emit({ type: 'agent_end', messages: [] });
    };
    const { lastFrame, stdin, unmount } = mount(fc, { initialPrompt: 'read it' });
    await delay(40);
    expect(lastFrame() ?? '').toContain('+4'); // "+4 lines (Ctrl+O)" collapsed footer
    stdin.write(''); // Ctrl+O
    await delay(40);
    expect(lastFrame() ?? '').toContain('L12'); // full preview now visible
    unmount();
  });

  it('shows a transient toast for a slash-command ack', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { initialPrompt: '/theme cool' });
    await delay(40);
    expect(lastFrame() ?? '').toContain('Theme set to cool');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// The human-input bridge (plan-mode §3.5)
// ---------------------------------------------------------------------------

const PLAN = normalizePlan({
  title: 'Add SSO via OIDC',
  summary: 'Introduces an oidc provider module.',
  steps: [{ title: 'Implement src/auth/oidc.ts', detail: 'Token exchange.' }],
})!;

const QUESTIONS = normalizeQuestions([
  {
    id: 'store',
    header: 'Datastore',
    question: 'Which datastore should the new service use?',
    options: [{ label: 'Postgres', recommended: true }, { label: 'SQLite' }],
  },
]);

/** A bridge in the shape `cli.tsx` builds one: the App fills both fields in. */
const makeBridge = (): HumanInputBridge => ({ handler: null, cancelPending: () => {} });

/** A controller stuck mid-run, which is the only state either test is about. */
function runningController(mode: AgentMode = 'plan'): FakeController {
  const fc = new FakeController();
  fc.agentMode = mode;
  fc.running = true;
  fc.onPrompt = () =>
    new Promise<void>(() => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
    });
  return fc;
}

describe('human-input bridge', () => {
  it('AC-P25: dismissing a plan card keeps the run alive; a second Esc is the way out', async () => {
    // The two halves are one criterion on purpose. `submit_plan` has no round
    // budget and its dismissal result tells the model to refine and resubmit,
    // so `esc dismiss` names the LOOP. The exit is Esc again with no overlay
    // open, and it is the only one short of Ctrl+C — testing either half alone
    // would leave the user-visible gap unpinned (R2-P1-4).
    const fc = runningController();
    const bridge = makeBridge();
    const { lastFrame, stdin, unmount } = mount(fc, { initialPrompt: 'plan it', humanInputBridge: bridge });
    await delay(60);

    let settled: HumanResponse | null | undefined;
    const waiting = bridge.handler!({ kind: 'plan', plan: PLAN }).then((v) => {
      settled = v;
    });
    await delay(60);
    expect(stripAnsi(lastFrame() ?? '')).toContain('Review plan');

    stdin.write(ESC); // dismiss the card
    await delay(60);
    await waiting;

    expect(settled).toBeNull(); // the tool is told "no verdict"...
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('Review plan');
    expect(fc.aborted).toBe(false); // ...and the run it belongs to is still alive
    expect(fc.getAgentMode()).toBe('plan'); // a dismissal is not an approval

    stdin.write(ESC); // no overlay open now: THIS is the exit
    await delay(60);
    expect(fc.aborted).toBe(true);
    unmount();
  });

  it('I-P11: settles every outstanding request, though only the last one renders', async () => {
    // The bridge holds pending entries in a Set but has ONE render slot and
    // answers every entry with the one response it has, so it is correct only
    // while at most one request is outstanding. Nothing in this package
    // enforces that: it comes from `@aragon-agent/core`'s agent loop executing
    // tool calls in a `for...of` with an inner `await`, one run at a time.
    // Asserted here because a comment in the CLI cannot fail when the engine
    // changes — if this goes red, the bridge needs a `Map<requestId, Entry>`
    // and a request-id round trip BEFORE the concurrency lands, or one tool
    // starts answering another tool's question and it presents as a model error.
    const fc = runningController();
    const bridge = makeBridge();
    const { lastFrame, stdin, unmount } = mount(fc, { initialPrompt: 'plan it', humanInputBridge: bridge });
    await delay(60);

    const first = bridge.handler!({ kind: 'questions', questions: QUESTIONS });
    const second = bridge.handler!({ kind: 'plan', plan: PLAN });
    await delay(60);

    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Review plan'); // last writer renders...
    expect(frame).not.toContain('Which datastore'); // ...and the first is off screen

    stdin.write(ESC);
    await delay(60);
    expect(await first).toBeNull(); // both entries settled: no promise dangles
    expect(await second).toBeNull();
    unmount();
  });
});

describe('App (fullscreen frame)', () => {
  // `mode` MUST be passed explicitly. `ink-testing-library`'s stdout stub has no
  // `isTTY` (its `class Stdout` exposes only a `columns` getter), so
  // `decideRenderMode` would return 'inline' forever and this whole block would
  // silently be testing the fallback path instead of the frame it claims to.
  it('pins the composer and status bar to the bottom of a fixed-height frame (R2)', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(60);

    const lines = (lastFrame() ?? '').split('\n');
    // The stub reports no `rows`, so the frame falls back to 24 → height 23.
    expect(lines).toHaveLength(frameHeight(undefined));
    expect(lines).toHaveLength(23);

    // Row 1 always carries the brand (R1).
    expect(stripAnsi(lines[0] ?? '')).toContain('◇');
    expect(stripAnsi(lines[0] ?? '')).toContain('AragonAgent');
    // The status bar is literally the last row of the frame.
    expect(stripAnsi(lines[lines.length - 1] ?? '')).toMatch(/idle/);
    // The composer sits directly above it, inside the last 5 rows.
    expect(stripAnsi(lines.slice(-5, -2).join('\n'))).toContain('❯');
    unmount();
  });

  it('keeps the frame strictly shorter than the terminal (invariant I-1)', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(60);
    const lines = (lastFrame() ?? '').split('\n');
    expect(lines.length).toBeLessThan(24);
    unmount();
  });

  it('does not recall prompt history on Shift+Up (the viewport owns it)', async () => {
    const fc = new FakeController();
    // Seeded through the history STORE, not `CliConfig`: the recall list left
    // the resolved config in config-state-separation §4.1.
    promptHistoryMock.entries = ['a remembered prompt'];
    const { lastFrame, stdin, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(60);

    stdin.write('[1;2A'); // Shift+Up
    await delay(40);
    expect(lastFrame() ?? '').not.toContain('a remembered prompt');

    stdin.write('[A'); // plain Up still recalls
    await delay(40);
    expect(lastFrame() ?? '').toContain('a remembered prompt');
    unmount();
  });

  // --- The mode toggle, driven by BYTES rather than by calling the handler.
  //
  // This whole path shipped with no automated protection at all: the only thing
  // asserting `Shift+Tab` worked was the existence of one `if` in `App`, while
  // the two layers that actually break - the console delivering `\x1b[Z`, and
  // ink turning it into `{tab, shift}` - had nothing (shift-tab-mode-toggle-
  // still-dead-on-windows, section 3.8). The bug was reported twice before
  // anybody noticed the gap, so these are written as escapes rather than raw
  // control bytes: an editor that stripped the byte would otherwise leave a test
  // that asserts nothing and still passes.
  it('toggles plan mode on CSI Z, the real Shift+Tab byte sequence', async () => {
    const fc = new FakeController();
    const { stdin, unmount } = mount(fc);
    await delay(60);

    stdin.write(`${ESC}[Z`);
    await delay(40);
    expect(fc.agentMode).toBe('plan');

    stdin.write(`${ESC}[Z`);
    await delay(40);
    expect(fc.agentMode).toBe('build');
    unmount();
  });

  it('toggles plan mode on Ctrl+P, the rung that survives a lossy console', async () => {
    // `0x10` is what a Windows console emits for `Ctrl+P` even on the libuv path
    // that destroys `Shift+Tab` - measured, not assumed (analysis section 3.6).
    // If this ever stops toggling, the fallback is decorative and the affected
    // machines are back to having no working mode toggle at all.
    const fc = new FakeController();
    const { stdin, unmount } = mount(fc);
    await delay(60);

    stdin.write('\u0010'); // Ctrl+P
    await delay(40);
    expect(fc.agentMode).toBe('plan');
    unmount();
  });

  it('does not toggle on a plain Tab', async () => {
    // The distinction this pins is the whole bug: on an affected console
    // `Shift+Tab` ARRIVES as this byte. A branch that fired here would "work"
    // everywhere and make the mode uncontrollable by anyone using Tab to
    // complete a path.
    const fc = new FakeController();
    const { stdin, unmount } = mount(fc);
    await delay(60);

    stdin.write('\t');
    await delay(40);
    expect(fc.agentMode).toBe('build');
    unmount();
  });

  it('repaints on Ctrl+L instead of leaving a blank screen (I-5)', async () => {
    const fc = new FakeController();
    const { lastFrame, frames, stdin, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(60);

    const before = frames.length;
    const previous = lastFrame();
    stdin.write('\f'); // Ctrl+L
    await delay(60);

    // Other pending React effects can flush an additional frame under full-suite
    // load. Ctrl+L promises a real repaint, not a globally exact render count.
    expect(frames.length).toBeGreaterThan(before);
    const repaint = lastFrame() ?? '';
    expect(repaint.length).toBeGreaterThan(0);
    // Not merely "a frame happened": the bytes must differ, or Ink's two dedupe
    // gates (ink.js:132 + log-update.js:13) would have swallowed the repaint.
    expect(repaint).not.toBe(previous);
    // …and the change must be invisible: same rows, same trimmed content.
    expect(repaint.split('\n')).toHaveLength((previous ?? '').split('\n').length);
    unmount();
  });

  it('actually scrolls when the content overflows the viewport (invariant I-2)', async () => {
    // This is the behavioral form of the `flexShrink={0}` assertion: drop it and
    // yoga squeezes the content to the viewport height, `measureElement` reports
    // content === viewport, overflow is permanently 0, and PgUp becomes a silent
    // no-op. Nothing throws — the frame simply stops moving.
    const fc = new FakeController();
    const long = Array.from({ length: 60 }, (_, i) => `LINE${i + 1}`).join('\n');
    fc.onPrompt = async () => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: long } });
      fc.emit({
        type: 'turn_end',
        message: { role: 'assistant', content: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      fc.emit({ type: 'agent_end', messages: [] });
    };

    const { lastFrame, stdin, unmount } = mount(fc, { mode: 'fullscreen', initialPrompt: 'go' });
    await delay(120);

    const pinned = stripAnsi(lastFrame() ?? '');
    expect(pinned).toContain('LINE60'); // pinned to the newest output
    expect(pinned).not.toMatch(/↑\d/); // …so no off-bottom indicator yet

    stdin.write('[5~'); // PgUp
    await delay(120);

    const scrolled = stripAnsi(lastFrame() ?? '');
    expect(scrolled).not.toBe(pinned);
    expect(scrolled).not.toContain('LINE60'); // the tail scrolled away
    expect(scrolled).toMatch(/↑\d/); // status bar reports the distance

    stdin.write('[6~'); // PgDn back to the bottom
    await delay(120);

    const repinned = stripAnsi(lastFrame() ?? '');
    expect(repinned).toContain('LINE60');
    expect(repinned).not.toMatch(/↑\d/);
    unmount();
  });

  it('renders a placeholder instead of a broken frame when the terminal is too short', async () => {
    const fc = new FakeController();
    const { stdout, lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(60);

    Object.defineProperty(stdout, 'rows', { value: 8, configurable: true });
    stdout.emit('resize');
    await delay(120); // resize is throttled 50 ms

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Terminal too small');
    // Still strictly shorter than the 8 rows we now claim to have.
    expect(frame.split('\n').length).toBeLessThan(8);
    unmount();
  });
});

describe('overlay frame (A-2b / A-2c)', () => {
  it('swallows PgUp so the transcript does not jump when the overlay closes', async () => {
    // R-P1-7. `ScrollViewport` is unmounted while an overlay is open, but its
    // scroll-intent effect fires once on REMOUNT -- so an intent registered
    // during the overlay was applied the moment the overlay closed, and the
    // transcript jumped a page for no reason the user could connect to.
    const fc = new FakeController();
    const long = Array.from({ length: 60 }, (_, i) => `LINE${i + 1}`).join('\n');
    fc.onPrompt = async () => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: long } });
      fc.emit({
        type: 'turn_end',
        message: { role: 'assistant', content: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      fc.emit({ type: 'agent_end', messages: [] });
    };

    const { lastFrame, stdin, unmount } = mount(fc, { mode: 'fullscreen', initialPrompt: 'go' });
    await delay(120);
    expect(stripAnsi(lastFrame() ?? '')).toContain('LINE60');

    stdin.write('?'); // opens help on an empty idle input
    await delay(80);
    expect(stripAnsi(lastFrame() ?? '')).toContain('Keybindings');

    stdin.write('[5~'); // PgUp - must not reach the transcript
    await delay(80);
    stdin.write(''); // Esc closes the overlay
    await delay(120);

    const after = stripAnsi(lastFrame() ?? '');
    expect(after).toContain('LINE60'); // still pinned to the newest output
    expect(after).not.toMatch(/↑\d/); // and no off-bottom indicator appeared
    unmount();
  });

  it('scrolls the help overlay itself with PgDn', async () => {
    // 22 rows of content against a 16-row viewport. Before this round the tail
    // was clipped by `overflow: hidden` with no scrollbar, no indicator and no
    // key that could reach it.
    const fc = new FakeController();
    const { lastFrame, stdin, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(80);
    stdin.write('?');
    await delay(80);

    const first = stripAnsi(lastFrame() ?? '');
    expect(first).toContain('Keybindings');
    expect(first).toMatch(/1-\d+\/\d+/); // position indicator

    stdin.write('[6~'); // PgDn
    await delay(80);
    const second = stripAnsi(lastFrame() ?? '');
    expect(second).not.toBe(first);

    stdin.write('[6~'); // a second PgDn reaches the end (24 rows, 12 visible)
    await delay(80);
    let third = stripAnsi(lastFrame() ?? '');
    // Keep paging until the tail is on screen. Bounded rather than a fixed
    // press count on purpose: the assertion is "the tail is REACHABLE", and a
    // hard-coded page count couples this test to how many rows the help content
    // happens to have — which is exactly what adding the two wheel keybinding
    // rows broke.
    for (let i = 0; i < 10 && !third.includes('/exit'); i += 1) {
      stdin.write('[6~'); // PgDn
      // eslint-disable-next-line no-await-in-loop
      await delay(80);
      third = stripAnsi(lastFrame() ?? '');
    }
    expect(third).toContain('/exit'); // the tail is reachable at all
    expect(third).not.toContain('Keybindings'); // ...and the window really moved
    unmount();
  });

  it('renders the whole overlay unclipped in inline mode (A-2c)', async () => {
    // Inline has no fixed frame, so `maxRows` is Infinity: render everything and
    // show no position indicator. Rarely opened by hand, easy to break silently.
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { mode: 'inline', initialPrompt: '/help' });
    await delay(80);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Keybindings');
    expect(frame).toContain('/exit'); // nothing was cut
    expect(frame).not.toMatch(/\d+-\d+\/\d+/); // no position indicator
    unmount();
  });
});

describe('reduced motion (A-10)', () => {
  it('shows no braille spinner while streaming when reducedMotion is set', async () => {
    // `ToolCard` honoured this; the assistant marker did not, so the answer
    // marker kept animating for users who had explicitly asked it not to.
    const fc = new FakeController();
    fc.config = { ...CONFIG, reducedMotion: true };
    fc.onPrompt = () =>
      new Promise<void>(() => {
        fc.emit({ type: 'agent_start' });
        fc.emit({ type: 'turn_start' });
        fc.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'partial' } });
      });
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'go' });
    await delay(80);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('partial');
    expect(frame).not.toMatch(/[⠀-⣿]/); // no braille dots
    unmount();
  });

  it('does animate when reducedMotion is off, and it is the ACTIVITY ROW that does', async () => {
    // REWRITTEN FOR single-spinner-while-running §7.3, and the rewrite is the
    // point. This case was written to protect the animated assistant marker and
    // asserted only `toMatch(/[⠀-⣿]/)` on the WHOLE FRAME. That marker is now
    // deliberately static for the whole of a run, yet the frame still contains
    // braille -- from the activity row -- so the old assertion would go on
    // passing while the thing it was written to guard had gone. A test that
    // passes for the wrong reason is worse than a red one.
    //
    // What it guards now is what the frame actually promises: braille is
    // present, it is on the activity row, and it is the ONLY braille there.
    const fc = new FakeController();
    fc.onPrompt = () =>
      new Promise<void>(() => {
        fc.emit({ type: 'agent_start' });
        fc.emit({ type: 'turn_start' });
        fc.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'partial' } });
      });
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'go' });

    // Bounded poll rather than a fixed sleep, and the reason is the rewrite
    // itself. The old assertion was one whole-frame `toMatch`, which the
    // activity row satisfies on the first commit; the assertions below need the
    // TRANSCRIPT to have committed too, and the render governor throttles that
    // to `maxRenderIntervalMs`. Under full-suite load an 80 ms sample can land
    // on a frame carrying the activity row and not yet the answer — which reads
    // `1` braille whether or not the fix is present, i.e. the pass-for-the-
    // wrong-reason this very rewrite exists to close. Wait on the CONTENT, never
    // on the property under test. Same shape as the paging loop at `:828`.
    let frame = stripAnsi(lastFrame() ?? '');
    for (let i = 0; i < 40 && !frame.includes('partial'); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await delay(40);
      frame = stripAnsi(lastFrame() ?? '');
    }

    expect(frame).toMatch(/[⠀-⣿]/); // the screen is alive...
    expect((frame.match(/[⠀-⣿]/g) ?? []).length).toBe(1); // ...exactly once (AC-1)

    // The one braille glyph is on the row that carries the working phrase.
    const spinnerLine = frame.split('\n').find((l) => /[⠀-⣿]/.test(l)) ?? '';
    expect(ACTIVITY_PHRASES.some((p) => spinnerLine.includes(p))).toBe(true);

    // And the streamed answer still renders, with a STATIC role marker.
    expect(frame).toContain('partial');
    expect(frame).toContain('●');
    unmount();
  });
});

describe('composer hints (A-14)', () => {
  it('always names the abort key while running, however experienced the user', async () => {
    // R-P1-6: removing the status bar's hint cluster made the composer the only
    // place `esc abort` appears. Fading it out after 8 submissions would leave a
    // long-running task with no visible way to stop it -- retiring an emergency
    // exit as if it were a beginner tip.
    const fc = new FakeController();
    fc.config = { ...CONFIG, submitCount: 999 };
    fc.onPrompt = () =>
      new Promise<void>(() => {
        fc.emit({ type: 'agent_start' });
        fc.emit({ type: 'turn_start' });
      });
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen', initialPrompt: 'go' });
    await delay(100);
    expect(stripAnsi(lastFrame() ?? '')).toContain('esc abort');
    unmount();
  });

  it('collapses the idle hint once the user has submitted enough times', async () => {
    const fc = new FakeController();
    fc.config = { ...CONFIG, submitCount: 999 };
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(80);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('? help');
    expect(frame).not.toContain('newline');
    unmount();
  });

  it('shows the full idle hint to a new user', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(80);
    expect(stripAnsi(lastFrame() ?? '')).toContain('newline');
    unmount();
  });

  it('hides the hint row entirely when hints are disabled', async () => {
    const fc = new FakeController();
    fc.config = { ...CONFIG, hints: false };
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(80);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).not.toContain('? help');
    expect(frame).not.toContain('newline');
    unmount();
  });
});

describe('headless mode', () => {
  it('streams text to stdout and resolves exit 0', async () => {
    const listeners: ((e: AgentEvent) => void)[] = [];
    const emit = (e: AgentEvent) => listeners.forEach((l) => l(e));
    const captured: string[] = [];
    const stdout = {
      write: (s: string) => {
        captured.push(s);
        return true;
      },
    } as unknown as NodeJS.WritableStream;

    const stub: HeadlessController = {
      preflight: () => ({ ok: true }),
      subscribe: (l) => {
        listeners.push(l);
        return () => {};
      },
      getModelInfo: () => MODEL,
      prompt: async () => {
        emit({ type: 'agent_start' });
        emit({ type: 'turn_start' });
        emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'Hello world' } });
        emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, usage: { inputTokens: 1, outputTokens: 2 } });
        emit({ type: 'agent_end', messages: [] });
      },
    };

    const code = await runHeadless(stub, 'hi', { stdout, quiet: true });
    expect(code).toBe(0);
    expect(captured.join('')).toBe('Hello world\n');
  });

  it('returns exit 2 on a pre-flight config error', async () => {
    const stub: HeadlessController = {
      preflight: () => ({ ok: false, kind: 'config', message: 'no key' }),
      subscribe: () => () => {},
      getModelInfo: () => MODEL,
      prompt: async () => {},
    };
    const stderr = { write: () => true } as unknown as NodeJS.WritableStream;
    const code = await runHeadless(stub, 'hi', { stderr, quiet: true });
    expect(code).toBe(2);
  });
});

/**
 * The rail, mounted through the real `App` (todo-plan-execution AC-23 / AC-24 /
 * AC-38 / AC-43).
 *
 * AC-43 is satisfied by this whole FILE rather than by any one case: a required
 * `subscribeTodos` on the real controller is not a type error against
 * `fc as unknown as AgentController`, so the only thing that catches its absence
 * is `<App>` mounting at all — here and in `mouse-routing.test.tsx`.
 */
describe('the todo rail (todo-plan-execution §3.9)', () => {
  const SNAPSHOT: TodoSnapshot = {
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

  it('AC-24: with no list the frame is byte-identical to the pre-feature one', async () => {
    // The `AppShell` row wrapper is UNCONDITIONAL (D-26) precisely so this holds:
    // yoga lays a single-child row out identically to the column it replaced, and
    // making the wrapper conditional would remount `ScrollViewport` — throwing
    // away its scroll offset and the intent nonce it seeds on mount — the first
    // time the model ever called `todo_write`.
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(60);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).not.toContain('TODO');
    unmount();
  });

  it('mounts the rail the moment a list exists, and unmounts it when cleared', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(60);

    fc.todoSnapshot = SNAPSHOT;
    fc.emitTodo({ type: 'updated', snapshot: SNAPSHOT });
    await delay(60);
    const withRail = stripAnsi(lastFrame() ?? '');
    expect(withRail).toContain('TODO');
    expect(withRail).toContain('1/3');
    // The in-progress row shows `activeForm`; the rest show `content`.
    expect(withRail).toContain('Designing the store');
    expect(withRail).toContain('Read the reducer');

    fc.todoSnapshot = null;
    fc.emitTodo({ type: 'cleared', reason: 'user' });
    await delay(60);
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('TODO');
    unmount();
  });

  it('AC-38: /todo panel off drops the rail with NO relaunch (P1-2)', async () => {
    // `App` reads `controller.getConfig()` on EVERY render, and `persistConfig`
    // only writes the file — so the runtime mutator is the whole mechanism. This
    // asserts the render side of that pair.
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { mode: 'fullscreen' });
    await delay(60);
    fc.todoSnapshot = SNAPSHOT;
    fc.emitTodo({ type: 'updated', snapshot: SNAPSHOT });
    await delay(60);
    expect(stripAnsi(lastFrame() ?? '')).toContain('TODO');

    fc.config = { ...fc.config, todo: { ...fc.config.todo, panel: false } };
    fc.emitTodo({ type: 'updated', snapshot: SNAPSHOT });
    await delay(60);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).not.toContain('TODO');
    // ...and the counter moves to the status bar instead, which is the §6.3
    // fallback for exactly this case.
    expect(frame).toContain('1/3');
    unmount();
  });

  it('never renders the rail in inline mode (non-goal 4)', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { mode: 'inline' });
    await delay(60);
    fc.todoSnapshot = SNAPSHOT;
    fc.emitTodo({ type: 'updated', snapshot: SNAPSHOT });
    await delay(60);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).not.toContain('TODO');
    // The transcript CARD still renders in both modes; only the rail is
    // full-screen-only.
    expect(frame).toContain('Todos');
    unmount();
  });

  it('surfaces a refused write as a warn notice (the suppressed-card compensation)', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, { mode: 'inline' });
    await delay(60);
    fc.emitTodo({ type: 'rejected', reason: 'A one-step list is not a plan.' });
    await delay(60);
    expect(stripAnsi(lastFrame() ?? '')).toContain('A one-step list is not a plan.');
    unmount();
  });

  it('notices unfinished items at the end of a run, and names the affordance', async () => {
    // NOTIFY, NEVER AUTO-CONTINUE (D-15): auto-continuation is an unbounded cost
    // loop wearing a helpful hat.
    const fc = new FakeController();
    fc.onPrompt = async () => {
      fc.emit({ type: 'agent_start' });
      fc.todoSnapshot = SNAPSHOT;
      fc.emitTodo({ type: 'updated', snapshot: SNAPSHOT });
      fc.emit({ type: 'turn_end', message: { role: 'assistant', content: [] }, usage: { inputTokens: 1, outputTokens: 1 } } as never);
      fc.emit({ type: 'agent_end' } as never);
    };
    const { lastFrame, unmount } = mount(fc, { mode: 'inline', initialPrompt: 'go' });
    await delay(120);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('2 todo items are unfinished');
    expect(frame).toContain('/todo continue');
    unmount();
  });
});

describe('the transcriptRetain raise is reported, not just performed', () => {
  // tui-render-performance §5.1. `loadConfig` RAISES a `transcriptRetain`
  // below `transcriptWindow` -- retaining fewer entries than the horizon can
  // scroll to makes part of that horizon permanently unreachable -- and this
  // asserts the other half of that sentence: it says so. Overriding a value the
  // user typed and staying quiet is the one silent degradation this feature is
  // not allowed to add, and the wiring that prevents it (load.ts -> CliConfig ->
  // App -> useStartupNotices) has no compile-time link anywhere along it.
  it('shows a notice naming both numbers when the two conflict', async () => {
    const fc = new FakeController();
    fc.config = {
      ...CONFIG,
      transcriptWindow: 5000,
      transcriptRetain: 5000,
      transcriptRetainRequested: 200,
    };

    const { lastFrame, unmount } = mount(fc);
    await delay(40);
    const frame = stripAnsi(lastFrame() ?? '');
    unmount();

    expect(frame).toContain('transcriptRetain 200');
    expect(frame).toContain('transcriptWindow 5000');
  });

  it('stays silent when nothing was overridden', async () => {
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc);
    await delay(40);
    const frame = stripAnsi(lastFrame() ?? '');
    unmount();

    expect(frame).not.toContain('transcriptRetain');
  });
});

// ---------------------------------------------------------------------------
// The live tool tail, through `App` (agent-activity-presentation-live)
//
// AC-38 and AC-41 are pinned HERE rather than against a component, and both for
// the same reason: each is a property of the WIRING, and a test that mounted the
// component directly would pass whether or not the wiring exists. AC-41 says so
// explicitly -- "rendered from `App` rather than by mounting `ToolCard`
// directly, so the memo comparator is exercised".
// ---------------------------------------------------------------------------

/** Drive a run up to a RUNNING bash tool and leave it there. */
function startRunningBash(fc: FakeController): void {
  fc.onPrompt = () =>
    new Promise<void>(() => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({
        type: 'message_update',
        streamEvent: { type: 'tool_call_start', toolCallId: 't1', toolName: 'bash' },
      });
      fc.emit({
        type: 'message_update',
        streamEvent: {
          type: 'tool_call_end',
          toolCallId: 't1',
          toolName: 'bash',
          args: { command: 'npm test' },
        },
      });
      fc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} });
    });
}

describe('AC-38: the output subscription goes through the coalescer, not dispatch', () => {
  /**
   * THE MUTATION THIS PINS: rewrite the `subscribeToolOutput` effect in
   * `App.tsx` the way its three siblings are written -- `flushPending();
   * dispatch(action);` -- and this case fails. That is the form an implementer
   * copying `subscribeFast` produces (P0-2), and it costs one React commit per
   * `read()` from a child process.
   *
   * THE CHUNKS ARRIVE IN SEPARATE TICKS, deliberately. A child process's `data`
   * events do, and React's auto-batching would otherwise merge a synchronous
   * burst on its own and make the buffered and unbuffered forms look identical
   * -- a test that cannot fail.
   */
  it('twelve chunks in twelve ticks reach the reducer as ONE action', async () => {
    const fc = new FakeController();
    startRunningBash(fc);
    const { frames, lastFrame, unmount } = mount(fc, {
      initialPrompt: 'go',
      mode: 'fullscreen',
    });
    await delay(60);
    const before = frames.length;

    for (let i = 0; i < 12; i += 1) {
      fc.emitToolOutput({ toolCallId: 't1', rows: [`chunk ${i}`] });
      // A separate MACROTASK per chunk, which is how `child.stdout` delivers
      // them and what defeats React's auto-batching. `setImmediate` rather than
      // a timer keeps the whole burst inside one 33 ms governor interval, so the
      // buffered form has exactly one flush to show for it.
      await new Promise((r) => setImmediate(r));
    }
    await delay(160);

    // WHICH TAILS EVER REACHED THE SCREEN is the observable that separates the
    // two forms. Frame COUNT does not: the 200 ms elapsed ticker and the
    // spinner repaint on their own schedule, and a direct dispatch inside one
    // of their frames is invisible in the total.
    const distinct = new Set<number>();
    for (const f of frames.slice(before)) {
      const m = /chunk (\d+)/.exec(stripAnsi(f));
      if (m) distinct.add(Number(m[1]));
    }
    const settled = stripAnsi(lastFrame() ?? '');
    unmount();

    // Direct dispatch paints every intermediate tail; the coalescer paints the
    // last one per interval. Two is the allowance for a flush that lands mid-burst.
    expect([...distinct].length, [...distinct].join(',')).toBeLessThanOrEqual(2);
    expect(distinct.has(11)).toBe(true);
    // And exactly one tail survives on screen -- the LAST (D-30). The
    // trailing-digit guard matters: `chunk 1` is a prefix of `chunk 11`.
    expect(settled).toContain('chunk 11');
    for (let i = 0; i < 11; i += 1) {
      expect(new RegExp(`chunk ${i}(?!\\d)`).test(settled), `chunk ${i}`).toBe(false);
    }
  });

  it('the tail does reach the card, so the buffering is not just swallowing it', async () => {
    const fc = new FakeController();
    startRunningBash(fc);
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'go', mode: 'fullscreen' });
    await delay(60);
    fc.emitToolOutput({ toolCallId: 't1', rows: ['PASS tests/one', 'PASS tests/two'] });
    await delay(160);
    const frame = stripAnsi(lastFrame() ?? '');
    unmount();
    expect(frame).toContain('PASS tests/one');
    expect(frame).toContain('PASS tests/two');
  });
});

describe('AC-41: the stall row`s seconds advance THROUGH EntryView`s comparator', () => {
  /**
   * THE MUTATION THIS PINS: delete `a.nowSec === b.nowSec` from `EntryView`'s
   * explicit comparator in `Transcript.tsx` and this case fails.
   *
   * That comparator is a CLOSED LIST of `===` terms, so a prop missing from it
   * changes without invalidating the boundary: `ToolCard` is never re-rendered
   * and the row freezes at whatever second it first drew, with nothing anywhere
   * reporting it (I-L2-1). A test that mounted `ToolCard` with a changing
   * `nowSec` would pass either way, which is the shape of a test that cannot
   * fail -- so this one renders through `App`.
   *
   * ONLY `Date` IS FAKED. The 200 ms elapsed ticker that causes the re-render
   * has to keep firing for real; what the test controls is the CLOCK the row
   * reads, which is the only way to reach a 45-second stall inside a unit test.
   */
  it('the row appears and its number grows as wall-clock time passes', async () => {
    const t0 = 1_700_000_000_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    try {
      const fc = new FakeController();
      startRunningBash(fc);
      const { lastFrame, unmount } = mount(fc, { initialPrompt: 'go', mode: 'fullscreen' });
      await delay(60);

      // The listener stamps `at: Date.now()`, so the tail's clock starts at t0.
      fc.emitToolOutput({ toolCallId: 't1', rows: ['building...'] });
      await delay(160);
      expect(stripAnsi(lastFrame() ?? '')).toContain('(running)');

      const readAfter = async (seconds: number): Promise<string> => {
        vi.setSystemTime(t0 + seconds * 1000);
        await delay(320); // > one 200 ms tick, so a render is certain.
        return stripAnsi(lastFrame() ?? '');
      };

      expect(await readAfter(45)).toContain('no output for 45s');
      // THE HALF THAT FAILS WITHOUT THE COMPARATOR TERM: the FIRST stalled
      // number gets on screen either way, because the entry object itself
      // changed on the tail update. Only the SECOND one needs `nowSec` to cross
      // the boundary on its own.
      expect(await readAfter(46)).toContain('no output for 46s');
      expect(await readAfter(90)).toContain('no output for 90s');

      unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * AC-37 / L5 — round 1's one recorded but unbought pin.
 *
 * `runStartedAt` SEEDS THE PHRASE SEQUENCE, and it is assigned in RENDER SCOPE
 * (`App.tsx`: `if (running && runStartedAt.current === 0) runStartedAt.current =
 * Date.now()`) rather than in an effect. Written in an effect it would hold `0`
 * on the first frame of the first run and the PREVIOUS run's start on every run
 * after — so every run would open on the wrong word for one frame and then jump.
 * A flicker at the start of every single turn, in the one moment this feature
 * exists to make feel calm.
 *
 * The clock is faked so the expected word is computable; `t0` is chosen so that
 * the seeded phrase and the `startedAt === 0` phrase are DIFFERENT WORDS, which
 * is what lets this case fail.
 */
describe('AC-37: the activity row opens on the phrase its own run seeds (L5)', () => {
  it('the first frame with the row already shows `pickActivityPhrase(seed, seed)`', async () => {
    // 45 phrases; `seed = floor(t0 / 1000)`, so a `t0` whose second is not a
    // multiple of 45 gives a word the unseeded `startedAt = 0` cannot produce.
    const t0 = 1_700_000_007_000;
    const seeded = pickActivityPhrase(t0, t0, true);
    const unseeded = pickActivityPhrase(0, 0, true);
    expect(seeded, 'the fixture must be able to fail').not.toBe(unseeded);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    try {
      const fc = new FakeController();
      fc.onPrompt = () =>
        new Promise<void>(() => {
          fc.emit({ type: 'agent_start' });
          fc.emit({ type: 'turn_start' });
        });
      const { frames, unmount } = mount(fc, { initialPrompt: 'go', mode: 'fullscreen' });
      await delay(60);

      const first = frames.map(stripAnsi).find((f) => ACTIVITY_PHRASES.some((p) => f.includes(p)));
      unmount();

      expect(first, 'no frame carried an activity phrase').toBeDefined();
      expect(first).toContain(seeded);
      expect(first).not.toContain(unseeded);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The updater's two App-side invariants (cli-auto-update AC-19 / AC-4).
 *
 * Both are about a thing NOT happening, which is why they need `<App>` rather
 * than a unit: the toast is pushed by an effect keyed on a phase, and the row is
 * decided by a ternary at a call site. Neither is reachable from the service's
 * own tests, and neither is visible in a manual pass until it has already
 * annoyed someone.
 */
describe('the auto-update bridge (cli-auto-update §6.3)', () => {
  function fakeService(initial: UpdateSnapshot) {
    let snapshot = initial;
    const listeners = new Set<(s: UpdateSnapshot) => void>();
    const service: UpdateServiceHandle = {
      snapshot: () => snapshot,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      checkNow: async () => snapshot,
      skip: () => {},
      nextCheckAt: () => null,
    };
    return {
      service,
      /** A NEW object every time, exactly as the real service does (§5.3). */
      push(over: Partial<UpdateSnapshot>) {
        snapshot = { ...snapshot, ...over };
        for (const fn of listeners) fn(snapshot);
      },
    };
  }

  const IDLE: UpdateSnapshot = {
    phase: 'idle',
    currentVersion: '0.5.9',
    latestVersion: null,
    source: 'npm-global',
    nextCheckAt: null,
    consecutiveFailures: 0,
  };

  it('AC-19: `installing -> ready` pushes EXACTLY ONE toast, however often it repeats', async () => {
    // R-8, the classic auto-updater failure. The guard is a `useRef`, so the
    // case has to do the two things a ref survives and a state flag would not:
    // re-render at `ready` repeatedly, AND cross the edge a second time. Inline
    // `ToastStack` draws one row per toast (up to three), so a second push is
    // a second occurrence in the same frame rather than a subtler difference.
    const fake = fakeService(IDLE);
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc, {
      updateBridge: { service: fake.service, onAttach: null },
    });
    await delay(20);

    fake.push({ phase: 'installing', latestVersion: '0.6.0' });
    fake.push({ phase: 'ready' });
    // Re-renders at `ready`...
    fake.push({ phase: 'ready' });
    fake.push({ phase: 'ready' });
    // ...and the edge itself, a second time.
    fake.push({ phase: 'installing' });
    fake.push({ phase: 'ready' });
    await delay(40);

    const frame = stripAnsi(lastFrame() ?? '');
    const hits = frame.split('0.6.0 installed - restart aragon to apply').length - 1;
    unmount();
    expect(hits, frame).toBe(1);
  });

  it('AC-4: with no bridge the row is never claimed and no toast is ever pushed', async () => {
    // `update.mode: off`, a non-TTY and CI all reach `App` the same way: the
    // prop is absent, so `updateSnapshot` stays `null` and the `update` prop
    // `BottomStatusRow` receives is `null` for the whole session.
    const fc = new FakeController();
    const { lastFrame, unmount } = mount(fc);
    await delay(20);
    const frame = stripAnsi(lastFrame() ?? '');
    unmount();
    expect(frame).not.toContain('restart aragon to apply');
    expect(frame).not.toContain('available');
  });
});
