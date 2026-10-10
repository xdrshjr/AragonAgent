/**
 * End-to-end wheel routing (wheel-scrolls-transcript-only §8.1).
 *
 * Driven through a hand-rolled `MouseSource`, so there is no real terminal and
 * no raw mode. The reported ROW is passed through faithfully and then ignored by
 * the router on purpose: that is the whole contract this suite exists to pin, so
 * the rows below are exercised precisely BECAUSE they used to mean different
 * things (§4.1).
 */

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Box, Text, render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import type { AgentEvent, ModelInfo } from '@aragon-agent/core';

// Keep the app hermetic — never write the developer's real config file.
// `vi.hoisted` because `vi.mock` factories are hoisted above every other
// statement, so they cannot close over an ordinary module-level `let`.
const store = vi.hoisted(() => ({
  /**
   * The §6.1 gate, now a VERSION rather than a boolean
   * (tui-selection-and-scroll-follow P1-8). It starts at a number high enough to
   * read as "already seen", which keeps the one-shot out of every other frame
   * assertion in this file; the case that is ABOUT it lowers it to 0.
   *
   * A VERSION AND NOT THE OLD FLAG, because the audience for the corrected text
   * is exactly the set of users who already have the old boolean `true` on
   * disk — so reading it would have made the new notice inert for everyone it is
   * for, in silence.
   */
  mouseNoticeVersion: 99,
  /**
   * The R-1 notice's OWN one-shot key, now a VERSION rather than a boolean. It
   * starts at "already seen the current text" for the same reason
   * `mouseNoticeSeen` starts at `true` — to keep a one-shot out of every other
   * frame assertion — but the two are deliberately independent, and the case
   * that matters sets exactly one of them. Seeded from the real constant just
   * below the imports, so a future bump cannot quietly re-arm the notice inside
   * every unrelated case in this file.
   */
  vtInputNoticeVersion: 0,
  writes: [] as Record<string, unknown>[],
  /**
   * Calls to `setMouseNoticeSeen`, the §6.1 gate's write path since
   * config-state-separation moved it out of `config.json`.
   *
   * IT HAS TO BE OBSERVED SOMEWHERE. The three assertions below used to watch
   * `store.writes` for `{ mouseNoticeSeen: true }`; two of them are NEGATIVE
   * (`not.toContainEqual`), so leaving them pointed at `updatePersistedConfig`
   * after the write moved would have left them green forever while guarding
   * an object nothing ever writes any more (RV-4).
   */
  noticeSeenWrites: [] as number[],
  /** Calls to `setVtInputNoticeVersion`, the R-1 notice's write path. */
  vtNoticeSeenWrites: [] as number[],
}));
vi.mock('../config/store.js', () => ({
  updatePersistedConfig: (patch: Record<string, unknown>) => {
    store.writes.push(patch);
    return {};
  },
  getSessionsDir: () => '/tmp/aragon-sessions',
  getConfigPath: () => '/tmp/aragon-config.json',
  readConfigFile: () => ({ config: {} }),
}));
// The §6.1 gate: `mouseNoticeSeen` reading as already-seen by default keeps the
// one-time notice out of every other frame assertion below.
vi.mock('../config/ui-state.js', () => ({
  getMouseNoticeVersion: () => store.mouseNoticeVersion,
  setMouseNoticeVersion: (version: number) => {
    store.noticeSeenWrites.push(version);
  },
  getVtInputNoticeVersion: () => store.vtInputNoticeVersion,
  setVtInputNoticeVersion: (version: number) => {
    store.vtNoticeSeenWrites.push(version);
  },
  bumpSubmitCount: () => 1,
}));
vi.mock('../config/prompt-history.js', () => ({
  loadPromptHistory: () => [...HISTORY],
  appendPrompt: (text: string) => [...HISTORY.filter((p) => p !== text), text],
}));

const { App } = await import('../ui/App.js');
const { supportsWindowsVtInput } = await import('../ui/win-vt-input.js');
const { vtInputDeadNotice, MOUSE_NOTICE_VERSION, VT_INPUT_NOTICE_VERSION } = await import(
  '../ui/use-startup-notices.js'
);
const { MODE_TOGGLE_KEYS } = await import('../agent/agent-mode.js');
// Seeded here rather than in the `vi.hoisted` literal above: hoisting runs
// before any import, so the constant is not available there yet.
store.vtInputNoticeVersion = VT_INPUT_NOTICE_VERSION;
const { tryCreateStdinFilter } = await import('../input/stdin-filter.js');
const { useWheelRouting } = await import('../ui/use-wheel-routing.js');
const { getTheme } = await import('../ui/theme.js');
const { pickGlyphs } = await import('../ui/glyphs.js');
const { ScrollViewport } = await import('../ui/layout/ScrollViewport.js');
const { MIN_INDICATOR_COLS } = await import('../ui/layout/ScrollIndicator.js');

import type { AgentController } from '../agent/controller.js';
import type { Overlay } from '../agent/reducer.js';
import type { WheelEvent } from '../input/mouse-events.js';
import type { MouseSource } from '../input/stdin-filter.js';
import type { ScrollIntent } from '../ui/layout/scroll.js';
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
} from '../config/schema.js';
import type { SkillService } from '../skills/service.js';
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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Written as an escape sequence, never as a raw control byte.
 *
 * `app.test.tsx` writes its arrow keys as literal `\x1b` bytes, which READ back
 * as a bare `[A` in every viewer that hides control characters — and a bare
 * `[A` is not an arrow key at all: Ink's `parseKeypress` requires the ESC, so
 * the two characters get typed into the draft instead and the assertion that
 * follows is quietly about something else. `\u001B` cannot be lost that way.
 */
const ESC = '\u001B';
const KEY_UP = `${ESC}[A`;
const KEY_DOWN = `${ESC}[B`;
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const CAPS = { colorLevel: 3 as const, unicode: true };
const THEME = getTheme('cool', CAPS);
const GLYPHS = pickGlyphs(CAPS);

/**
 * Two arbitrary rows on a 24-row terminal, kept as literals for one reason: on
 * 0.5.x these two routed a notch to two DIFFERENT destinations, and the router
 * must now treat them identically (D-6). `COMPOSER_ROW` is a row the bottom
 * chrome occupies and `TRANSCRIPT_ROW` is one the transcript occupies; neither
 * number means anything to the code under test any more, and that is the point.
 * `HEADER_ROW` is the top edge, exercised for the same reason.
 */
const COMPOSER_ROW = 17;
const TRANSCRIPT_ROW = 9;
const HEADER_ROW = 1;

// ---------------------------------------------------------------------------
// A synthetic mouse source: the seam the whole suite is built on.
// ---------------------------------------------------------------------------

function fakeMouseSource() {
  const listeners = new Set<(e: WheelEvent) => void>();
  const source: MouseSource = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const wheel = (
    dir: 'up' | 'down',
    y: number,
    modifiers: { shift?: boolean } = {},
  ): void => {
    const event: WheelEvent = {
      kind: 'wheel',
      dir,
      x: 20,
      y,
      shift: modifiers.shift ?? false,
      alt: false,
      ctrl: false,
    };
    for (const listener of [...listeners]) listener(event);
  };
  return { source, wheel, subscriberCount: () => listeners.size };
}

// ---------------------------------------------------------------------------
// Part A — the routing table and the coalescer, in isolation.
// ---------------------------------------------------------------------------

interface HostCalls {
  scroll: { kind: ScrollIntent; repeat: number }[];
  overlayScroll: number[];
}

function mountRouter(initialOverlay: Overlay | null = null) {
  const mouse = fakeMouseSource();
  const calls: HostCalls = { scroll: [], overlayScroll: [] };
  let overlay: Overlay | null = initialOverlay;
  let captured = false;
  let clear = (): void => {};

  function Host(): React.ReactElement {
    const routing = useWheelRouting({
      mouseSource: mouse.source,
      isPointerCaptured: () => captured,
      getOverlay: () => overlay,
      onScroll: (kind, repeat) => calls.scroll.push({ kind, repeat }),
      onOverlayScroll: (delta) => calls.overlayScroll.push(delta),
    });
    clear = routing.clearCoalescer;
    return <Text>host</Text>;
  }

  const instance = render(<Host />);
  return {
    ...mouse,
    calls,
    waitUntilSubscribed: () =>
      vi.waitFor(() => expect(mouse.subscriberCount()).toBe(1)),
    setCaptured: (next: boolean) => { captured = next; },
    setOverlay: (next: Overlay | null) => {
      overlay = next;
    },
    clearCoalescer: () => clear(),
    unmount: instance.unmount,
  };
}

describe('routing table (§4.1)', () => {
  it('routes a transcript-row notch to the transcript, three rows per notch', async () => {
    const r = mountRouter();
    await r.waitUntilSubscribed();
    r.wheel('up', TRANSCRIPT_ROW);
    await delay(40);
    expect(r.calls.scroll).toEqual([{ kind: 'lineUp', repeat: 3 }]);
    r.unmount();
  });

  it('routes a notch from EVERY row to the transcript, the composer row included', async () => {
    // The requirement, stated as a test: a notch over the composer scrolls,
    // like every other row. On 0.5.x `COMPOSER_ROW` stepped prompt history and
    // ate the user's draft instead (§1), and `HEADER_ROW` proves the collapse is
    // not a boundary moved by one row.
    for (const row of [TRANSCRIPT_ROW, COMPOSER_ROW, HEADER_ROW]) {
      const r = mountRouter();
      // eslint-disable-next-line no-await-in-loop
      await r.waitUntilSubscribed();
      r.wheel('up', row);
      // eslint-disable-next-line no-await-in-loop
      await delay(40);
      expect(r.calls.scroll, `row ${row}`).toEqual([{ kind: 'lineUp', repeat: 3 }]);
      r.unmount();
    }
  });

  it('maps wheel-down over the transcript to lineDown', async () => {
    const r = mountRouter();
    await r.waitUntilSubscribed();
    r.wheel('down', TRANSCRIPT_ROW);
    await delay(40);
    expect(r.calls.scroll).toEqual([{ kind: 'lineDown', repeat: 3 }]);
    r.unmount();
  });

  it('shift+wheel scrolls by a page', async () => {
    const r = mountRouter();
    await r.waitUntilSubscribed();
    r.wheel('up', TRANSCRIPT_ROW, { shift: true });
    await delay(40);
    // One page per notch, not three: the two granularities have different units.
    expect(r.calls.scroll).toEqual([{ kind: 'pageUp', repeat: 1 }]);
    r.unmount();
  });

  it('scrolls a controlled overlay instead of the transcript', async () => {
    for (const overlay of ['help', 'settings', 'plan', 'queue'] as const) {
      const r = mountRouter(overlay);
      await r.waitUntilSubscribed();
      r.wheel('up', TRANSCRIPT_ROW);
      r.wheel('down', TRANSCRIPT_ROW, { shift: true });
      await delay(40);
      expect(r.calls.overlayScroll, overlay).toEqual([-3, 8]);
      expect(r.calls.scroll, overlay).toEqual([]);
      r.unmount();
    }
  });

  it('leaves overlays that own their own keys alone', async () => {
    // R-11, matching the keyboard handler's existing exclusion.
    for (const overlay of ['model', 'confirm', 'question'] as const) {
      const r = mountRouter(overlay);
      await r.waitUntilSubscribed();
      r.wheel('up', TRANSCRIPT_ROW);
      await delay(40);
      expect(r.calls.overlayScroll, overlay).toEqual([]);
      expect(r.calls.scroll, overlay).toEqual([]);
      r.unmount();
    }
  });

  it('scrolls the overlay from the composer row too', async () => {
    // D-3, the one behaviour delta beyond the bug report: on 0.5.x this notch
    // was ignored outright, because the row said "composer" and stepping a
    // hidden draft was worse than doing nothing. Nothing steps a draft any more,
    // so the reason evaporates and the overlay — the only scrollable thing on
    // screen — gets the notch.
    const r = mountRouter('help');
    await r.waitUntilSubscribed();
    r.wheel('up', COMPOSER_ROW);
    await delay(40);
    expect(r.calls.overlayScroll).toEqual([-3]);
    expect(r.calls.scroll).toEqual([]);
    r.unmount();
  });

  it('unsubscribes from the source on unmount', async () => {
    const r = mountRouter();
    await r.waitUntilSubscribed();
    expect(r.subscriberCount()).toBe(1);
    r.unmount();
    await delay(10);
    expect(r.subscriberCount()).toBe(0);
  });
});

describe('coalescing (§4.3)', () => {
  it('folds a burst into ONE intent carrying the total repeat', async () => {
    const r = mountRouter();
    await r.waitUntilSubscribed();
    r.wheel('up', TRANSCRIPT_ROW);
    r.wheel('up', TRANSCRIPT_ROW);
    r.wheel('up', TRANSCRIPT_ROW);
    await delay(40);
    expect(r.calls.scroll).toEqual([{ kind: 'lineUp', repeat: 9 }]);
    r.unmount();
  });

  it('flushes immediately when the direction changes', async () => {
    // A fast up-then-down must never cancel itself into a no-op.
    const r = mountRouter();
    await r.waitUntilSubscribed();
    r.wheel('up', TRANSCRIPT_ROW);
    r.wheel('down', TRANSCRIPT_ROW);
    await delay(40);
    expect(r.calls.scroll).toEqual([
      { kind: 'lineUp', repeat: 3 },
      { kind: 'lineDown', repeat: 3 },
    ]);
    r.unmount();
  });

  it('flushes immediately when the granularity changes', async () => {
    const r = mountRouter();
    await r.waitUntilSubscribed();
    r.wheel('up', TRANSCRIPT_ROW);
    r.wheel('up', TRANSCRIPT_ROW, { shift: true });
    await delay(40);
    expect(r.calls.scroll).toEqual([
      { kind: 'lineUp', repeat: 3 },
      { kind: 'pageUp', repeat: 1 },
    ]);
    r.unmount();
  });

  it('folds a burst that spans the transcript and the composer into ONE intent', async () => {
    // §4.3: the "flush when the BAND changes" rule is gone with the bands. Two
    // notches while the pointer drifts from the transcript onto the composer are
    // one gesture and must produce one intent — on 0.5.x they produced a
    // transcript scroll AND a history step, out of order.
    const r = mountRouter();
    await r.waitUntilSubscribed();
    r.wheel('up', TRANSCRIPT_ROW);
    r.wheel('up', COMPOSER_ROW);
    await delay(40);
    expect(r.calls.scroll).toEqual([{ kind: 'lineUp', repeat: 6 }]);
    r.unmount();
  });

  it('drops a coalesced content burst when an overlay opens inside the window', async () => {
    // P1-3. `App` swaps `ScrollViewport` out for the overlay, and its intent
    // effect fires once on REMOUNT — so a deferred intent that landed on an
    // unmounted viewport made the transcript jump a page by itself when the
    // overlay closed. THE DECISION HAS TO BE TAKEN AT FLUSH TIME, because the
    // event-time decision is the one that goes stale.
    const r = mountRouter(null);
    await r.waitUntilSubscribed();
    r.wheel('up', TRANSCRIPT_ROW);
    r.setOverlay('confirm'); // an agent-raised confirm, 2 ms later
    await delay(40);
    expect(r.calls.scroll).toEqual([]);
    r.unmount();
  });

  it('clearCoalescer drops an unflushed burst', async () => {
    // Guard #2 of the pair: `App` calls this from its existing overlay effect.
    const r = mountRouter(null);
    await r.waitUntilSubscribed();
    r.wheel('up', TRANSCRIPT_ROW);
    r.clearCoalescer();
    await delay(40);
    expect(r.calls.scroll).toEqual([]);
    r.unmount();
  });
});

// ---------------------------------------------------------------------------
// Part B — the same routing through a live `App`.
// ---------------------------------------------------------------------------

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

const HISTORY = ['older prompt', 'newest prompt'];

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
  // See the note on the same two keys in `app.test.tsx` (W3).
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
  keyboardEnhancement: false,
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
  config: CliConfig = CONFIG;
  /** Set by T-15 to stream a transcript long enough to overflow the viewport. */
  onPrompt: ((text: string) => Promise<void>) | null = null;
  subscribe(l: (e: AgentEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: AgentEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
  getConfig(): CliConfig {
    return this.config;
  }
  hasApiKey(): boolean {
    return true;
  }
  setSubmitCount(): void {}
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
  abort(): void {}
  steer(): void {}
  isRunning(): boolean { return false; }
  prompt(text: string): Promise<void> {
    return this.onPrompt ? this.onPrompt(text) : Promise.resolve();
  }
  getSkillService(): SkillService {
    return EMPTY_SKILL_SERVICE;
  }
  setOnSkillsChanged(): void {}
  /**
   * The diff side channel (agent-activity-presentation §3.3.7), for the reason
   * the note in `app.test.tsx` gives: `App` calls this on EVERY
   * `tool_execution_end`, and the `as unknown as AgentController` cast below
   * means its absence is a runtime `is not a function`, not a compile error.
   * This suite scrolls; it does not run tools. The method is here so that stays
   * a property of the cases rather than a condition for the file to load.
   */
  takeFilePatch(): undefined {
    return undefined;
  }
  /**
   * The live tool-output side channel (agent-activity-presentation-live §3.1.3),
   * for the reason above one round later: `App` subscribes UNCONDITIONALLY on
   * mount, so its absence is a runtime `is not a function` before the first
   * frame rather than a compile error (R-4).
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
    this.abort();
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
  getAgentMode() {
    return 'build' as const;
  }
  setAgentMode() {
    return { effective: 'build' as const, pending: null };
  }
  applyPendingMode() {
    return null;
  }
  // The App subscribes to the team stream on mount and disposes the runtime on
  // unmount (team-subagents §5.2 / R-15), so a controller stub needs both.
  subscribeTeam(): () => void {
    return () => {};
  }
  getTeamSnapshot() {
    return null;
  }
  dispose(): void {}
  // The App also subscribes to the CLI-local TODO stream on mount and reads the
  // snapshot at `agent_end` (todo-plan-execution §5.2), so this stub needs both.
  //
  // THIS IS THE `FakeController` THE CHANGE PLAN ALMOST MISSED (P1-5). There are
  // TWO hand-written ones that render `<App>` — the other is in `app.test.tsx` —
  // and both are handed over as `fc as unknown as AgentController`, so a missing
  // member is NOT a compile error. It is `controller.subscribeTodos is not a
  // function` at mount, in a wheel-routing suite that has nothing to do with
  // todos.
  subscribeTodos(): () => void {
    return () => {};
  }
  getTodoSnapshot() {
    return null;
  }
  // Read live at every `agent_end` (todo-plan-followthrough §3.4). Third member,
  // same cast, same silent-at-compile-time exposure as the two above.
  getTodoConfig() {
    return DEFAULT_TODO_CONFIG;
  }
}

function mountApp(
  source: MouseSource,
  extra: {
    initialOverlay?: Overlay;
    initialPrompt?: string;
    controller?: FakeController;
    /**
     * The full-screen terminal bridge (tui-selection-and-scroll-follow §4.4).
     * Absent by default, which is the `--no-diff-render` / no-filter shape and
     * keeps every wheel case in this file byte-identical to what it asserted
     * before drag-select existed.
     */
    terminal?: React.ComponentProps<typeof App>['terminal'];
  } = {},
) {
  const fc = extra.controller ?? new FakeController();
  return render(
    <App
      controller={fc as unknown as AgentController}
      version="0.0.0"
      mouseSource={source}
      initialOverlay={extra.initialOverlay}
      initialPrompt={extra.initialPrompt}
      terminal={extra.terminal}
    />,
  );
}

describe('App (wheel routing end to end)', () => {
  it('a wheel event over the transcript does not change the composer buffer', async () => {
    // I-3 — the reported bug, and the whole reason this feature exists.
    const mouse = fakeMouseSource();
    const { lastFrame, unmount } = mountApp(mouse.source);
    await delay(60);
    const before = stripAnsi(lastFrame() ?? '');
    expect(before).toContain('Ask a question or describe a task...');

    mouse.wheel('up', TRANSCRIPT_ROW);
    mouse.wheel('up', TRANSCRIPT_ROW);
    await delay(80);

    const after = stripAnsi(lastFrame() ?? '');
    expect(after).toContain('Ask a question or describe a task...'); // placeholder, i.e. empty buffer
    expect(after).not.toContain('newest prompt');
    expect(after).not.toContain('[<'); // I-1, belt and braces
    unmount();
  });

  it('a wheel notch over the composer row does not recall history, but the keyboard still does', async () => {
    // G1 and G3 in one mounted app, deliberately: the two halves of the
    // requirement are "the wheel stops doing this" and "the keys keep doing it",
    // and asserting them against the same tree is what rules out a fix that
    // simply unwired history recall altogether.
    const mouse = fakeMouseSource();
    const { lastFrame, stdin, unmount } = mountApp(mouse.source);
    await delay(60);
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('newest prompt');

    mouse.wheel('up', COMPOSER_ROW);
    mouse.wheel('up', COMPOSER_ROW);
    await delay(80);
    const afterWheel = stripAnsi(lastFrame() ?? '');
    expect(afterWheel).toContain('Ask a question or describe a task...'); // placeholder, i.e. empty buffer
    expect(afterWheel).not.toContain('newest prompt');
    expect(afterWheel).not.toContain('older prompt');
    expect(afterWheel).not.toContain('[<'); // no escape bytes typed into the draft

    stdin.write(KEY_UP);
    await delay(60);
    expect(stripAnsi(lastFrame() ?? '')).toContain('newest prompt');

    stdin.write(KEY_UP); // one entry further back
    await delay(60);
    expect(stripAnsi(lastFrame() ?? '')).toContain('older prompt');

    stdin.write(KEY_DOWN); // …and Down walks back toward the empty draft
    await delay(60);
    expect(stripAnsi(lastFrame() ?? '')).toContain('newest prompt');
    unmount();
  });

  it('a wheel burst really scrolls the transcript, end to end', async () => {
    // THE ONLY POSITIVE END-TO-END ASSERTION IN THIS BLOCK (RV-4). Everything
    // else here is of the form "the buffer did not change", which a build that
    // dropped wheel handling entirely would also satisfy. The headline
    // requirement is that something MOVES — and that it moves when the pointer
    // sits on the composer, the row that used to eat the draft.
    const fc = new FakeController();
    const long = Array.from({ length: 60 }, (_, i) => `LINE${i + 1}`).join('\n');
    fc.onPrompt = async () => {
      fc.emit({ type: 'agent_start' } as AgentEvent);
      fc.emit({ type: 'turn_start' } as AgentEvent);
      fc.emit({
        type: 'message_update',
        streamEvent: { type: 'text_delta', delta: long },
      } as unknown as AgentEvent);
      fc.emit({
        type: 'turn_end',
        message: { role: 'assistant', content: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      } as unknown as AgentEvent);
      fc.emit({ type: 'agent_end', messages: [] } as unknown as AgentEvent);
    };

    const mouse = fakeMouseSource();
    const { lastFrame, unmount } = mountApp(mouse.source, {
      controller: fc,
      initialPrompt: 'go',
    });
    await delay(160);

    const pinned = stripAnsi(lastFrame() ?? '');
    expect(pinned).toContain('LINE60'); // pinned to the newest output
    expect(pinned).not.toMatch(/\^\d/); // …so no off-bottom indicator yet

    for (let i = 0; i < 3; i += 1) {
      mouse.wheel('up', COMPOSER_ROW);
      // eslint-disable-next-line no-await-in-loop
      await delay(40);
    }

    const scrolled = stripAnsi(lastFrame() ?? '');
    expect(scrolled).not.toContain('LINE60'); // the tail scrolled away
    expect(scrolled).toMatch(/\^\d/); // status bar reports the distance
    unmount();
  });

  it('a wheel event over an open help overlay scrolls the overlay', async () => {
    const mouse = fakeMouseSource();
    const { lastFrame, unmount } = mountApp(mouse.source, { initialOverlay: 'help' });
    await delay(60);
    const first = stripAnsi(lastFrame() ?? '');
    expect(first).toContain('Keybindings');

    for (let i = 0; i < 4; i += 1) {
      mouse.wheel('down', TRANSCRIPT_ROW);
      // eslint-disable-next-line no-await-in-loop
      await delay(30);
    }
    const after = stripAnsi(lastFrame() ?? '');
    expect(after).not.toBe(first);
    expect(after).toContain('Help'); // still the overlay, not the transcript
    unmount();
  });

  it('advertises the wheel in the help overlay', async () => {
    const mouse = fakeMouseSource();
    const { lastFrame, unmount } = mountApp(mouse.source, { initialOverlay: 'help' });
    await delay(60);
    // The separate interruption instructions push Wheel below the first page.
    mouse.wheel('down', TRANSCRIPT_ROW);
    await delay(60);
    expect(stripAnsi(lastFrame() ?? '')).toContain('Wheel');
    unmount();
  });
});

/**
 * §6.1 / AC-13. R-3 is the only part of this feature that reaches users who
 * never scroll, and it REMOVES a gesture — drag to select — that is used more
 * often than the one being added. §14 makes shipping this notice alongside the
 * default-on switch a condition of the verdict.
 */
describe('first-run selection notice (§6.1)', () => {
  /**
   * The DEFAULT full-screen session: a filter is installed and `mouseSelect` is
   * on, which is what `cli.tsx` passes as `terminal.mouseSelect`.
   *
   * IT HAS TO BE SUPPLIED EXPLICITLY. `App` reads `terminal?.mouseSelect ??
   * false` and there are two notice texts, because a `mouseSelect: false`
   * session must not be told about a gesture that is not running. Mounting
   * without a bridge is therefore the DRAG-SELECT-OFF shape, and asserting the
   * drag-select sentence against it asserts the wrong branch — which is exactly
   * how the positive case below and its negative twin would otherwise disagree
   * about which session they are describing.
   */
  const SELECT_ON = { mouseSelect: true } as const;

  it('shows the notice once, and records that it did', async () => {
    store.mouseNoticeVersion = 0;
    store.noticeSeenWrites.length = 0;
    try {
      const mouse = fakeMouseSource();
      const { lastFrame, unmount } = mountApp(mouse.source, { terminal: SELECT_ON });
      await delay(80);
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('drag to select, then Ctrl+C to copy');
      expect(store.noticeSeenWrites).toContain(MOUSE_NOTICE_VERSION);
      unmount();
    } finally {
      store.mouseNoticeVersion = 99;
    }
  });

  it('tells a mouseSelect:false session about the wheel and NOT about dragging', async () => {
    // The other branch of `mouseNoticeText`, and the reason the case above has
    // to name the session it is about. Without this pair, mounting the positive
    // case against the wrong bridge reads as a passing assertion about a
    // sentence no default session ever renders.
    store.mouseNoticeVersion = 0;
    store.noticeSeenWrites.length = 0;
    try {
      const mouse = fakeMouseSource();
      const { lastFrame, unmount } = mountApp(mouse.source, {
        terminal: { mouseSelect: false },
      });
      await delay(80);
      const frame = stripAnsi(lastFrame() ?? '');
      expect(frame).toContain('Drag-select is off');
      expect(frame).not.toContain('drag to select, then Ctrl+C to copy');
      expect(store.noticeSeenWrites).toContain(MOUSE_NOTICE_VERSION);
      unmount();
    } finally {
      store.mouseNoticeVersion = 99;
    }
  });

  it('stays silent once the flag is persisted', async () => {
    // The SAME session shape as the positive case, so the silence below is the
    // one-shot gate holding rather than a bridge that was never wired.
    store.mouseNoticeVersion = 99;
    store.noticeSeenWrites.length = 0;
    const mouse = fakeMouseSource();
    const { lastFrame, unmount } = mountApp(mouse.source, { terminal: SELECT_ON });
    await delay(80);
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('drag to select, then Ctrl+C to copy');
    expect(store.noticeSeenWrites).toHaveLength(0);
    unmount();
  });

  it('never shows it when the platform cannot report at all (R-1 firing)', async () => {
    store.mouseNoticeVersion = 0;
    store.noticeSeenWrites.length = 0;
    try {
      // Every other conjunct of `cli.tsx::wantMouse` is satisfied: full-screen,
      // `mouse: true`, both ends a TTY. Only the platform check fails.
      const wantMouse =
        true && CONFIG.mouse && true && true && supportsWindowsVtInput('win32', '20.19.0');
      expect(wantMouse).toBe(false);
      const mouseFilter = wantMouse
        ? tryCreateStdinFilter(process.stdin, { mouse: true, paste: false })
        : null;
      expect(mouseFilter).toBeNull();

      const fc = new FakeController();
      const { lastFrame, unmount } = render(
        <App
          controller={fc as unknown as AgentController}
          version="0.0.0"
          mouseSource={mouseFilter?.source}
        />,
      );
      await delay(80);
      expect(stripAnsi(lastFrame() ?? '')).not.toContain('drag to select, then Ctrl+C to copy');
      expect(store.noticeSeenWrites).toHaveLength(0);
      unmount();
    } finally {
      store.mouseNoticeVersion = 99;
    }
  });

  it('still installs a filter on a Windows console that CAN report', async () => {
    // The other half of the pair, and the reason the case above is not vacuous:
    // the same harness with a supported Node must still reach a real filter.
    // Without this a gate that returned `false` for every input would look just
    // as green.
    const wantMouse =
      true && CONFIG.mouse && true && true && supportsWindowsVtInput('win32', '22.18.0');
    expect(wantMouse).toBe(true);
    const stream = new PassThrough();
    Object.assign(stream, { isTTY: true, setRawMode: () => stream });
    const filter = tryCreateStdinFilter(stream as unknown as NodeJS.ReadStream, {
      mouse: true,
      paste: false,
    });
    expect(filter).not.toBeNull();
    filter?.dispose();
  });

  it('never shows it when reporting is not actually in effect', async () => {
    store.mouseNoticeVersion = 0;
    store.noticeSeenWrites.length = 0;
    try {
      const fc = new FakeController();
      const { lastFrame, unmount } = render(
        <App
          controller={fc as unknown as AgentController}
          version="0.0.0"
        />,
      );
      await delay(80);
      expect(stripAnsi(lastFrame() ?? '')).not.toContain('drag to select, then Ctrl+C to copy');
      expect(store.noticeSeenWrites).toHaveLength(0);
      unmount();
    } finally {
      store.mouseNoticeVersion = 99;
    }
  });
});

/**
 * The R-1 notice (shift-tab-and-mouse-wheel-dead-on-some-terminals, F1').
 *
 * It replaces silence, so the thing worth pinning is not that it renders but
 * WHO it renders for: a user who has already run aragon, already been shown the
 * mouse notice that does not apply to them, and therefore already has
 * `mouseNoticeSeen: true` sitting on disk. That is the entire audience.
 */
describe('Windows VT-input notice (R-1)', () => {
  const AFFECTED = { nodeVersion: '20.19.0' };

  it('says what the key DOES now, not merely that it is unavailable (R6-2)', () => {
    // Asserted against the builder rather than a frame: the transcript wraps a
    // notice two columns wider than it displays it, so a phrase that lands on a
    // wrap boundary loses a character before it reaches `lastFrame()`.
    //
    // Every clause below is load-bearing. "Shift+Tab does not work" would be
    // true and useless: on these machines the modifier is lost inside libuv, so
    // the key arrives as an ordinary Tab and completes an open popup over the
    // user's draft. A user who is not told that keeps pressing it and keeps
    // losing text. The two workarounds have to be here for the same reason —
    // this notice is the only place the affected user will ever be told them.
    const text = vtInputDeadNotice('20.19.0');
    expect(text).toContain('20.19.0'); // the version they are running
    expect(text).toContain('PLAIN TAB'); // what Shift+Tab actually becomes
    expect(text).toContain('draft'); // and what that costs them
    expect(text).toContain('/plan'); // mode switching, available right now
    expect(text).toContain('Shift+Up'); // scrolling, ditto
    expect(text).toContain('22.17.0'); // and the real fix
    // `Shift+Up` / `Shift+Down` is the ONLY scroll workaround proven byte for
    // byte in the probe data (`\x1b[1;2A` on both Node versions). `PgUp` was
    // never injected, so promising it here would be guesswork.
    expect(text).not.toContain('PgUp');
  });

  it('names the fallback key ahead of /plan', () => {
    {
      const text = vtInputDeadNotice('20.19.0');
      expect(text).toContain(MODE_TOGGLE_KEYS.fallback);
      expect(text.indexOf(MODE_TOGGLE_KEYS.fallback)).toBeLessThan(text.indexOf('/plan'));
      // The permanent fix stays alongside the workaround, in both branches.
      expect(text).toContain('22.17.0');
    }
  });

  function mountWithWarning(
    warning?: { nodeVersion: string },
  ) {
    const fc = new FakeController();
    return render(
      <App
        controller={fc as unknown as AgentController}
        version="0.0.0"
        vtInputWarning={warning}
      />,
    );
  }

  it('shows it to a user who has already seen the mouse notice, and records it', async () => {
    // R6-1, the blocking constraint: reusing `mouseNoticeSeen` as the one-shot
    // key would make this fix inert for everyone who needs it, in silence.
    store.mouseNoticeVersion = 99;
    store.vtInputNoticeVersion = 0;
    store.vtNoticeSeenWrites.length = 0;
    try {
      const { lastFrame, unmount } = mountWithWarning(AFFECTED);
      await delay(80);
      const frame = stripAnsi(lastFrame() ?? '');
      // Presence and level only; the text itself is pinned above, off the
      // wrapping path.
      expect(frame).toContain('20.19.0');
      expect(frame).toContain(THEME.symbols.warn);
      expect(frame).toContain('wheel');
      // Row 2 of the migration matrix: showing it writes the CURRENT revision,
      // never a bare `true` — the gate compares against the constant.
      expect(store.vtNoticeSeenWrites).toContain(VT_INPUT_NOTICE_VERSION);
      unmount();
    } finally {
      store.vtInputNoticeVersion = VT_INPUT_NOTICE_VERSION;
    }
  });

  /**
   * Row 1 of the migration matrix, and the reason the boolean became a version.
   *
   * A 0.6.1 user who was already shown the old text has `vtInputNoticeSeen:
   * true` on disk and therefore reads as version 0 here — so the revision that
   * finally names the fallback key reaches the one population that has been
   * pressing a dead key since the first round.
   */
  it('replays once for a user who only ever saw the pre-fallback text', async () => {
    store.mouseNoticeVersion = 99;
    store.vtInputNoticeVersion = 0; // what an older `vtInputNoticeSeen: true` reads as
    store.vtNoticeSeenWrites.length = 0;
    try {
      const { lastFrame, unmount } = mountWithWarning(AFFECTED);
      await delay(80);
      expect(stripAnsi(lastFrame() ?? '')).toContain(MODE_TOGGLE_KEYS.fallback);
      expect(store.vtNoticeSeenWrites).toEqual([VT_INPUT_NOTICE_VERSION]);
      unmount();
    } finally {
      store.vtInputNoticeVersion = VT_INPUT_NOTICE_VERSION;
    }
  });

  /** Row 3: having seen THIS revision, the notice goes quiet again. */
  it('stays silent once the current revision is persisted', async () => {
    store.vtInputNoticeVersion = VT_INPUT_NOTICE_VERSION;
    store.vtNoticeSeenWrites.length = 0;
    const { lastFrame, unmount } = mountWithWarning(AFFECTED);
    await delay(80);
    expect(stripAnsi(lastFrame() ?? '')).not.toContain('20.19.0');
    expect(store.vtNoticeSeenWrites).toHaveLength(0);
    unmount();
  });

  it('never appears on a console that reports normally', async () => {
    // The prop is absent on every unaffected machine, which is what makes this
    // feature byte-identical there. Asserted with the flag UNSET, so a build
    // that ignored the prop and probed `process` itself would fail here on a
    // Windows developer box running an old Node.
    store.vtInputNoticeVersion = 0;
    store.vtNoticeSeenWrites.length = 0;
    try {
      const { lastFrame, unmount } = mountWithWarning(undefined);
      await delay(80);
      expect(stripAnsi(lastFrame() ?? '')).not.toContain('does not turn on');
      expect(store.vtNoticeSeenWrites).toHaveLength(0);
      unmount();
    } finally {
      store.vtInputNoticeVersion = VT_INPUT_NOTICE_VERSION;
    }
  });
});

// ---------------------------------------------------------------------------
// Part D — the reserved indicator column (mouse-wheel-region-routing §4.8).
//
// `ink-testing-library` hardcodes `columns` at 100, so the narrow case is
// driven through Ink's own `render` with a stdout we control.
// ---------------------------------------------------------------------------

describe('scroll indicator (§4.8)', () => {
  function renderViewport(columns: number) {
    const stdout = new EventEmitter() as EventEmitter & {
      columns: number;
      rows: number;
      write: (s: string) => void;
      lastFrame: () => string;
    };
    let last = '';
    stdout.columns = columns;
    stdout.rows = 24;
    stdout.write = (s: string) => {
      last = s;
    };
    stdout.lastFrame = () => last;

    const stdin = new EventEmitter() as EventEmitter & {
      isTTY: boolean;
      setEncoding: () => void;
      setRawMode: () => void;
      ref: () => void;
      unref: () => void;
      read: () => null;
      resume: () => void;
      pause: () => void;
    };
    Object.assign(stdin, {
      isTTY: false,
      setEncoding: () => {},
      setRawMode: () => {},
      ref: () => {},
      unref: () => {},
      read: () => null,
      resume: () => {},
      pause: () => {},
    });

    const instance = inkRender(
      <Box height={8} width={columns}>
        <ScrollViewport showScrollIndicator theme={THEME} caps={CAPS}>
          {Array.from({ length: 40 }, (_, i) => (
            <Text key={i}>line {i}</Text>
          ))}
        </ScrollViewport>
      </Box>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    return { frame: () => stripAnsi(stdout.lastFrame()), unmount: instance.unmount };
  }

  it('reserves the rail at or above MIN_INDICATOR_COLS', async () => {
    expect(MIN_INDICATOR_COLS).toBe(40);
    const wide = renderViewport(80);
    await delay(60);
    const text = wide.frame();
    // Both glyphs are drawn: track where there is no thumb, thumb where there
    // is. Content longer than the viewport guarantees the thumb exists.
    expect(text).toContain(GLYPHS.scrollTrack);
    expect(text).toContain(GLYPHS.scrollThumb);
    wide.unmount();
  });

  it('keeps the indicator at the smallest fullscreen width', async () => {
    // The track remains discoverable at every supported fullscreen width.
    const narrow = renderViewport(MIN_INDICATOR_COLS);
    await delay(60);
    const text = narrow.frame();
    expect(text).toContain('line'); // the viewport really rendered
    expect(text).toContain(GLYPHS.scrollTrack);
    expect(text).toContain(GLYPHS.scrollThumb);
    narrow.unmount();
  });
});

it('cancels a wheel burst captured before flush and resumes after release', async () => {
  const router = mountRouter();
  await router.waitUntilSubscribed();
  router.wheel('up', 2);
  router.setCaptured(true);
  await delay(40);
  expect(router.calls.scroll).toEqual([]);
  router.wheel('up', 2);
  await delay(40);
  expect(router.calls.scroll).toEqual([]);
  router.setCaptured(false);
  router.wheel('up', 2);
  await delay(40);
  expect(router.calls.scroll).toEqual([{ kind: 'lineUp', repeat: 3 }]);
  router.unmount();
});
