/**
 * `/clear` at the COMPOSER (clear-command-context-reset T-17 / T-18, and the
 * regression fence for P0-2).
 *
 * WHY THIS FILE EXISTS BESIDE `app.test.tsx`: that suite owns the general App
 * behaviour, and the three claims here are about ONE boundary - what the composer
 * accepts during a live run, what a late engine event can still reach after a
 * clear, and whether a settling compaction can drain the old queue into the new
 * conversation. All three are decided in `App`, none of them is observable from
 * the command layer, and the generation fence in particular is the only thing
 * standing between "cleared" and "the abandoned run's last tool card appears in
 * the new conversation".
 *
 * THE FENCE IS THE POINT (C-1). `forceStop()` bumps `runGen`; `abort()` does not.
 * If a later change routes the reset through `abort()`, the zombie assertions
 * below turn red - which is exactly why they are written the way they are.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { AgentEvent, ModelInfo } from '@aragon-agent/core';

// Keep the app hermetic: a `/clear` must never touch the developer's real config,
// prompt history or UI counters.
vi.mock('../config/store.js', () => ({
  updatePersistedConfig: vi.fn(() => ({})),
  getSessionsDir: () => '/tmp/aragon-sessions',
  getConfigPath: () => '/tmp/aragon-config.json',
  readConfigFile: () => ({ config: null }),
}));
vi.mock('../config/prompt-history.js', () => ({
  loadPromptHistory: () => [],
  appendPrompt: (text: string) => [text],
}));
vi.mock('../config/ui-state.js', () => ({
  bumpSubmitCount: () => 1,
  setMouseNoticeSeen: () => {},
  getMouseNoticeSeen: () => true,
}));

const { App } = await import('../ui/App.js');
import type { AgentController } from '../agent/controller.js';
import type { CliConfig, TodoConfig } from '../config/schema.js';
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
  DEFAULT_JOBS_CONFIG,
} from '../config/schema.js';
import type { SkillService } from '../skills/service.js';
import type { TeamSnapshot } from '../team/types.js';
import type { TodoSnapshot } from '../todo/types.js';
import type { FastStatus } from '../fast/wiring.js';
import { offFastStatus } from '../fast/wiring.js';
import { offCompactionSnapshot } from '../compaction/wiring.js';
import type { CompactionSnapshot, ContextUsageSnapshot } from '../compaction/types.js';
import type { AgentMode } from '../agent/agent-mode.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ESC = '\u001B';
const REFUSAL = 'Interrupt the current run before switching conversations.';

const MODEL: ModelInfo = {
  id: 'm', name: 'M', provider: 'anthropic', contextWindow: 200_000,
  maxOutputTokens: 8192, supportsThinking: true, supportsTools: true,
  supportsImages: false, cost: { input: 0, output: 0 },
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
  hints: false,
  mouse: false,
  mouseSelect: false,
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
  // The ELEVENTH nested section (long-task-jobs). `enabled: true` because a
  // fixture that says nothing about jobs should behave like a default session;
  // the subsystems each fixture is about are switched off individually above.
  jobs: DEFAULT_JOBS_CONFIG,
  retry: DEFAULT_RETRY_CONFIG,
  compaction: { ...DEFAULT_COMPACTION_CONFIG, enabled: false },
  cwd: '/work',
  color: false,
  keyboardEnhancement: false,
  colorLevel: 1,
  unicode: true,
};

/** The narrow slice of `SkillService` the App reads while mounting. */
const SKILLS = {
  list: () => [],
  untrustedDirs: () => [],
  getRegistry: () => ({ activeNames: [] as string[] }),
} as unknown as SkillService;

/**
 * A controller stub carrying exactly the members `App` touches. Handed over as
 * `fc as unknown as AgentController`, so an omission is a runtime `is not a
 * function` before the first frame rather than a compile error - the standing
 * hazard `app.test.tsx` records at length.
 */
class ClearController {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  promptResolvers: (() => void)[] = [];
  resetConversationCalls = 0;
  forceStopCalls = 0;
  continueCalls = 0;
  runGen = 0;
  running = false;
  hasPending = false;
  /** Hold the reset open so a test can act while the clear is in flight. */
  heldReset: ((release: () => void) => void) | null = null;
  private releaseReset: (() => void) | null = null;
  private compactionBusyListeners = new Set<(busy: boolean) => void>();
  private readonly todoConfig: TodoConfig = { ...DEFAULT_TODO_CONFIG };

  subscribe(l: (e: AgentEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: AgentEvent): void {
    for (const l of this.listeners) l(e);
  }
  get runGeneration(): number {
    return this.runGen;
  }
  getConfig(): CliConfig {
    return CONFIG;
  }
  hasApiKey(): boolean {
    return true;
  }
  setTheme(): void {}
  setSubmitCount(): void {}
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
  subscribeFast(): () => void {
    return () => {};
  }
  isCompactionRegistered(): boolean {
    return true;
  }
  isCompactionEnabled(): boolean {
    return true;
  }
  isCompactionBusy(): boolean {
    return false;
  }
  subscribeCompactionBusy(l: (busy: boolean) => void): () => void {
    this.compactionBusyListeners.add(l);
    return () => this.compactionBusyListeners.delete(l);
  }
  emitCompactionBusy(busy: boolean): void {
    for (const l of this.compactionBusyListeners) l(busy);
  }
  cancelCompaction(): Promise<void> {
    return Promise.resolve();
  }
  subscribeContextUsage(): () => void {
    return () => {};
  }
  getContextUsage(): ContextUsageSnapshot {
    return {
      occupied: 0, window: 200_000, pct: 0, source: 'estimate',
      deltaTokens: 0, windowKnown: true, windowOverridden: false,
    };
  }
  getCompactionSnapshot(): CompactionSnapshot {
    return offCompactionSnapshot();
  }
  getCompactionSummarizerRef(): null {
    return null;
  }
  subscribeCompaction(): () => void {
    return () => {};
  }
  getModelRegistry() {
    return { getModel: () => undefined, getModels: () => [] };
  }
  preflight() {
    return { ok: true as const };
  }
  abort(): void {}
  steer(): void {}
  queueUserMessage(): string {
    this.hasPending = true;
    return 'queued-1';
  }
  hasPendingUserMessages(): boolean {
    return this.hasPending;
  }
  areModelSettingsBlocked(): boolean {
    return false;
  }
  async prompt(): Promise<{ status: 'finished' }> {
    await new Promise<void>((resolve) => { this.promptResolvers.push(resolve); });
    return { status: 'finished' };
  }
  async continue(): Promise<{ status: 'finished' }> {
    this.continueCalls += 1;
    return { status: 'finished' };
  }
  getSkillService(): SkillService {
    return SKILLS;
  }
  setOnSkillsChanged(): void {}
  takeFilePatch(): undefined {
    return undefined;
  }
  subscribeToolOutput(): () => void {
    return () => {};
  }
  subscribeProc(): () => void {
    return () => {};
  }
  subscribeTeam(): () => void {
    return () => {};
  }
  subscribeTodos(): () => void {
    return () => {};
  }
  getTeamSnapshot(): TeamSnapshot | null {
    return null;
  }
  getTodoSnapshot(): TodoSnapshot | null {
    return null;
  }
  getTodoConfig(): TodoConfig {
    return this.todoConfig;
  }
  dispose(): void {}
  stopAllServices(): Promise<never[]> {
    return Promise.resolve([]);
  }
  isBackgroundRegistered(): boolean {
    return false;
  }
  listServices(): never[] {
    return [];
  }
  liveServiceCount(): number {
    return 0;
  }
  reapServicesSync(): void {}
  getAgentMode(): AgentMode {
    return 'build';
  }
  setAgentMode() {
    return { effective: 'build' as AgentMode, pending: null };
  }
  applyPendingMode() {
    return null;
  }
  getPlanStatus() {
    return { effective: 'build' as AgentMode, pending: null, askRoundsUsed: 0, maxAskRounds: 4 };
  }
  saveModelSettings() {
    return { ok: true as const, restartRequired: false };
  }
  saveModelSettingsPatch() {
    return { ok: true as const, restartRequired: false };
  }
  createModelSettingsDraft() {
    return {};
  }
  isRunning(): boolean {
    return this.running;
  }
  forceStop(): void {
    this.forceStopCalls += 1;
    this.runGen += 1;
    this.running = false;
  }
  /**
   * The real controller's port, reduced to the parts this file observes: an
   * interrupt (force-stop, so the generation fence moves) and an emptied queue.
   */
  resetConversation(): Promise<{
    ok: true; interrupted: boolean; archivedPath: null; messagesCleared: number;
  }> {
    this.resetConversationCalls += 1;
    if (this.running) this.forceStop();
    this.hasPending = false;
    const settle = { ok: true as const, interrupted: true, archivedPath: null, messagesCleared: 2 };
    if (!this.heldReset) return Promise.resolve(settle);
    return new Promise((resolve) => {
      this.releaseReset = () => resolve(settle);
      this.heldReset!(() => this.releaseReset?.());
    });
  }
  releaseHeldReset(): void {
    this.releaseReset?.();
  }
}

function mount(fc: ClearController) {
  return render(<App controller={fc as unknown as AgentController} version="0.0.0" />);
}

/** Start a live run the way the App sees one: an `agent_start` event. */
async function startRun(fc: ClearController): Promise<void> {
  fc.running = true;
  void fc.prompt();
  fc.emit({ type: 'agent_start' });
  await delay(30);
}

async function submit(stdin: { write: (s: string) => void }, command: string): Promise<void> {
  stdin.write(command);
  await delay(30);
  stdin.write('\r');
  await delay(60);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the composer during a live run', () => {
  it('accepts /clear: it interrupts instead of refusing', async () => {
    const fc = new ClearController();
    const view = mount(fc);
    await startRun(fc);

    await submit(view.stdin, '/clear');

    const frame = view.lastFrame() ?? '';
    expect(frame).not.toContain(REFUSAL);
    // Reaching the port at all is the proof: the refusal used to fire in
    // `handleSubmit`, before any command body could run.
    expect(fc.resetConversationCalls).toBe(1);
    expect(fc.forceStopCalls).toBe(1);
    view.unmount();
  });

  it('accepts /reset, because it is the same command', async () => {
    const fc = new ClearController();
    const view = mount(fc);
    await startRun(fc);

    await submit(view.stdin, '/reset');

    expect(view.lastFrame() ?? '').not.toContain(REFUSAL);
    expect(fc.resetConversationCalls).toBe(1);
    view.unmount();
  });

  it('still refuses /resume, which switches to a FILE rather than interrupting', async () => {
    const fc = new ClearController();
    const view = mount(fc);
    await startRun(fc);

    await submit(view.stdin, '/resume missing.json');

    // THE HALF THAT MUST NOT MOVE (K-4 / C-4). This assertion is the only
    // surviving evidence of the mid-run refusal rule; deleting it would let
    // `/resume` start replacing history under a running turn.
    expect(view.lastFrame() ?? '').toContain(REFUSAL);
    view.stdin.write(ESC);
    await delay(20);
    view.stdin.write(ESC);
    await delay(40);
    view.unmount();
  });
});

describe('what a cleared conversation can still receive', () => {
  it('drops the abandoned run\'s late events instead of painting them', async () => {
    const fc = new ClearController();
    const view = mount(fc);
    await startRun(fc);

    await submit(view.stdin, '/clear');

    // THE ENGINE KEEPS TALKING WHILE IT UNWINDS. `forceStop()` bumped the
    // generation, so every one of these belongs to a run the user abandoned and
    // must not reach the transcript they are now looking at.
    fc.emit({ type: 'turn_start' });
    fc.emit({
      type: 'message_update',
      streamEvent: { type: 'text_delta', delta: 'ZOMBIE_TEXT_FROM_THE_OLD_RUN' },
    });
    await delay(60);

    expect(view.lastFrame() ?? '').not.toContain('ZOMBIE_TEXT_FROM_THE_OLD_RUN');
    view.unmount();
  });

  it('does not drain a queue that belongs to the conversation being replaced', async () => {
    const fc = new ClearController();
    // Hold the reset open so a compaction settles WHILE the command is running -
    // the exact window `switchingConversation` exists to cover (B-6 / C-3).
    const held: { release: (() => void) | null } = { release: null };
    fc.heldReset = (done) => { held.release = done; };
    // A message queued in the OLD conversation, and an IDLE engine: with a run in
    // flight `interactionPhase` would already block the drain, which would make
    // this test pass for the wrong reason. Idle is the case the old guard missed.
    fc.hasPending = true;
    const view = mount(fc);
    await delay(40);

    view.stdin.write('/clear');
    await delay(30);
    view.stdin.write('\r');
    await delay(60);
    expect(fc.resetConversationCalls).toBe(1);

    // The compaction settles mid-clear. Without the lock this is the instant the
    // old queue would be `continue()`d into the conversation being replaced.
    fc.emitCompactionBusy(false);
    await delay(50);
    expect(fc.continueCalls).toBe(0);

    held.release?.();
    await delay(80);
    // And once it settles the queue is empty, so there is nothing left to drain.
    expect(fc.continueCalls).toBe(0);
    expect(fc.hasPending).toBe(false);
    view.unmount();
  });
});
