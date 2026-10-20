/**
 * TOP GIVE-WAY, end to end: a finished answer that is taller than the live region must be
 * reachable with the wheel (tui-final-reply-truncated-unscrollable, plan A-prime;
 * assertions A1-A8 / A12).
 *
 * WHAT THIS FILE EXISTS FOR. The region is the whole screen (`H = rows - 1`), so the box
 * that shows the conversation is `previewRows` tall (24 rows on a 30-row terminal) while the
 * print boundary is counted in ENTRIES. A settled 60-line answer therefore sat inside the
 * window forever, clipped from the top by `justifyContent="flex-end"`, in a mode whose wheel
 * only scrolls the terminal's scrollback: the head existed nowhere the user could reach. The
 * fix prints the rows the box hides, so `scrollback + screen` covers the answer EXACTLY ONCE
 * and IN ORDER - which is what every assertion below counts.
 *
 * Real `App` + real `ScrollbackShell` + real `LiveTail` + real `ScrollbackWriter` +
 * `mini-vt`; only the controller's `prompt` is stubbed, exactly like `scrollback-app.test.tsx`
 * and `scrollback-first-reply-anchor.test.tsx`. No dump files: the diagnosis kept those under
 * `docs/diagnoses/`, a regression test should not write into the package root.
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
import { createMiniVt } from './helpers/mini-vt.js';

vi.hoisted(() => { process.env.CI = '0'; });
vi.mock('../config/prompt-history.js', () => ({ loadPromptHistory: () => [],
  appendPrompt: () => [] }));
vi.mock('../config/ui-state.js', () => ({ bumpSubmitCount: () => 1,
  setMouseNoticeVersion: () => {}, setVtInputNoticeVersion: () => {},
  getScrollModeNoticeVersion: () => 99, setScrollModeNoticeVersion: () => {} }));

const delay = (ms = 250) => new Promise<void>((resolve) => setTimeout(resolve, ms));
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

/** `ANSWER-01` .. `ANSWER-nn`: unique, fixed-width, so a substring can never lie. */
const mark = (index: number): string => `ANSWER-${String(index + 1).padStart(2, '0')}`;

/** A user turn followed by one long answer: the reported shape. */
function longTurn(lineCount: number, streaming = false): Entry[] {
  return [
    { id: 'u1', kind: 'user', text: 'summarise the release' },
    {
      id: 'a1', kind: 'assistant', thinkingOpen: false, streaming,
      text: Array.from({ length: lineCount }, (_, index) => `${mark(index)} body`).join('\n'),
    },
  ];
}

/** The long turn plus `count` short follow-up turns, so the answer leaves the entry window. */
function withFollowUps(lineCount: number, count: number): Entry[] {
  const entries = longTurn(lineCount);
  for (let index = 0; index < count; index += 1) {
    entries.push(
      { id: `u-${index}`, kind: 'user', text: `follow-up ${index}` },
      {
        id: `a-${index}`, kind: 'assistant', thinkingOpen: false, streaming: false,
        text: `short reply ${index}`,
      },
    );
  }
  return entries;
}

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
    <App controller={controller} version="give-way" scrollMode="native" scrollback={bridge}
      initialEntries={initialEntries} />,
    { stdin: stdin as unknown as NodeJS.ReadStream, stdout: frameHandle.stdout,
      stderr: real, exitOnCtrlC: false, patchConsole: false },
  );
  cleanups.push(() => { instance.unmount(); instance.cleanup(); frameHandle?.dispose();
    controller.dispose(); });
  await delay();
  return { vt, bridge, emit, write: (data: string): void => { stdin.write(data); } };
}

/** Everything the user can reach with the wheel: printed scrollback + the visible screen. */
function reachable(vt: ReturnType<typeof createMiniVt>): string[] {
  const screen = vt.screen();
  let end = screen.length;
  while (end > 0 && screen[end - 1]!.trim() === '') end -= 1;
  return [...vt.scrollback, ...screen.slice(0, end)];
}

/** How many reachable rows mention `needle`. */
const countOf = (rows: readonly string[], needle: string): number =>
  rows.filter((row) => row.includes(needle)).length;

/** The mark numbers present, in the order they appear. */
function marksInOrder(rows: readonly string[], total: number): number[] {
  const found: number[] = [];
  for (const row of rows) {
    for (let index = 0; index < total; index += 1) {
      if (row.includes(mark(index))) found.push(index + 1);
    }
  }
  return found;
}

/**
 * I-1: every line of the answer, exactly once, in conversation order.
 *
 * The rows are a PARAMETER because "reachable" and "printed" are different assertions at
 * shutdown: the exit flush prints the rows that are still on screen (the live region is
 * about to be erased), so at that instant the screen legitimately holds them too, and
 * counting both would double them.
 */
function expectCompleteOnce(rows: readonly string[], total: number): void {
  expect(marksInOrder(rows, total)).toEqual(
    Array.from({ length: total }, (_, index) => index + 1),
  );
  for (let index = 0; index < total; index += 1) {
    expect(countOf(rows, mark(index))).toBe(1);
  }
}

describe('native scroll: the rows the box hides are given back to the scrollback', () => {
  it('A1: a 60-line answer is complete and reachable on a 30-row terminal', async () => {
    const t = await start(longTurn(60), 30, 80);
    expectCompleteOnce(reachable(t.vt), 60);
    // The user's own message comes back with it - it was clipped by the same box.
    expect(countOf(reachable(t.vt), 'summarise the release')).toBe(1);
    // Nothing was thrown away to make room: the terminal history is the answer, not a copy.
    expect(t.vt.forbidden).toEqual([]);
  });

  it('A2: a taller terminal keeps the same promise (80 lines, 45 rows)', async () => {
    const t = await start(longTurn(80), 45, 100);
    expectCompleteOnce(reachable(t.vt), 80);
  });

  it('A3: the screen still ends on the newest line (the print is invisible)', async () => {
    const t = await start(longTurn(60), 30, 80);
    const screen = t.vt.screen();
    // The box is bottom-anchored, so the LAST line of the answer sits on the band's last row
    // (the composer follows). Printed rows leave through the top, exactly as they should.
    const row = screen.findIndex((line) => line.includes(mark(59)));
    expect(row).toBeGreaterThan(0);
    expect(screen.slice(row + 1).some((line) => line.includes('ANSWER-'))).toBe(false);
    // ... and the head is NOT on screen any more, because it is in the scrollback instead.
    expect(screen.some((line) => line.includes(mark(0)))).toBe(false);
  });

  it('A6: nothing is printed while the answer is still streaming', async () => {
    const t = await start(longTurn(60, true), 30, 80);
    // A streaming entry is not stable (`settled-boundary.ts`), so it may not print and the
    // plan stops at it: the give-way waits for the frame that finishes the answer.
    expect(countOf(t.vt.scrollback, 'ANSWER-')).toBe(0);
    expect(t.vt.forbidden).toEqual([]);
  });

  it('A7: the exit flush does not print a second copy', async () => {
    const t = await start(longTurn(60), 30, 80);
    expectCompleteOnce(reachable(t.vt), 60);
    // The exit flush prints what is still only on screen (the region is about to be erased),
    // and NOTHING that the give-way already handed over. Counting the scrollback ALONE is
    // the assertion: at this instant the screen legitimately still shows those rows.
    t.bridge.settleAllNow();
    await delay(300);
    expectCompleteOnce(t.vt.scrollback, 60);
  });

  it('A8: leaving the entry window prints only the remainder', async () => {
    // Three further turns push the answer out of the ten-entry window, so it is promoted as
    // a whole entry - and every row of it is already in the scrollback.
    const t = await start(withFollowUps(60, 3), 30, 80);
    expectCompleteOnce(reachable(t.vt), 60);
  });

  it('A5: the answer is complete the moment it settles, without another turn', async () => {
    // The user's own words: "after the reply finishes". The answer streams (nothing may
    // print while it is unstable), and `turn_end` is the frame that makes it printable - so
    // this asserts it is reachable on the very next frame, not five turns later.
    const total = 40;
    const t = await start([{ id: 'u1', kind: 'user', text: 'summarise the release' }], 30, 80);
    t.emit({ type: 'turn_start' } as AgentEvent);
    for (let index = 0; index < total; index += 1) {
      t.emit({
        type: 'message_update',
        streamEvent: { type: 'text_delta', delta: `${mark(index)} body\n` },
      } as AgentEvent);
    }
    await delay(250);
    expect(countOf(t.vt.scrollback, 'ANSWER-')).toBe(0);
    t.emit({
      type: 'turn_end',
      message: { role: 'assistant', content: [] },
      usage: { inputTokens: 10, outputTokens: 10 },
    } as AgentEvent);
    t.emit({ type: 'agent_end' } as AgentEvent);
    await delay(300);
    expectCompleteOnce(reachable(t.vt), total);
  });
});

describe('Ctrl+O: the card keeps the key, the answer is the fallback (B1)', () => {
  const CTRL_O = '\x0f';

  it('expands the tool card first when a card is asking for the key', async () => {
    // THE REGRESSION THIS PINS. A settled answer is almost always the newest entry, so
    // adding `assistant` to the card filter would take the press away from the tool card
    // the user just watched finish. Two tiers: the closed card list answers first, and the
    // answer is only the fallback.
    const entries: Entry[] = [
      { id: 'u1', kind: 'user', text: 'run the suite' },
      {
        id: 't1', kind: 'tool', toolCallId: 'c1', name: 'bash', label: 'run the suite',
        argsRaw: '{"command":"npm test"}', status: 'done',
      },
      {
        id: 'a1', kind: 'assistant', thinkingOpen: false, streaming: false,
        text: `${mark(0)} all green`,
      },
    ];
    const t = await start(entries, 30, 80);
    t.write(CTRL_O);
    await delay(300);
    expect(countOf(t.vt.scrollback, '-- expanded: bash --')).toBe(1);
    // The copy is the CARD, not a placeholder: the render runs after the input handler
    // unwinds (an offscreen render issued inside it is deferred and reads back empty).
    expect(t.vt.scrollback.filter((row) => row.includes('could not be rendered'))).toHaveLength(0);
    expect(countOf(t.vt.scrollback, '-- expanded: answer --')).toBe(0);
  });

  it('falls back to the last finished answer when no card is asking for the key', async () => {
    const t = await start(longTurn(60), 30, 80);
    // The give-way printed the head; the tail is still only on screen.
    expect(countOf(t.vt.scrollback, mark(59))).toBe(0);
    t.write(CTRL_O);
    await delay(300);
    expect(countOf(t.vt.scrollback, '-- expanded: answer --')).toBe(1);
    // The copy is the WHOLE answer, tail included - the escape hatch known limitation 2
    // promised for a reply the region cut in half.
    expect(countOf(t.vt.scrollback, mark(59))).toBe(1);
    // ... on top of the head the give-way already handed over.
    expect(countOf(t.vt.scrollback, mark(0))).toBe(2);
  });
});
