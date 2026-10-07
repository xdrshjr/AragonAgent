/**
 * One spinner per run (single-spinner-while-running AC-1 .. AC-8).
 *
 * THE INVARIANT, STATED SO A TEST CAN FAIL ON IT: while the activity line is on
 * screen, it is the only animated spinner in the frame. Seven other sites can
 * animate — the streaming assistant marker, the tool badge, the team / fast /
 * retry cards, and the two panels' rows — and each was independently right to.
 * Emergently a single ordinary turn put up to five braille animations on
 * adjacent rows, each on its own 80 ms timer, saying the same thing out of
 * phase.
 *
 * THE COUNTER IS THE WHOLE TRICK. Every one of those sites animates by rendering
 * `<Spinner type="dots" />`, which is braille and nothing else in this package
 * is (`glyphs.test.ts` already forbids a component from spelling a braille
 * literal of its own). So counting braille code points in the stripped frame
 * counts animations directly, with no knowledge of which component drew them —
 * which is what lets AC-1 fail on a spinner that has not been written yet.
 *
 * A SEPARATE FILE FROM `app.test.tsx` because the invariant is about the WHOLE
 * frame, not about any one component: it belongs where a future reader adding an
 * eighth animated site will find it, next to the census scan in
 * `spinner-census.test.ts`.
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
  DEFAULT_FAST_CONFIG,
  DEFAULT_LOG_CONFIG,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_SKILLS_RUNTIME,
  DEFAULT_TEAM_CONFIG,
  DEFAULT_TODO_CONFIG,
  DEFAULT_BASH_CONFIG,
  DEFAULT_UPDATE_CONFIG,
  type CliConfig,
  type TodoConfig,
} from '../config/schema.js';
import type { SkillService } from '../skills/service.js';
import type { AgentMode } from '../agent/agent-mode.js';
import type { TeamEvent, TeamSnapshot } from '../team/types.js';
import type { TodoEvent, TodoSnapshot } from '../todo/types.js';
import { normalizePlan } from '../tools/human-input.js';
import type { HumanInputBridge } from '../tools/human-input.js';
import { offFastStatus, type FastStatus } from '../fast/wiring.js';
import { offCompactionSnapshot } from '../compaction/wiring.js';
import type {
  CompactionEvent,
  CompactionSnapshot,
  ContextUsageSnapshot,
} from '../compaction/types.js';
import type { FastEvent } from '../fast/types.js';
import type { ToolOutputEvent, ToolOutputListener } from '../tools/tool-output-store.js';
import type { ProcEvent, ProcEventListener } from '../proc/types.js';
import { interactionCopy as copy } from '../ui/interaction-copy.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * The animation counter.
 *
 * Braille is the ONLY thing `ink-spinner`'s `dots` type emits, and `glyphs.ts`
 * carries no braille in either tier, so this is an exact count of running
 * spinners in the frame — regardless of which component drew them.
 */
const brailleCount = (frame: string): number => (frame.match(/[⠀-⣿]/g) ?? []).length;

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
 * The same stub `app.test.tsx` carries, and for the same reason: it is handed
 * over as `fc as unknown as AgentController`, so a MISSING MEMBER IS NOT A
 * COMPILE ERROR — it is a `is not a function` throw before the first frame.
 */
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
    if (e.type === 'agent_start') this.running = true;
    if (e.type === 'agent_end') this.running = false;
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
  getSkillService(): SkillService {
    return EMPTY_SKILL_SERVICE;
  }
  setOnSkillsChanged(): void {}
  takeFilePatch(): undefined {
    return undefined;
  }
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
  emitTeam(e: TeamEvent): void {
    for (const l of this.teamListeners) l(e);
  }
  getTeamSnapshot(): TeamSnapshot | null {
    return this.teamSnapshot;
  }
  teamSnapshot: TeamSnapshot | null = null;
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
  todoConfig: TodoConfig = { ...DEFAULT_TODO_CONFIG };
  getTodoConfig(): TodoConfig {
    return this.todoConfig;
  }
  isRunning(): boolean {
    return this.running;
  }
  agentMode: AgentMode = 'build';
  pendingMode: AgentMode | null = null;
  running = false;
  getAgentMode(): AgentMode {
    return this.agentMode;
  }
  setAgentMode(next: AgentMode, opts: { force?: boolean } = {}) {
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
        humanInputBridge?: HumanInputBridge;
  } = {},
) {
  return render(
    <App
      controller={fc as unknown as AgentController}
      version="0.0.0"
      initialPrompt={extra.initialPrompt}
      humanInputBridge={extra.humanInputBridge}
    />,
  );
}

/** A run that streams one chunk of text and then never finishes. */
function streamingController(config: CliConfig = CONFIG): FakeController {
  const fc = new FakeController();
  fc.config = config;
  fc.onPrompt = () =>
    new Promise<void>(() => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'partial' } });
    });
  return fc;
}

/** A run parked inside a `bash` call that never returns. */
function toolRunningController(): FakeController {
  const fc = new FakeController();
  fc.onPrompt = () =>
    new Promise<void>(() => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'listing' } });
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
          args: { command: 'ls' },
        },
      });
      fc.emit({
        type: 'turn_end',
        message: { role: 'assistant', content: [] },
        usage: { inputTokens: 100, outputTokens: 20 },
      });
      fc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} });
    });
  return fc;
}

const PLAN = normalizePlan({
  title: 'Add SSO via OIDC',
  summary: 'Introduces an oidc provider module.',
  steps: [{ title: 'Implement src/auth/oidc.ts', detail: 'Token exchange.' }],
})!;

const makeBridge = (): HumanInputBridge => ({ handler: null, cancelPending: () => {} });

/** The line the one spinner is allowed to be on. */
function spinnerLine(frame: string): string {
  return frame.split('\n').find((l) => /[⠀-⣿]/.test(l)) ?? '';
}

/**
 * The frame once it has caught up, and every assertion in a case reads THAT ONE
 * FRAME.
 *
 * BOUNDED POLLING RATHER THAN A FIXED `delay`, for two independent reasons and
 * both of them are about honesty rather than convenience. The render governor
 * throttles commits to `maxRenderIntervalMs` (320 ms in this fixture), so a
 * fixed sleep tuned on an idle machine samples a half-built frame when the
 * suite runs 144 files in parallel — and a spinner count taken from a frame that
 * has not rendered the transcript yet is a PASS FOR THE WRONG REASON, which is
 * the exact failure this whole feature's test plan is written against.
 *
 * The predicate is always about the CONTENT the case is about, never about the
 * property under test: polling until the braille count is 1 would assert
 * nothing at all.
 */
async function settledFrame(
  lastFrame: () => string | undefined,
  ready: (frame: string) => boolean,
): Promise<string> {
  let frame = stripAnsi(lastFrame() ?? '');
  for (let i = 0; i < 40 && !ready(frame); i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await delay(40);
    frame = stripAnsi(lastFrame() ?? '');
  }
  return frame;
}

/** The activity row is up when the frame carries its vocabulary. */
const hasActivityRow = (frame: string): boolean =>
  [...copy.generating, ...copy.confirming].some((p) => frame.includes(p));

describe('single spinner while running', () => {
  it('AC-1/AC-2/AC-3: exactly one spinner, on the activity row, marker static', async () => {
    const fc = streamingController();
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'go' });
    // The streamed text is what says the transcript has actually rendered, so
    // it is also what says the spinner count is worth taking.
    const frame = await settledFrame(lastFrame, (f) => f.includes('partial'));

    // AC-1 — one animation in the whole frame, not two out of phase.
    expect(brailleCount(frame)).toBe(1);

    // AC-2 — and it is the row above the composer, identified by its own
    // vocabulary rather than by position, because position is what a layout
    // change moves and the phrase is what the row IS.
    expect(copy.generating.some((p) => spinnerLine(frame).includes(p))).toBe(true);

    // AC-3 — the answer keeps its text and gets the STATIC role marker. Both
    // halves matter: a suppression that also dropped the marker would trade a
    // duplicate animation for a missing glyph.
    expect(frame).toContain('partial');
    expect(frame).toContain('●');
    unmount();
  });

  it('AC-4: a tool in flight says `running` without animating it', async () => {
    const fc = toolRunningController();
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'ls' });
    const frame = await settledFrame(lastFrame, (f) => f.includes('正在执行命令'));

    // The card still SAYS it is running — no information left the screen, only
    // motion did. This is the pair the bug was most visible on: two braille
    // animations one row apart, both meaning "bash is running".
    expect(frame).toContain('· running');
    expect(frame).toContain('正在执行命令');
    expect(brailleCount(frame)).toBe(1);
    expect(spinnerLine(frame)).toContain('正在执行命令');
    unmount();
  });

  it('AC-5: a modal hides the transcript animation and closing it restores activity', async () => {
    // THE ONE CASE THAT CANNOT BE WRITTEN THE OBVIOUS WAY (P0-1). `?` is gated
    // on `!running` (`PromptInput.tsx:421`) and `/help` / `/model` / `/settings`
    // are slash commands needing a submit, so NO help overlay can exist while a
    // run is in flight. An AC-5 written that way never reaches
    // `running && overlay`, passes vacuously, and leaves D-3 — the riskiest
    // decision in the design — with nothing holding it.
    //
    // The overlays that ARE reachable mid-run are the three raised from inside
    // tool execution while the agent loop blocks on a human: `confirm`,
    // `question` and `plan`. This drives `plan` through the same bridge the
    // human-input suite already uses.
    const fc = streamingController();
    const bridge = makeBridge();
    const { lastFrame, stdin, unmount } = mount(fc, { initialPrompt: 'go', humanInputBridge: bridge });
    const before = await settledFrame(lastFrame, (f) => f.includes('partial'));
    expect(brailleCount(before)).toBe(1); // baseline: the activity row, and only it
    expect(hasActivityRow(before)).toBe(true);

    void bridge.handler!({ kind: 'plan', plan: PLAN });
    const frame = await settledFrame(lastFrame, (f) => f.includes('Review plan'));

    expect(frame).toContain('Review plan'); // the overlay really is up...
    expect(hasActivityRow(frame)).toBe(true); // status survives the overlay
    expect(brailleCount(frame)).toBe(1); // the global status owns activity
    stdin.write('\x1b');
    const restored = await settledFrame(lastFrame, (f) => hasActivityRow(f));
    expect(brailleCount(restored)).toBe(1);
    unmount();
  });

  it('AC-6: nothing animates and no placeholder is stranded once the run ends', async () => {
    const fc = new FakeController();
    fc.onPrompt = async () => {
      fc.emit({ type: 'agent_start' });
      fc.emit({ type: 'turn_start' });
      fc.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'done here' } });
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
          args: { command: 'ls' },
        },
      });
      fc.emit({
        type: 'turn_end',
        message: { role: 'assistant', content: [] },
        usage: { inputTokens: 100, outputTokens: 20 },
      });
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
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'ls' });
    // `idle` in the status bar is the run being over, which is the state this
    // case is about — and it is a different fact from "nothing animates", so
    // waiting on it does not assert the thing under test.
    const frame = await settledFrame(lastFrame, (f) => /空闲|结束/.test(f));

    expect(brailleCount(frame)).toBe(0);
    // The suppressed form must not OUTLIVE the run: a settled card saying
    // `· running` would be a stale placeholder, which is worse than the spinner.
    expect(frame).not.toContain('· running');
    unmount();
  });

  it('AC-7: reducedMotion still means zero, not one', async () => {
    // The widening must be a UNION with the user's setting, never a replacement.
    // `||` the wrong way round would give a user who asked for stillness the one
    // spinner this feature keeps.
    const fc = streamingController({ ...CONFIG, reducedMotion: true });
    const { lastFrame, unmount } = mount(fc, { initialPrompt: 'go' });
    const frame = await settledFrame(lastFrame, (f) => f.includes('partial'));

    expect(brailleCount(frame)).toBe(0);
    expect(frame).toContain('partial'); // ...with every word still on screen
    expect(hasActivityRow(frame)).toBe(true); // ...and the row itself still there
    unmount();
  });

  it('AC-8: an ASCII terminal gets the ASCII tier and the same number of rows', async () => {
    // Braille is Unicode-only, so a legacy console never had spinners to
    // collapse — but it must not gain or lose a ROW either, because the
    // suppressed forms are what occupy the columns the spinners used to.
    const rich = streamingController();
    const richMount = mount(rich, { initialPrompt: 'go' });
    const richFrame = await settledFrame(richMount.lastFrame, (f) => f.includes('partial'));
    richMount.unmount();

    const ascii = streamingController({ ...CONFIG, unicode: false });
    const asciiMount = mount(ascii, { initialPrompt: 'go' });
    const asciiFrame = await settledFrame(asciiMount.lastFrame, (f) => f.includes('partial'));
    asciiMount.unmount();

    expect(brailleCount(asciiFrame)).toBe(0);
    expect(asciiFrame).toContain('*'); // the ASCII tier's marker
    expect(asciiFrame).toContain('partial');
    expect(asciiFrame.split('\n')).toHaveLength(richFrame.split('\n').length);
  });
});

/**
 * R-1 firing, and the case that would have caught it
 * (`activity-spinner-vanishes-behind-toast`).
 *
 * `App` suppresses the other seven animated sites for as long as it believes the
 * activity row is up, but `BottomStatusRow` gave the row to a toast outright —
 * so every mid-run ack (steering, plan approval, `Ctrl+T`) left the frame with
 * ZERO animations for the toast's 2.5 s TTL. The design's own R-1 predicted
 * exactly this and was declared mitigated because "they are the same named
 * const"; they were, and the const simply was not the mount condition.
 *
 * THE FIXTURE IS DELIBERATELY THICK, and that is the half of this case that is
 * easy to lose. A run with a single animatable site cannot tell the two
 * candidate fixes apart: un-suppressing everything during the toast also reads
 * `1` there, while a real run with a todo rail and a tool card reads `2`. So the
 * rail and the card are ASSERTED PRESENT before the count is trusted — a fixture
 * too thin to express the failure is the same miss as the manual gate that let
 * this ship.
 */
describe('a mid-run toast keeps the one animation', () => {
  const TODOS: TodoSnapshot = {
    items: [
      { content: 'List the directory', activeForm: 'Listing the directory', status: 'in_progress' },
      { content: 'Summarise it', activeForm: 'Summarising it', status: 'pending' },
    ],
    total: 2,
    doneCount: 0,
    activeIndex: 0,
    updatedAt: 1_700_000_000_000,
  };

  /**
   * A full-screen run parked in `bash`, with a live todo rail beside it.
   *
   * `hints: false` is the configuration in which the run status row is NOT
   * enabled (it replaces the idle hint row, so it exists only where that row
   * does), which keeps the life signal on the fixed bottom row - the layout the
   * toast-glyph cases below were written for.
   */
  function mountThickRun(config: CliConfig = CONFIG) {
    const fc = toolRunningController();
    fc.config = config;
    const startTool = fc.onPrompt!;
    fc.onPrompt = (text) => {
      const running = startTool(text);
      // Emit from the active run, after App has subscribed to TODO events.
      // An event immediately after mount can be lost before effects run.
      fc.todoSnapshot = TODOS;
      fc.emitTodo({ type: 'updated', snapshot: TODOS });
      return running;
    };
    return mount(fc, { initialPrompt: 'ls',  });
  }

  it('AC-12: braille count is 1 before, during and after the ack', async () => {
    const { lastFrame, stdin, unmount } = mountThickRun({ ...CONFIG, hints: false });

    const before = await settledFrame(lastFrame, (f) => f.includes('正在执行命令'));
    // The fixture really is thick: two sites that WOULD animate if the
    // suppression signal were dropped for the toast window.
    expect(before).toContain('· running'); // the tool card
    expect(before).toContain('Listing the directory'); // the todo rail
    expect(brailleCount(before)).toBe(1);

    stdin.write('\x14'); // Ctrl+T — the cheapest mid-run toast
    const during = await settledFrame(lastFrame, (f) => /Thinking (shown|hidden)/.test(f));

    // The toast really did take the row — otherwise this case measures nothing.
    // NOT `hasActivityRow`: this fixture has a tool in flight, so the row reads
    // `正在执行命令` and carries no phrase at all (`ActivityLine`'s L4 branch).
    // A phrase-based predicate would be false in EVERY frame here and the case
    // would pass without ever driving the state it is named for.
    expect(during).toContain('正在执行命令');
    // ...and the frame is still alive. Never zero (the bug), never two (round 1).
    expect(brailleCount(during)).toBe(1);
    // The ack keeps its words: the spinner joins the row as a bare glyph.
    expect(during).toContain('Thinking shown.');

    let after = during;
    for (let i = 0; i < 120; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await delay(50);
      after = stripAnsi(lastFrame() ?? '');
      if (!/Thinking (shown|hidden)/.test(after)) break;
    }
    expect(after).toContain('正在执行命令'); // the row is handed back...
    expect(brailleCount(after)).toBe(1); // ...and still owns the only animation
    unmount();
  });

  it('AC-12b: with the run row up, the toast takes the bottom row and the animation stays above the input', async () => {
    // tui-scrollbar-edge-and-run-row: the run row sits in the footer, so a toast
    // on the fixed bottom row can no longer displace the life signal and needs no
    // glyph of its own. Still exactly one animation, never zero, never two.
    const { lastFrame, stdin, unmount } = mountThickRun();
    const before = await settledFrame(lastFrame, (f) => f.includes('正在执行命令'));
    expect(brailleCount(before)).toBe(1);

    stdin.write('\x14');
    const during = await settledFrame(lastFrame, (f) => /Thinking (shown|hidden)/.test(f));
    expect(during).toContain('正在执行命令'); // the run row is NOT displaced
    expect(brailleCount(during)).toBe(1);
    expect(during).toContain('Thinking shown.');
    // The toast carries no animation of its own while the run row is visible.
    expect(during).not.toMatch(/[⠀-⣿]\s+Thinking shown/);
    unmount();
  });

  it('AC-13: the glyph beside the toast MOVES — presence is not the claim', async () => {
    // The round-2 report is about animation, not about a character being on
    // screen: a still braille dot passes a count and fails the user. `dots` has
    // ten frames on an 80 ms timer, so a sample inside the 2.5 s TTL must see
    // more than one of them.
    const { lastFrame, stdin, unmount } = mountThickRun();
    await settledFrame(lastFrame, (f) => f.includes('正在执行命令'));
    stdin.write('\x14');
    await settledFrame(lastFrame, (f) => /Thinking (shown|hidden)/.test(f));

    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await delay(40);
      const frame = stripAnsi(lastFrame() ?? '');
      if (!/Thinking (shown|hidden)/.test(frame)) break; // stay inside the TTL
      for (const g of frame.match(/[⠀-⣿]/g) ?? []) seen.add(g);
    }
    unmount();

    expect(seen.size).toBeGreaterThan(1);
  });

  it('AC-14: reduced motion and the ASCII tier prefix nothing', async () => {
    // The boundary. Neither of these builds ever had the dead-frame bug — one
    // asked for stillness, the other never had braille to lose — so a static `·`
    // newly parked in front of every toast would be a regression handed to the
    // two audiences the fix is not for.
    for (const [label, config] of [
      ['reducedMotion', { ...CONFIG, reducedMotion: true }],
      ['ascii', { ...CONFIG, unicode: false }],
    ] as [string, CliConfig][]) {
      const fc = toolRunningController();
      fc.config = config;
      const { lastFrame, stdin, unmount } = mount(fc, {
        initialPrompt: 'ls',

      });
      // eslint-disable-next-line no-await-in-loop
      await settledFrame(lastFrame, (f) => f.includes('正在执行命令'));
      stdin.write('\x14');
      // eslint-disable-next-line no-await-in-loop
      const during = await settledFrame(lastFrame, (f) => /Thinking (shown|hidden)/.test(f));

      expect(brailleCount(during), label).toBe(0);
      // The toast keeps the whole row it had before: same glyph, same left edge.
      expect(during, label).toMatch(/^\s*Thinking shown\./m);
      unmount();
    }
  });
});
