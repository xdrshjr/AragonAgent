import React from 'react';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import type { AgentEvent } from '@aragon-agent/core';
import { AgentController } from '../agent/controller.js';
import type { Entry } from '../agent/reducer.js';
import { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME, type CliConfig } from '../config/schema.js';
import { App } from '../ui/App.js';
import { wrapStdoutForFrames } from '../ui/stdout-frame-writer.js';
import { createScrollbackDrain } from '../ui/scrollback/drain.js';
import { createScrollbackWriter } from '../ui/scrollback/scrollback-writer.js';
import { createScrollbackBridge } from '../ui/scrollback/use-scrollback-view.js';
import { SCROLLBACK_LIMITS } from '../ui/scrollback/limits.js';
import type { TodoEvent, TodoSnapshot } from '../todo/types.js';
import type { SubagentSpec, TeamEvent, TeamSnapshot } from '../team/types.js';
import { createMiniVt } from './helpers/mini-vt.js';

/**
 * The native-scroll App integration, END TO END
 * (tui-native-terminal-scroll, tui-full-height-live-region AC-F5 / F8 / F9 / F10 / F11 /
 * F12 / F16 / F17).
 *
 * THE ONE BEHAVIOUR THIS FILE EXISTS FOR: what is on screen and what is in the terminal's
 * scrollback are DISJOINT (I-F8). The region is the whole screen now (`H = rows - 1`), so
 * an entry is printed when it leaves the tail window - not when it settles. Every
 * assertion below is written against that rule, which is why the "printed immediately"
 * ones from the previous design are now their negation: a submitted message stays on
 * screen, and history only receives it when `K` newer entries push it out (or at exit).
 */

// Ink only paints live frames outside CI; `ink-runtime.ts` does the same for a TTY.
vi.hoisted(() => { process.env.CI = '0'; });
vi.mock('../config/prompt-history.js', () => ({ loadPromptHistory: () => [],
  appendPrompt: () => [] }));
vi.mock('../config/ui-state.js', () => ({ bumpSubmitCount: () => 1,
  setMouseNoticeVersion: () => {}, setVtInputNoticeVersion: () => {},
  getScrollModeNoticeVersion: () => 99, setScrollModeNoticeVersion: () => {} }));

const delay = (ms = 120) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function controllerFixture() {
  const config = { ...DEFAULT_CONFIG, cwd: process.cwd(), color: false, unicode: false,
    renderGovernor: false, reducedMotion: true, showThinking: false, startInPlanMode: false,
    submitCount: 20, skillsRuntime: DEFAULT_SKILLS_RUNTIME, apiKeys: { anthropic: 'fixture' },
    skills: { ...DEFAULT_CONFIG.skills, enabled: false },
    compaction: { ...DEFAULT_CONFIG.compaction, enabled: false },
    team: { ...DEFAULT_CONFIG.team, enabled: false },
    fast: { ...DEFAULT_CONFIG.fast, enabled: false },
  } as CliConfig;
  const controller = new AgentController(config, { notify: () => {} });
  let receive!: (event: AgentEvent) => void;
  vi.spyOn(controller, 'subscribe').mockImplementation((listener) => {
    receive = listener; return () => {};
  });
  // A prompt that never resolves: events drive the transcript, as in production.
  vi.spyOn(controller, 'prompt').mockImplementation(() => new Promise(() => {}));
  // `TodoEvent` is CLI-local and cannot travel through `subscribe`, so the plan stream
  // is captured the same way the agent stream is.
  let receiveTodo!: (event: TodoEvent) => void;
  vi.spyOn(controller, 'subscribeTodos').mockImplementation((listener) => {
    receiveTodo = listener;
    return () => {};
  });
  // The dispatch stream is captured the same way (`TeamEvent` is CLI-local too).
  let receiveTeam!: (event: TeamEvent) => void;
  let teamSnapshot: TeamSnapshot | null = null;
  vi.spyOn(controller, 'subscribeTeam').mockImplementation((listener) => {
    receiveTeam = listener;
    return () => {};
  });
  vi.spyOn(controller, 'getTeamSnapshot').mockImplementation(() => teamSnapshot);
  return {
    controller,
    emit: (event: AgentEvent) => receive(event),
    emitTodo: (event: TodoEvent) => receiveTodo(event),
    /** Publish a dispatch event, with the snapshot `App` re-reads after one. */
    emitTeam: (event: TeamEvent, snapshot: TeamSnapshot | null = null) => {
      teamSnapshot = snapshot;
      receiveTeam(event);
    },
  };
}

/** A short plan: the native band only needs items to have something to draw. */
const PLAN: TodoSnapshot = {
  items: [
    { content: 'collect data', activeForm: 'collecting data', status: 'completed' },
    { content: 'write tests', activeForm: 'writing tests', status: 'in_progress' },
  ],
  total: 2,
  doneCount: 1,
  activeIndex: 1,
  updatedAt: 1,
};

async function start(
  opts: {
    rows?: number; cols?: number; shell?: string[]; initialEntries?: Entry[];
    /** Model a measured anchor ("the cursor sits on the last row") before the first frame. */
    measure?: boolean;
  } = {},
) {
  const rows = opts.rows ?? 24;
  const cols = opts.cols ?? 80;
  const shell = opts.shell ?? ['$ ls', 'a.txt', '$ aragon'];
  const vt = createMiniVt(rows, cols);
  for (const line of shell) vt.write(line + '\r\n');
  const drain = createScrollbackDrain();
  const regionHeights: number[] = [];
  const written: string[] = [];
  const real = Object.assign(new EventEmitter(), {
    columns: cols, rows, isTTY: true,
    write(chunk: string): boolean { written.push(chunk); vt.write(chunk); return true; },
  }) as unknown as NodeJS.WriteStream;
  let frameHandle: ReturnType<typeof wrapStdoutForFrames> | undefined;
  const writer = createScrollbackWriter({
    rows: () => real.rows, cols: () => real.columns, sync: false, fullEveryFrame: false, drain,
    requestRepaint: () => { setImmediate(() => frameHandle?.repaint()); },
  });
  if (opts.measure) writer.setAnchorSpaceBelow(0, 'probe');
  frameHandle = wrapStdoutForFrames(real, writer);
  const bridge = createScrollbackBridge({ writer, drain });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin,
  });
  const { controller, emit, emitTodo, emitTeam } = controllerFixture();
  const instance = render(
    <App controller={controller} version="test" scrollMode="native" scrollback={bridge}
      {...(opts.initialEntries ? { initialEntries: opts.initialEntries } : {})} />,
    { stdin: stdin as unknown as NodeJS.ReadStream, stdout: frameHandle.stdout,
      stderr: real, exitOnCtrlC: false, patchConsole: false },
  );
  let finished = false;
  const finish = (): string[] => {
    if (finished) return vt.history();
    finished = true;
    instance.unmount();
    bridge.settleAllNow();
    let summary: readonly string[] = [];
    try { summary = bridge.getSummaryRows(); } catch { /* none */ }
    vt.write(writer.finalize(summary));
    return vt.history();
  };
  cleanups.push(() => { finish(); instance.cleanup(); frameHandle?.dispose(); controller.dispose(); });
  const sample = (): void => { regionHeights.push(writer.regionRows()); };
  await delay(200);
  sample();
  return {
    vt, writer, drain, emit, emitTodo, emitTeam, finish, regionHeights, sample, written, rows, cols,
    type: async (text: string) => { stdin.write(text); await delay(); sample(); },
    settle: async (ms?: number) => { await delay(ms); sample(); },
  };
}

const count = (rows: string[], needle: string): number =>
  rows.filter((row) => row.includes(needle)).length;

/** Message rows in `rows`, matched from the END so `m1` cannot match `m11`. */
const exactly = (rows: string[], text: string): number =>
  rows.filter((row) => row.trimEnd().endsWith(text)).length;

describe('native scroll App integration - the region is the screen', () => {
  it('first_frame_starts_at_row_zero (AC-F5): no gap, no held rows, a whole-screen canvas', async () => {
    const t = await start({ rows: 30, cols: 80, measure: true });
    const stats = t.writer.anchorStats();
    expect(stats.state).toBe('pinned');
    expect(stats.gapRows).toBe(0);
    expect(stats.top).toBe(0);
    expect(stats.canvasRows).toBe(29);
    expect(stats.heldRows).toBe(0);
    // The frame is the screen: nothing above the region, and the region is `rows - 1`.
    expect(t.writer.regionRows()).toBe(29);
    expect(t.vt.screen()[0].trimEnd().length).toBeGreaterThan(0);
    // A blank row must never reach the scrollback (I-F1 / I-B3).
    expect(t.vt.scrollback.filter((row) => row === '')).toHaveLength(0);
    expect(t.vt.forbidden).toEqual([]);
  });

  it('draws the TODO rail inside the region once a plan exists (regression: it vanished)', async () => {
    // The rail used to live in `AppShell`'s middle band, which native mode never
    // renders - so the default mode had no rail at all. This asserts the wiring from
    // `subscribeTodos` all the way into the region, which is the half that a shell-only
    // render test cannot see (the geometry half is `scrollback-panels.test.tsx`).
    const t = await start({ rows: 24, cols: 100 });
    t.emitTodo({ type: 'updated', snapshot: PLAN });
    await t.settle(200);
    const frames = t.written.join('');
    expect(frames).toContain('TODO');
    expect(frames).toContain('1/2');
    expect(frames).toContain('writing tests');
  });

  it('Ctrl+O during a dispatch never reprints the live card (double-roster A-2)', async () => {
    // The finder reads the UNFILTERED entry list (`state.entries` is never touched) and
    // the active `team` entry is the last one, so without the gate this keypress printed
    // `-- expanded: team ... --` from a card the roster was still rewriting - into the
    // scrollback, where printed is forever.
    const t = await start({ rows: 30, cols: 100 });
    const specs: SubagentSpec[] = [
      { label: 'planner', description: 'map the auth middleware', prompt: 'p', readOnly: true },
      { label: 'tester', description: 'map the route table', prompt: 'p', readOnly: true },
    ];
    t.emitTeam({ type: 'dispatch_start', dispatchId: 'd1', requested: 2, specs });
    await t.settle(150);
    // The ROSTER is the live surface, so the dispatch is on screen ...
    expect(t.written.join('')).toContain('planner');
    await t.type('\u000f');
    await t.settle(200);
    // ... and NO expanded copy of the card reached the scrollback.
    expect(count(t.vt.history(), '-- expanded: team')).toBe(0);
    expect(t.vt.history().filter((row) => row.includes('-- expanded'))).toHaveLength(0);
  });

  it('I-S1 / I-F13: the region is exactly rows - 1, and Ink never clears the screen', async () => {
    const t = await start({ rows: 14, cols: 60 });
    t.emit({ type: 'agent_start' });
    t.emit({ type: 'turn_start' });
    for (let i = 0; i < 40; i += 1) {
      t.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: `streamed ${i}\n` } });
      if (i % 8 === 0) await t.settle(60);
    }
    await t.settle(250);
    // `13` is the ONLY height that both fills the screen and stays off `clearTerminal`.
    expect(t.regionHeights.every((height) => height === 13)).toBe(true);
    const stats = t.writer.scrollbackStats();
    expect(stats.guardHits).toBe(0);
    expect(stats.guardHitsOutsideResize).toBe(0);
    expect(t.vt.forbidden).toEqual([]);
  });

  it('writes only whitelisted control sequences across a whole session (I-S5 / I-S6)', async () => {
    const t = await start({ rows: 16, cols: 60 });
    await t.type('whitelist check');
    await t.type('\r');
    t.emit({ type: 'agent_start' });
    t.emit({ type: 'turn_start' });
    for (let i = 0; i < 25; i += 1) {
      t.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: `row ${i}\n` } });
    }
    await t.settle(250);
    t.emit({ type: 'turn_end', message: { role: 'assistant', content: [] },
      usage: { inputTokens: 1, outputTokens: 1 } } as AgentEvent);
    t.emit({ type: 'agent_end' } as AgentEvent);
    await t.settle(250);
    await t.type('/help');
    await t.type('\r');
    await t.settle(250);
    t.finish();
    const bytes = t.written.join('');
    // CSI: SGR (m), CUU (A), CUD (B), ED0 (bare J), EL0 (bare K), and the three
    // private modes the writer and Ink use (2026 sync, 25 cursor, 2004 paste).
    const csi = /\x1b\[([0-?]*)([ -/]*)([@-~])/g;
    const unexpected: string[] = [];
    for (const match of bytes.matchAll(csi)) {
      const [whole, params, , final] = match;
      const ok =
        final === 'm' || final === 'A' || final === 'B' ||
        ((final === 'J' || final === 'K') && params === '') ||
        ((final === 'h' || final === 'l') && /^\?(2026|25|2004)$/.test(params!));
      if (!ok) unexpected.push(JSON.stringify(whole));
    }
    expect(unexpected).toEqual([]);
    expect(bytes).not.toContain('\x1bc');
    expect(t.vt.forbidden).toEqual([]);
    expect(t.writer.scrollbackStats().guardHits).toBe(0);
  });

  it('the native branch returns ONE node: a Frame would break the row margin (AC-F17)', () => {
    // `H = rows - 1` spends I-S1's single row of margin, so a Fragment (or any second
    // top-level node) next to `ScrollbackShell` would make the frame `rows` tall and Ink
    // would answer with `clearTerminal` - `ESC[3J`, the sequence that erases scrollback.
    // The edge is invisible to every other test, so it is asserted where it is written.
    const source = readFileSync(new URL('../ui/App.tsx', import.meta.url), 'utf8');
    const branch = /if \(nativeBudget\) \{([\s\S]*?)return ([\s\S]*?)<ScrollbackShell/.exec(source);
    expect(branch).not.toBeNull();
    // Nothing between `return (` and the shell element: no `<>`, no wrapper component.
    expect(branch![2]!.trim()).toBe('(');
  });

  it('I-A8: a session that never measures keeps the pre-fix geometry', async () => {
    // This harness's default wires no cursor probe, which is exactly the `anchor:
    // unknown` state - the same shape an `app`-mode session and a terminal without CPR
    // support get. What is asserted is that the canvas cannot leak in by itself.
    const t = await start();
    await t.type('hello');
    await t.settle(200);
    const anchor = t.writer.anchorStats();
    expect(anchor.state).toBe('unknown');
    expect(anchor.source).toBe('none');
    expect(anchor.canvasRows).toBe(0);
    expect(anchor.gapRows).toBe(0);
    expect(anchor.heldRows).toBe(0);
    expect(t.writer.regionRows()).toBe(t.rows - 1);
    expect(t.writer.scrollbackStats().anchorCanvasRows).toBe(0);
  });
});

describe('native scroll App integration - what is on screen is not printed (I-F8)', () => {
  it('visible_entries_are_not_printed: a submitted message stays on screen only', async () => {
    const t = await start({ rows: 24, cols: 80 });
    await t.type('hello native');
    await t.type('\r');
    await t.settle(200);
    // The message is there to read - on the screen.
    expect(t.vt.screen().join('\n')).toContain('hello native');
    // ... and it is NOT in the scrollback yet: the region is still showing it.
    expect(count(t.vt.scrollback, 'hello native')).toBe(0);
    expect(t.vt.forbidden).toEqual([]);
  });

  it('streams in the region, then leaves history alone while the answer is in the window', async () => {
    const t = await start({ rows: 24, cols: 80 });
    await t.type('question one');
    await t.type('\r');
    t.emit({ type: 'agent_start' });
    t.emit({ type: 'turn_start' });
    const lines = Array.from({ length: 12 }, (_, i) => `answer line ${i}`);
    for (const line of lines) {
      t.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: `${line}\n` } });
    }
    await t.settle(250);
    expect(t.vt.screen().join('\n')).toContain('answer line 11');
    expect(count(t.vt.scrollback, 'answer line')).toBe(0);

    t.emit({ type: 'turn_end', message: { role: 'assistant', content: [] },
      usage: { inputTokens: 10, outputTokens: 10 } } as AgentEvent);
    t.emit({ type: 'agent_end' } as AgentEvent);
    await t.settle(300);
    // Settling does NOT print any more (D7): the answer is still on screen, so printing
    // it would put the same paragraph in two places.
    expect(count(t.vt.scrollback, 'answer line')).toBe(0);
    expect(t.vt.forbidden).toEqual([]);
  });

  it('evicted_entry_is_printed_once: an entry that leaves the window prints exactly once', async () => {
    const total = 30;
    const initialEntries: Entry[] = Array.from({ length: total }, (_, i) => ({
      id: `e${i + 1}`, kind: 'user' as const, text: `restored message ${i}`,
    }));
    const t = await start({ rows: 20, cols: 80, initialEntries });
    await t.settle(600);
    const window = SCROLLBACK_LIMITS.liveTailMaxEntries;
    // The oldest entries have left the screen and are in the scrollback, once each.
    expect(exactly(t.vt.scrollback, 'restored message 0')).toBe(1);
    expect(exactly(t.vt.scrollback, `restored message ${total - window - 1}`)).toBe(1);
    // The window itself is on screen and NOT printed ...
    expect(exactly(t.vt.scrollback, `restored message ${total - 1}`)).toBe(0);
    expect(t.vt.screen().join('\n')).toContain(`restored message ${total - 1}`);
    // ... and the printed prefix is in conversation order, with no gap and no duplicate.
    //
    // THE PREFIX IS LONGER THAN `total - window` NOW, AND THAT IS THE FIX
    // (tui-final-reply-truncated-unscrollable). The window is counted in ENTRIES while the
    // box is counted in ROWS, so on a 20-row terminal the last 10 entries do not fit the
    // 14-row pool: the rows the box hides are printed by the top give-way, which pushes the
    // print boundary past `total - window`. What must stay true - and is what this asserts -
    // is that the boundary is a CONTIGUOUS PREFIX of the conversation, so the scrollback
    // reads in order, and that the newest entry is still only on screen.
    const printed = t.vt.scrollback
      .filter((row) => /restored message \d+$/.test(row.trimEnd()))
      .map((row) => Number(/(\d+)$/.exec(row.trimEnd())![1]));
    expect(printed).toEqual(Array.from({ length: printed.length }, (_, i) => i));
    expect(printed.length).toBeGreaterThanOrEqual(total - window);
    expect(printed.length).toBeLessThan(total);
    expect(t.vt.scrollback.filter((row) => row === '')).toHaveLength(0);
  });

  it('exit_prints_the_visible_window (AC-F10 / I-F12): nothing is lost at shutdown', async () => {
    const total = 18;
    const initialEntries: Entry[] = Array.from({ length: total }, (_, i) => ({
      id: `e${i + 1}`, kind: 'user' as const, text: `restored message ${i}`,
    }));
    const t = await start({ rows: 20, cols: 80, initialEntries });
    await t.settle(600);
    const history = t.finish();
    // Exactly the whole conversation, once each, in order - the window included.
    const printed = history
      .filter((row) => /restored message \d+$/.test(row.trimEnd()))
      .map((row) => Number(/(\d+)$/.exec(row.trimEnd())![1]));
    expect(printed).toEqual(Array.from({ length: total }, (_, i) => i));
    expect(history.filter((row) => row === '')).toHaveLength(0);
    expect(history.join(' | ')).not.toContain('not printed');
    expect(t.vt.forbidden).toEqual([]);
  });

  it('exit prints the pending last answer and a summary, leaving the cursor on a blank line', async () => {
    const t = await start();
    t.emit({ type: 'agent_start' });
    t.emit({ type: 'turn_start' });
    t.emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'unfinished reply' } });
    await t.settle(200);
    const history = t.finish();
    expect(count(history, 'unfinished reply')).toBe(1);
    expect(history.some((row) => row.startsWith('Session ended'))).toBe(true);
    expect(t.vt.cursor().col).toBe(0);
    expect(t.vt.screen()[t.vt.cursor().row]).toBe('');
    expect(t.vt.forbidden).toEqual([]);
  });
});

describe('native scroll App integration - the reset paths flush first', () => {
  it('clear_flushes_before_the_separator (AC-F16): visible content is not lost', async () => {
    const t = await start();
    await t.type('before clear');
    await t.type('\r');
    await t.settle(200);
    // Still on screen and unprinted when `/clear` starts.
    expect(count(t.vt.scrollback, 'before clear')).toBe(0);
    await t.type('/clear');
    await t.type('\r');
    await t.settle(300);
    const history = t.vt.history();
    // The entry reaches the scrollback EXACTLY once, and ABOVE the separator.
    expect(exactly(history, 'before clear')).toBe(1);
    expect(exactly(history, '---- conversation cleared ----')).toBe(1);
    const entryRow = history.findIndex((row) => row.trimEnd().endsWith('before clear'));
    const separatorRow = history.findIndex((row) => row.includes('---- conversation cleared ----'));
    expect(entryRow).toBeGreaterThan(-1);
    expect(separatorRow).toBeGreaterThan(entryRow);
  });

  it('/clear prints a separator once and later messages still print', async () => {
    const t = await start();
    await t.type('before clear');
    await t.type('\r');
    await t.type('/clear');
    await t.type('\r');
    await t.settle(200);
    expect(count(t.vt.history(), '---- conversation cleared ----')).toBe(1);
    await t.type('after clear');
    await t.type('\r');
    await t.settle(200);
    // The message is on screen, unprinted (the same rule `visible_entries_are_not_printed`
    // pins on a fresh session; here it must survive a reset).
    expect(t.vt.screen().join('\n')).toContain('after clear');
    const history = t.finish();
    expect(exactly(history, 'after clear')).toBe(1);
    expect(exactly(history, 'before clear')).toBe(1);
    expect(count(history, '---- conversation cleared ----')).toBe(1);
  });
});
