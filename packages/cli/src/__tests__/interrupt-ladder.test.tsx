/**
 * The interrupt ladder (§7.4 / AC-26..AC-30) and the regressions the design
 * review found (§7.6 / AC-35, AC-36, AC-43, AC-44).
 *
 * THE WHOLE SUITE IS PARAMETERISED OVER `bash.background: true | false` (AC-44),
 * because the ladder is UNCONDITIONAL (D-9 / P1-6). G2 and G3 are promised
 * whatever the services flag says, and a user who turned background services off
 * has not asked for a less interruptible agent. A build that constructed the
 * supervisor only when the flag was on passes the `true` half and fails the
 * `false` half at rung two - which is exactly the shape of bug this parameter
 * exists to catch.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import type { AgentEvent } from '@aragon-agent/core';
import { App } from '../ui/App.js';
import type { AgentController } from '../agent/controller.js';
import type { ContextUsageSnapshot } from '../compaction/types.js';
import { hintTextForTest } from '../ui/Composer.js';
import { pickGlyphs } from '../ui/glyphs.js';
import {
  DEFAULT_BASH_CONFIG,
  DEFAULT_COMPACTION_CONFIG,
  DEFAULT_FAST_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_SKILLS_CONFIG,
  DEFAULT_TEAM_CONFIG,
  DEFAULT_TODO_CONFIG,
  DEFAULT_UPDATE_CONFIG,
  type CliConfig,
} from '../config/schema.js';
import type { ProcEvent, ProcEventListener, ServiceSnapshot } from '../proc/types.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ESC = '';
const CTRL_C = '';

function config(background: boolean): CliConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    baseUrl: undefined,
    thinkingLevel: 'off',
    showThinking: false,
    liveToolOutput: false,
    theme: 'auto',
    reducedMotion: false,
    exitTranscript: true,
    transcriptWindow: 300,
    transcriptRetain: 1000,
    renderGovernor: true,
    maxRenderInterval: 120,
    density: 'compact',
    hints: true,
    mouse: true,
    mouseSelect: true,
    diffRender: true,
    fullscreen: false,
    submitCount: 0,
    toolTimeoutMs: 180_000,
    idleTimeoutMs: 300_000,
    scrollResumeMs: 2000,
    startInPlanMode: false,
    planModeMaxAskRounds: 4,
    planModeHumanTimeoutMs: 1_800_000,
    skills: DEFAULT_SKILLS_CONFIG,
    skillsRuntime: {},
    log: { level: 'off', dir: null, maxFiles: 5, maxFileBytes: 1_000_000, redact: true },
    team: DEFAULT_TEAM_CONFIG,
    todo: DEFAULT_TODO_CONFIG,
    retry: DEFAULT_RETRY_CONFIG,
    fast: DEFAULT_FAST_CONFIG,
    update: DEFAULT_UPDATE_CONFIG,
    compaction: DEFAULT_COMPACTION_CONFIG,
    bash: { ...DEFAULT_BASH_CONFIG, background },
    cwd: process.cwd(),
    color: true,
    unicode: true,
  } as unknown as CliConfig;
}

function snapshot(over: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    id: 's1',
    toolCallId: 'c1',
    command: 'npm run dev',
    cwd: '/tmp',
    pid: 1,
    status: 'ready',
    startedAt: Date.now(),
    exitCode: null,
    signal: null,
    rows: [],
    rowsSeen: 0,
    truncated: false,
    ...over,
  };
}

/**
 * The smallest controller `App` can mount against.
 *
 * `forceStop` DOES NOT EMIT `agent_end`, which is the whole simulation: rung two
 * exists for a run the engine cannot unwind, so a fake that helpfully ended the
 * run would test the easy case and miss the one the screenshot was taken of.
 */
class LadderController {
  listeners = new Set<(e: AgentEvent) => void>();
  procListeners = new Set<ProcEventListener>();
  abortCalls = 0;
  forceStopCalls = 0;
  stopAllCalls: Array<{ force?: boolean }> = [];
  promptCalls: string[] = [];
  runGen = 0;
  running = false;
  cfg: CliConfig;

  constructor(background: boolean) {
    this.cfg = config(background);
  }

  emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }
  emitProc(event: ProcEvent): void {
    for (const l of this.procListeners) l(event);
  }

  subscribe(l: (e: AgentEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  subscribeProc(l: ProcEventListener): () => void {
    this.procListeners.add(l);
    return () => this.procListeners.delete(l);
  }
  subscribeTeam(): () => void {
    return () => {};
  }
  subscribeTodos(): () => void {
    return () => {};
  }
  subscribeFast(): () => void {
    return () => {};
  }
  subscribeCompaction(): () => void {
    return () => {};
  }
  subscribeToolOutput(): () => void {
    return () => {};
  }

  get runGeneration(): number {
    return this.runGen;
  }
  abort(): void {
    this.abortCalls += 1;
  }
  forceStop(): void {
    this.forceStopCalls += 1;
    this.abortCalls += 1;
    this.runGen += 1;
    // DELIBERATELY NO `agent_end`. See the class comment.
  }
  stopAllServices(opts: { force?: boolean } = {}): Promise<never[]> {
    this.stopAllCalls.push(opts);
    return Promise.resolve([]);
  }
  isBackgroundRegistered(): boolean {
    return this.cfg.bash.background;
  }
  listServices(): never[] {
    return [];
  }
  liveServiceCount(): number {
    return 0;
  }
  reapServicesSync(): void {}
  getServiceSnapshot(): undefined {
    return undefined;
  }
  readServiceLog(): undefined {
    return undefined;
  }
  stopService(): Promise<never[]> {
    return Promise.resolve([]);
  }

  prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
    return Promise.resolve();
  }
  steer(): void {}
  isRunning(): boolean {
    return this.running;
  }
  preflight(): { ok: true } {
    return { ok: true };
  }
  getConfig(): CliConfig {
    return this.cfg;
  }
  getCwd(): string {
    return this.cfg.cwd;
  }
  getModelInfo() {
    return { contextWindow: 200_000, cost: undefined, maxOutputTokens: 8192 };
  }
  getModelRegistry() {
    return { getModel: () => undefined, getModels: () => [] };
  }
  hasApiKey(): boolean {
    return true;
  }
  setSubmitCount(): void {}
  getAgentMode(): 'build' {
    return 'build';
  }
  setAgentMode() {
    return { effective: 'build' as const, pending: null };
  }
  applyPendingMode(): null {
    return null;
  }
  getPlanStatus() {
    return { effective: 'build' as const, pending: null, askRoundsUsed: 0, maxAskRounds: 4 };
  }
  getTodoSnapshot(): null {
    return null;
  }
  getTodoConfig() {
    return this.cfg.todo;
  }
  getTeamSnapshot(): null {
    return null;
  }
  isTeamBusy(): boolean {
    return false;
  }
  getSkillService() {
    // The same three members `app.test.tsx`'s EMPTY_SKILL_SERVICE supplies:
    // `registerSkillCommands` iterates `list()` during `App`'s first render,
    // so a stub missing it throws before the first frame.
    return {
      list: () => [],
      untrustedDirs: () => [],
      getRegistry: () => ({ activeNames: [] as string[] }),
    };
  }
  setOnSkillsChanged(): void {}
  takeFilePatch(): undefined {
    return undefined;
  }
  listTools(): never[] {
    return [];
  }
  // The remaining members `App` reads on mount or during render. They are all
  // read UNCONDITIONALLY, so a stub missing any of them throws before the first
  // frame - the trap `app.test.tsx`'s own stub records at length, and one
  // TypeScript cannot catch because the controller arrives through an `as`.
  getFastStatus() {
    return { registered: false as const, snapshot: null };
  }
  getCompactionSnapshot(): null {
    return null;
  }
  getCompactionSummarizerRef(): undefined {
    return undefined;
  }
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
  getModelInfoFor() {
    return { contextWindow: 200_000, cost: undefined, maxOutputTokens: 8192 };
  }
  isPricedModel(): boolean {
    return false;
  }
  setTheme(): void {}
  setModel(): void {}
  setThinkingLevel(): void {}
  setMaxTokens(): void {}
  setApiKey(): void {}
  setFastConfig() {
    return this.cfg.fast;
  }
  setCompactionConfig() {
    return this.cfg.compaction;
  }
  setCompactionEnabled(): void {}
  dispose(): void {}
}

function mount(controller: LadderController) {
  return render(
    <App
      controller={controller as unknown as AgentController}
      version="0.0.0"
      mode="inline"
      initialPrompt="go"
    />,
  );
}

/** A run that starts and never ends - the wedged engine this ladder is for. */
function startWedgedRun(controller: LadderController): void {
  controller.running = true;
  controller.emit({ type: 'agent_start' } as AgentEvent);
  controller.emit({ type: 'turn_start' } as AgentEvent);
}

describe.each([true, false])('the interrupt ladder (bash.background: %s)', (background) => {
  it('AC-26: one Esc calls abort ONCE and names the second press', async () => {
    const controller = new LadderController(background);
    const { stdin, lastFrame, unmount } = mount(controller);
    await delay(40);
    startWedgedRun(controller);
    await delay(40);

    stdin.write(ESC);
    await delay(40);
    expect(controller.abortCalls).toBe(1);
    expect(controller.forceStopCalls).toBe(0);
    expect(lastFrame() ?? '').toContain('Esc again to force-stop');
    unmount();
  });

  it('AC-27: a second Esc force-stops and the view reads `idle` - with NO agent_end', async () => {
    // THE WEDGED-ENGINE SIMULATION. `forceStop` on the fake emits nothing, so
    // the only thing that can return the view to idle is the App's own
    // unconditional local `runEnd` - which is the belt-and-braces half of D-10.
    const controller = new LadderController(background);
    const { stdin, lastFrame, unmount } = mount(controller);
    await delay(40);
    startWedgedRun(controller);
    await delay(40);

    stdin.write(ESC);
    await delay(40);
    stdin.write(ESC);
    await delay(60);

    expect(controller.forceStopCalls).toBe(1);
    expect(lastFrame() ?? '').toContain('idle');
    unmount();
  });

  it('AC-28: a second Esc AFTER the run ended does not force-stop', async () => {
    // R-9: rung two only fires while the run is STILL running after rung one,
    // i.e. only when the first press provably failed. In every healthy run the
    // second press lands on the idle branch and does nothing.
    const controller = new LadderController(background);
    const { stdin, unmount } = mount(controller);
    await delay(40);
    startWedgedRun(controller);
    await delay(40);

    stdin.write(ESC);
    await delay(20);
    controller.running = false;
    controller.emit({ type: 'agent_end', messages: [] } as unknown as AgentEvent);
    await delay(40);
    stdin.write(ESC);
    await delay(40);

    expect(controller.forceStopCalls).toBe(0);
    unmount();
  });

  it('AC-35 (P0-1): after a force-stop, the next message starts a new run', async () => {
    // THE STEP AN IMPLEMENTER IS MOST LIKELY TO SKIP, because the screen looks
    // correct right up until the keystroke. On a build without `runGeneration`
    // and a total `prompt()`, this reaches `Agent.prompt()`'s synchronous throw
    // while the engine is still running, the rejection is unhandled, and
    // `logging/install.ts` turns that into a process exit.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const controller = new LadderController(background);
    const { stdin, unmount } = mount(controller);
    await delay(40);
    startWedgedRun(controller);
    await delay(40);
    stdin.write(ESC);
    await delay(20);
    stdin.write(ESC);
    await delay(60);

    stdin.write('next message');
    await delay(20);
    stdin.write('\r');
    await delay(80);

    expect(controller.promptCalls).toContain('next message');
    expect(unhandled).toEqual([]);
    process.off('unhandledRejection', onUnhandled);
    unmount();
  });

  it('AC-36 (P1-7): engine events AFTER a force-stop leave the view idle', async () => {
    // Between rung two and the engine actually unwinding, `turn_start` and
    // `agent_end` still arrive - and `turnStart` sets `status: 'running'` again,
    // so without the generation guard the view bounces straight back out of the
    // `idle` AC-27 checked one frame earlier.
    const controller = new LadderController(background);
    const { stdin, lastFrame, unmount } = mount(controller);
    await delay(40);
    startWedgedRun(controller);
    await delay(40);
    stdin.write(ESC);
    await delay(20);
    stdin.write(ESC);
    await delay(60);

    controller.emit({ type: 'turn_start' } as AgentEvent);
    controller.emit({ type: 'agent_end', messages: [] } as unknown as AgentEvent);
    await delay(60);

    expect(lastFrame() ?? '').toContain('idle');
    unmount();
  });

  it('AC-29: Ctrl+C with live services stops them and does NOT arm exit', async () => {
    const controller = new LadderController(background);
    const { stdin, lastFrame, unmount } = mount(controller);
    await delay(40);
    controller.emitProc({ type: 'started', service: snapshot({ id: 's1' }) });
    controller.emitProc({ type: 'started', service: snapshot({ id: 's2' }) });
    await delay(40);

    stdin.write(CTRL_C);
    await delay(40);
    expect(controller.stopAllCalls).toHaveLength(1);
    expect(controller.stopAllCalls[0]).toEqual({});
    // Stopping a server and quitting the app are different intentions, and the
    // hint row still names an exit clause so quitting stays discoverable (P1-4).
    expect(lastFrame() ?? '').not.toContain('Press Ctrl+C again to exit');
    unmount();
  });

  it('AC-30: Ctrl+C with NO services behaves exactly as today', async () => {
    const controller = new LadderController(background);
    const { stdin, lastFrame, unmount } = mount(controller);
    await delay(40);
    stdin.write(CTRL_C);
    await delay(40);
    expect(controller.stopAllCalls).toHaveLength(0);
    expect(lastFrame() ?? '').toContain('Press Ctrl+C again to exit');
    unmount();
  });
});

describe('AC-43 (P1-4): the hint row never loses its exit affordance', () => {
  const glyphs = pickGlyphs({ colorLevel: 3, unicode: true });

  it('the running row with zero services is byte-identical to today', () => {
    const row = hintTextForTest({
      running: true,
      submitCount: 0,
      glyphs,
      mode: 'build',
      toggleKey: 'shift+tab',
      services: 0,
    });
    expect(row).toBe(
      [`${glyphs.enterKey} steer`, 'esc abort', `ctrl+c${glyphs.times}2 exit`].join(
        ` ${glyphs.midDot} `,
      ),
    );
  });

  it('the running row with two services names abort, stop AND exit', () => {
    // v1 replaced the exit clause with `ctrl+c stop 2`, deleting the only
    // visible way to quit at exactly the moment Ctrl+C stops meaning "quit" -
    // on the screen a user reaches when something has already gone wrong.
    const row = hintTextForTest({
      running: true,
      submitCount: 0,
      glyphs,
      mode: 'build',
      toggleKey: 'shift+tab',
      services: 2,
    });
    expect(row).toContain('esc abort');
    expect(row).toContain('ctrl+c stop 2');
    expect(row).toContain('exit');
    // Rung two is NAMED: the whole point of the ladder is that the first press
    // can fail, and a user who does not know there is a second one is left
    // exactly where the reported screenshot left them.
    expect(row).toContain('force');
  });

  it('the idle row gains a leading stop clause and keeps it when FADED', () => {
    const faded = hintTextForTest({
      running: false,
      submitCount: 999,
      glyphs,
      mode: 'build',
      toggleKey: 'shift+tab',
      services: 1,
    });
    expect(faded.startsWith('ctrl+c stop 1')).toBe(true);
    const fresh = hintTextForTest({
      running: false,
      submitCount: 0,
      glyphs,
      mode: 'build',
      toggleKey: 'shift+tab',
      services: 1,
    });
    expect(fresh.startsWith('ctrl+c stop 1')).toBe(true);
  });

  it('the idle row with no services is unchanged', () => {
    const row = hintTextForTest({
      running: false,
      submitCount: 0,
      glyphs,
      mode: 'build',
      toggleKey: 'shift+tab',
      services: 0,
    });
    expect(row).not.toContain('ctrl+c stop');
  });
});

void vi;
