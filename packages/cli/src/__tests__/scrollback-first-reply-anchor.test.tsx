/**
 * The first Agent reply must render from the TOP of the live region
 * (tui-first-reply-bottom-aligned, plan A-prime; analysis §9.4 assertions A1-A4).
 *
 * WHAT THIS FILE PINS. In native-scroll mode the region is the whole screen, so the
 * band's preview box is 24 rows tall on a 30-row terminal while a first turn is four
 * rows. With a constant `flex-end` those four rows landed against the composer and every
 * unused row sat ABOVE the conversation: the user's report was "the reply shows up at the
 * bottom instead of the top". `tail-anchor.ts` flips the box to `flex-start` while the
 * content fits, and these frames are the proof that the flip reaches a real `App`:
 * real `ScrollbackShell`, real `LiveTail`, real `ScrollbackWriter`, real `mini-vt` -
 * only the controller's `prompt` is stubbed, exactly like `scrollback-app.test.tsx`.
 *
 * CASE 4 IS THE OTHER HALF OF THE FIX. An unconditionally top-anchored box clips the
 * NEWEST rows once the content is taller than the pool, and a streaming entry can never
 * be printed into the scrollback (`settled-boundary.ts`), so the newest text would be
 * lost. A 25-line answer therefore has to stay bottom-anchored, with its LAST line on the
 * band's last row.
 *
 * The minimal two-case diagnosis script this grew out of is kept verbatim under
 * `docs/diagnoses/tui-first-reply-bottom-aligned/repro/`.
 */

import React from 'react';
import { EventEmitter } from 'node:events';
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
import { createMiniVt } from './helpers/mini-vt.js';

vi.hoisted(() => { process.env.CI = '0'; });
vi.mock('../config/prompt-history.js', () => ({ loadPromptHistory: () => [],
  appendPrompt: () => [] }));
vi.mock('../config/ui-state.js', () => ({ bumpSubmitCount: () => 1,
  setMouseNoticeVersion: () => {}, setVtInputNoticeVersion: () => {},
  getScrollModeNoticeVersion: () => 99, setScrollModeNoticeVersion: () => {} }));

const delay = (ms = 200) => new Promise<void>((resolve) => setTimeout(resolve, ms));
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
  vi.spyOn(controller, 'prompt').mockImplementation(() => new Promise(() => {}));
  vi.spyOn(controller, 'subscribeTodos').mockImplementation(() => () => {});
  return { controller, emit: (event: AgentEvent) => receive(event) };
}

/** The very first turn: one user message, one assistant answer of three rows. */
const FIRST_TURN: Entry[] = [
  { id: 'u1', kind: 'user', text: 'explain the retry policy' },
  {
    id: 'a1', kind: 'assistant', thinkingOpen: false, streaming: false,
    text: 'FIRST-ANSWER-LINE-1\nFIRST-ANSWER-LINE-2\nFIRST-ANSWER-LINE-3',
  },
];

/** A first turn whose answer alone is taller than the whole preview pool. */
const LONG_TURN: Entry[] = [
  { id: 'u1', kind: 'user', text: 'explain the retry policy' },
  {
    id: 'a1', kind: 'assistant', thinkingOpen: false, streaming: false,
    text: Array.from({ length: 25 }, (_, index) =>
      `STREAM-LINE-${String(index + 1).padStart(2, '0')}`).join('\n'),
  },
];

async function start(initialEntries: Entry[], rows = 30, cols = 80) {
  const vt = createMiniVt(rows, cols);
  for (const line of ['$ ls', 'a.txt', '$ aragon']) vt.write(line + '\r\n');
  const drain = createScrollbackDrain();
  const real = Object.assign(new EventEmitter(), {
    columns: cols, rows, isTTY: true,
    write(chunk: string): boolean { vt.write(chunk); return true; },
  }) as unknown as NodeJS.WriteStream;
  let frameHandle: ReturnType<typeof wrapStdoutForFrames> | undefined;
  const writer = createScrollbackWriter({
    rows: () => real.rows, cols: () => real.columns, sync: false, fullEveryFrame: false, drain,
    requestRepaint: () => { setImmediate(() => frameHandle?.repaint()); },
  });
  writer.setAnchorSpaceBelow(0, 'probe');
  frameHandle = wrapStdoutForFrames(real, writer);
  const bridge = createScrollbackBridge({ writer, drain });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin,
  });
  const { controller, emit } = controllerFixture();
  const instance = render(
    <App controller={controller} version="anchor" scrollMode="native" scrollback={bridge}
      initialEntries={initialEntries} />,
    { stdin: stdin as unknown as NodeJS.ReadStream, stdout: frameHandle.stdout,
      stderr: real, exitOnCtrlC: false, patchConsole: false },
  );
  cleanups.push(() => { instance.unmount(); instance.cleanup(); frameHandle?.dispose();
    controller.dispose(); });
  await delay();
  return { vt, writer, emit };
}

/** 0-based index of the first screen row containing `needle` (-1 when absent). */
const rowOf = (screen: readonly string[], needle: string): number =>
  screen.findIndex((row) => row.includes(needle));

describe('native scroll: the first reply is written downward from the header', () => {
  it('starts the conversation on row 1 of a 30-row terminal (A1)', async () => {
    const t = await start(FIRST_TURN, 30, 80);
    const screen = t.vt.screen();
    const answer = rowOf(screen, 'FIRST-ANSWER-LINE-1');
    const question = rowOf(screen, 'explain the retry policy');
    // The header owns row 0 and the first turn starts directly beneath it.
    expect(question).toBe(1);
    expect(answer).toBeGreaterThan(1);
    expect(answer).toBeLessThan(6);
    // The unused rows of the pool are BELOW the content, where they read as "nothing has
    // been written here yet", instead of above it.
    expect(screen[5]).toBe('');
  });

  it('grows downward: a longer answer leaves line 1 where it was (A2)', async () => {
    const short = await start(FIRST_TURN, 30, 80);
    const shortRow = rowOf(short.vt.screen(), 'FIRST-ANSWER-LINE-1');
    const long: Entry[] = [
      { id: 'u1', kind: 'user', text: 'explain the retry policy' },
      {
        id: 'a1', kind: 'assistant', thinkingOpen: false, streaming: false,
        text: Array.from({ length: 12 }, (_, i) => `FIRST-ANSWER-LINE-${i + 1}`).join('\n'),
      },
    ];
    const tall = await start(long, 30, 80);
    const tallRow = rowOf(tall.vt.screen(), 'FIRST-ANSWER-LINE-1');
    expect(tallRow).toBe(shortRow);
  });

  it('stays near the top on a tall 45-row terminal (A3)', async () => {
    const t = await start(FIRST_TURN, 45, 100);
    const screen = t.vt.screen();
    expect(rowOf(screen, 'explain the retry policy')).toBe(1);
    expect(rowOf(screen, 'FIRST-ANSWER-LINE-1')).toBeLessThan(6);
  });

  it('still ends on the newest line when the answer overflows the pool (A4)', async () => {
    const t = await start(LONG_TURN, 30, 80);
    const screen = t.vt.screen();
    const text = screen.join('\n');
    // 26 rendered rows in a 24-row pool: the anchor must fall back to the bottom, so the
    // OLDEST rows are the ones clipped away ...
    expect(text).not.toContain('STREAM-LINE-01');
    expect(text).not.toContain('explain the retry policy');
    // ... and the newest line is on the band's last row (the composer starts on row 25).
    expect(rowOf(screen, 'STREAM-LINE-25')).toBe(24);
  });

  it('tops out on a 60-row terminal as well (R5: the tall end)', async () => {
    const t = await start(FIRST_TURN, 60, 80);
    const screen = t.vt.screen();
    // A 54-row pool does not change the anchor: the conversation starts under the header.
    expect(rowOf(screen, 'explain the retry policy')).toBe(1);
    expect(rowOf(screen, 'FIRST-ANSWER-LINE-1')).toBe(2);
  });

  it('writes the conversation downward at the 12-row minimum too (R5: the short end)', async () => {
    const t = await start(FIRST_TURN, 12, 80);
    const screen = t.vt.screen();
    // A 12-row terminal leaves a 6-row pool. The ESTIMATE (six rows plus the two-row
    // margin) calls that overflow, and it used to decide the anchor: the block sat against
    // the composer with the two unused rows ABOVE it - the "the answer shows up at the
    // bottom" complaint, at the smallest size that still renders. The MEASURED height of
    // the same frame is four rows, which fits, so the anchor is `top`: the unused rows are
    // below the content, nothing is clipped, and every row of the answer is on screen
    // (tui-final-reply-truncated-unscrollable - the give-way measures the window anyway,
    // and `tail-anchor.ts::resolveTailAnchor` lets that measurement decide).
    expect(rowOf(screen, 'explain the retry policy')).toBe(1);
    expect(rowOf(screen, 'FIRST-ANSWER-LINE-1')).toBe(2);
    expect(rowOf(screen, 'FIRST-ANSWER-LINE-3')).toBe(4);
  });

  it('pays the margin once at the hand-over, then scrolls one row per line', async () => {
    // The hand-over is NOT pixel-identical, and this is the case that says so out loud.
    // `estimateEntryRows` charges every entry a separation row while the renderer only
    // draws one above a `user` entry, so the flip fires while the block is still short of
    // the pool and the block lands that much lower - once. Pinning the magnitude keeps a
    // future change from silently turning that move into a jump.
    const streamingAnswer = (lines: number): Entry[] => [
      { id: 'u1', kind: 'user', text: 'explain the retry policy' },
      {
        id: 'a1', kind: 'assistant', thinkingOpen: false, streaming: true,
        text: Array.from({ length: lines }, (_, index) => `SCROLL-LINE-${index + 1}`).join('\n'),
      },
    ];
    const fits = await start(streamingAnswer(19), 30, 80);
    const overflows = await start(streamingAnswer(20), 30, 80);
    const fitsRow = rowOf(fits.vt.screen(), 'explain the retry policy');
    const overflowRow = rowOf(overflows.vt.screen(), 'explain the retry policy');
    // The last fitting frame is top-anchored ...
    expect(fitsRow).toBe(1);
    // ... the next one is bottom-anchored, and the whole block moved down by the margin
    // plus the over-counted separation row, not by a screenful.
    expect(overflowRow).toBeGreaterThan(1);
    expect(overflowRow - fitsRow).toBeLessThanOrEqual(SCROLLBACK_LIMITS.tailAnchorSlackRows + 1);
    // From there it is a scroll, not a jump: one more line moves the block up one row.
    const taller = await start(streamingAnswer(21), 30, 80);
    expect(rowOf(taller.vt.screen(), 'explain the retry policy')).toBe(overflowRow - 1);
  });
});
