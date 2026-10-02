import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import stringWidth from 'string-width';
import type { AgentEvent, ModelInfo } from '@aragon-agent/core';
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

const ESC = '\u001B';
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

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

class FakeController {
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  onPrompt: ((text: string) => Promise<void>) | null = null;
  config: CliConfig = { ...CONFIG, reducedMotion: true, color: false, colorLevel: 0, unicode: false };
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

  isCompactionRegistered(): boolean {
    return false;
  }
  isCompactionEnabled(): boolean {
    return false;
  }

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


  procListeners = new Set<ProcEventListener>();
  subscribeProc(l: ProcEventListener): () => void {
    this.procListeners.add(l);
    return () => this.procListeners.delete(l);
  }
  emitProc(event: ProcEvent): void {
    for (const l of this.procListeners) l(event);
  }

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
  teamSnapshot: TeamSnapshot | null = null;
  getTeamSnapshot(): TeamSnapshot | null { return this.teamSnapshot; }
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
  setTodoConfig(patch: Partial<TodoConfig>): void {
    this.todoConfig = { ...this.todoConfig, ...patch };
    this.config = { ...this.config, todo: this.todoConfig };
  }
  clearTodos(): void {
    this.todoSnapshot = null;
    this.emitTodo({ type: 'cleared', reason: 'user' });
  }
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

const PLAN: TodoSnapshot = {
  items: Array.from({ length: 20 }, (_, i) => ({
    content: `Step ${i}`, activeForm: 'ANCHOR working',
    status: i < 9 ? 'completed' : i === 9 ? 'in_progress' : 'pending',
  })), total: 20, doneCount: 9, activeIndex: 9, updatedAt: 1,
};
const TEAM: TeamSnapshot = {
  dispatchId: 'd', active: true, requested: 8, startedAt: 1, messageCount: 1,
  lastMessage: { from: 'a', to: 'b', subject: 'mail\nupdate', body: '', at: 1 },
  runs: Array.from({ length: 8 }, (_, i) => ({
    label: `a${i}`, description: 'work\r\nnext', tier: 'main', phase: 'thinking', turns: 0,
    toolCalls: 0, filesTouched: [], messagesSent: 0, usage: { inputTokens: 0, outputTokens: 0 },
  })),
};

function mountApp(fc: FakeController) {
  const frames: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: 100, rows: 20, isTTY: true,
    write: (s: string) => { if (s.includes('\n')) frames.push(stripAnsi(s)); return true; },
  });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode() {}, ref() {}, unref() {},
  });
  const instance = render(<App controller={fc as unknown as AgentController}
    version="0.0.0" mode="fullscreen" />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  return { ...instance, stdout, stdin, frames, frame: () => frames.at(-1) ?? '' };
}

function railLines(frame: string, width = 15, cols = 100): string[] {
  return frame.split('\n').map(line => line.slice(cols - width)).filter(line => line.startsWith('|'));
}

describe('真实 App 的 TODO 布局接线', () => {
  it('恢复事件、团队八行、菜单与窄屏往返均重算同一右栏预算', async () => {
    const fc = new FakeController();
    const app = mountApp(fc);
    try {
      await delay(100);
      fc.todoSnapshot = PLAN;
      fc.emitTodo({ type: 'updated', snapshot: PLAN });
      await delay(100);
      expect(railLines(app.frame())).toHaveLength(12);
      expect(railLines(app.frame()).join('\n')).toContain('9/20');
      fc.teamSnapshot = TEAM;
      for (const listener of fc.teamListeners) listener({ type: 'agent_update',
        dispatchId: 'd', run: TEAM.runs[0]! });
      await delay(100);
      expect(railLines(app.frame())).toHaveLength(4);
      expect(railLines(app.frame()).join('\n'), app.frame()).toContain('ANCHOR');
      expect(railLines(app.frame()).join('\n')).toContain('-9 +9');
      // A hidden /c menu must submit the typed buffer, not /clear.
      app.stdin.write('/c'); await delay(80);
      expect(railLines(app.frame())).toHaveLength(4);
      app.stdin.write('\r'); await delay(100);
      expect(railLines(app.frame())).toHaveLength(4);
      expect(app.frame()).toContain('Unknown command');
      app.stdin.write('\u001b[5~'); await delay(100);
      expect(app.frame()).toMatch(/v \d+ new/);
      for (const [cols, width] of [[75, 0], [76, 14], [100, 15], [200, 30]]) {
        app.stdout.columns = cols!;
        app.stdout.emit('resize'); await delay(120);
        const lines = railLines(app.frame(), width!, cols!);
        expect(lines.length, app.frame()).toBe(width ? 4 : 0);
        if (cols! >= 100) expect(app.frame()).toMatch(/v \d+ new/);
        for (const line of app.frame().split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(cols!);
      }
      fc.emitTodo({ type: 'cleared', reason: 'reset' }); await delay(80);
      expect(railLines(app.frame(), 30, 200)).toEqual([]);
    } finally { app.unmount(); app.cleanup(); }
  });

  it('团队八行遇到长草稿时折叠，清空草稿恢复展开且不清空 TODO', async () => {
    const fc = new FakeController();
    const app = mountApp(fc);
    try {
      await delay(100);
      fc.emitTodo({ type: 'updated', snapshot: PLAN });
      fc.teamSnapshot = TEAM;
      for (const listener of fc.teamListeners) listener({ type: 'agent_update',
        dispatchId: 'd', run: TEAM.runs[0]! });
      await delay(100);
      expect(railLines(app.frame())).toHaveLength(4);
      app.stdin.write('long draft '.repeat(40)); await delay(150);
      expect(app.frame()).toContain('8 running');
      expect(app.frame()).not.toContain('+3 more (3 running)');
      expect(railLines(app.frame()).join('\n')).toContain('ANCHOR');
      expect(app.frame()).toContain('idle');
      app.stdin.write('\u0015'); await delay(160);
      expect(app.frame()).toContain('+3 more (3 running)');
      expect(railLines(app.frame())).toHaveLength(4);
    } finally { app.unmount(); app.cleanup(); }
  });

  it('idle 菜单、overlay 及 20→11→20 重挂保持底栏并清除旧行报告', async () => {
    const fc = new FakeController();
    const app = mountApp(fc);
    try {
      await delay(100);
      fc.emitTodo({ type: 'updated', snapshot: PLAN }); await delay(80);
      app.stdin.write('/'); await delay(100);
      expect(railLines(app.frame())).toHaveLength(3);
      app.stdin.write('\u001b'); await delay(100);
      expect(railLines(app.frame())).toHaveLength(12);
      app.stdin.write('\u0015'); await delay(80);
      app.stdin.write('/help'); await delay(80);
      app.stdin.write('\r'); await delay(100);
      expect(railLines(app.frame())).toEqual([]);
      expect(app.frame()).toContain('Help');
      app.stdin.write('\u001b'); await delay(100);
      expect(railLines(app.frame())).toHaveLength(12);
      app.stdin.write('/'); await delay(80);
      app.stdout.rows = 11; app.stdout.emit('resize'); await delay(120);
      expect(app.frame()).toContain('Terminal too small');
      app.stdout.rows = 20; app.stdout.emit('resize'); await delay(120);
      expect(railLines(app.frame())).toHaveLength(12);
      expect(app.frame()).not.toContain('Maximum update depth');
      const count = app.frames.length;
      await delay(160);
      expect(app.frames.length - count).toBeLessThanOrEqual(1);
      for (const frame of app.frames) {
        expect(frame.split('\n').length).toBeLessThanOrEqual(19);
        if (!frame.includes('Terminal too small')) expect(frame).toContain('idle');
      }
      app.stdin.write('/todo panel off'); await delay(80);
      app.stdin.write('\r'); await delay(100);
      expect(railLines(app.frame())).toEqual([]);
      app.stdin.write('/todo panel on'); await delay(80);
      app.stdin.write('\r'); await delay(100);
      expect(railLines(app.frame())).toHaveLength(12);
    } finally { app.unmount(); app.cleanup(); }
  });
});
