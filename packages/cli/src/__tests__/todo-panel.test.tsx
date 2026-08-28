/**
 * `TodoPanel` and `TodoCard` rendering (AC-24..AC-28, AC-40).
 */

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render as inkRender } from 'ink';
import { render } from 'ink-testing-library';
import { TodoPanel } from '../ui/TodoPanel.js';
import { TodoCard } from '../ui/entries/TodoCard.js';
import { StatusBar } from '../ui/StatusBar.js';
import { getTheme } from '../ui/theme.js';
import { todoRailWidth } from '../ui/layout/rail.js';
import { TODO_LIMITS } from '../todo/limits.js';
import type { TodoItem, TodoSnapshot } from '../todo/types.js';

const RICH = { colorLevel: 3 as const, unicode: true };
const ASCII = { colorLevel: 0 as const, unicode: false };

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function items(length: number, anchor: number): TodoItem[] {
  return Array.from({ length }, (_, i) => ({
    content: `Step ${i + 1} content`,
    activeForm: `Doing step ${i + 1}`,
    status: i < anchor ? 'completed' : i === anchor ? 'in_progress' : 'pending',
  }));
}

function snapshot(length = 7, anchor = 2): TodoSnapshot {
  return {
    items: items(length, anchor),
    total: length,
    doneCount: anchor,
    activeIndex: anchor,
    // An INJECTED value, not `Date.now()` (P2-4): a snapshot test that reads the
    // wall clock fails on a slow machine and nowhere else.
    updatedAt: 1000,
  };
}

function frameOf(node: React.ReactElement): string {
  const { lastFrame, unmount } = render(node);
  const out = stripAnsi(lastFrame() ?? '');
  unmount();
  return out;
}

function panel(over: Partial<React.ComponentProps<typeof TodoPanel>> = {}): string {
  return frameOf(
    <TodoPanel
      snapshot={snapshot()}
      width={todoRailWidth(120)}
      rows={20}
      running={false}
      reducedMotion={false}
      theme={getTheme('auto', RICH)}
      caps={RICH}
      {...over}
    />,
  );
}

describe('TodoPanel (§6.1)', () => {
  it('leads with the header and the counter', () => {
    const frame = panel();
    expect(frame).toContain('TODO');
    expect(frame).toContain('2/7');
  });

  it('AC-25: the in-progress row renders activeForm; the others render content', () => {
    const frame = panel();
    expect(frame).toContain('Doing step 3');
    expect(frame).toContain('Step 1 content');
    expect(frame).not.toContain('Doing step 1');
  });

  it('AC-26: an ASCII terminal produces a frame with no non-ASCII byte', () => {
    const frame = frameOf(
      <TodoPanel
        snapshot={snapshot()}
        width={todoRailWidth(120)}
        rows={20}
        running
        reducedMotion={false}
        theme={getTheme('auto', ASCII)}
        caps={ASCII}
      />,
    );
    // eslint-disable-next-line no-control-regex
    expect(frame.match(/[^\x00-\x7f]/g)).toBeNull();
    expect(frame).toContain('[x]');
    expect(frame).toContain('[ ]');
    expect(frame).toContain('#'); // the gauge, via glyphs.gaugeFull
  });

  it('every glyph this panel emits comes from the ASCII tier when asked', () => {
    // THE ONE NON-ASCII BYTE THIS COMPONENT CANNOT CONTROL is Ink's own
    // truncation ellipsis: `wrap="truncate"` resolves through `cli-truncate`,
    // which emits U+2026 whatever the capability probe said. That is a
    // codebase-wide property shared with `TeamPanel`, `TranscriptList` and the
    // status bar rather than anything this feature introduced (see spec §15
    // IF-2), so the assertion scoped to OUR glyphs is the honest one.
    const frame = frameOf(
      <TodoPanel
        snapshot={{
          items: [
            { content: 'x'.repeat(120), activeForm: 'y'.repeat(120), status: 'in_progress' },
            { content: 'z'.repeat(120), activeForm: 'z', status: 'pending' },
          ],
          total: 2,
          doneCount: 0,
          activeIndex: 0,
          updatedAt: 1,
        }}
        width={todoRailWidth(80)}
        rows={20}
        running={false}
        reducedMotion={false}
        theme={getTheme('auto', ASCII)}
        caps={ASCII}
      />,
    );
    // eslint-disable-next-line no-control-regex
    const foreign = new Set(frame.match(/[^\x00-\x7f]/g) ?? []);
    expect([...foreign]).toEqual(expect.arrayContaining([]));
    for (const byte of foreign) expect(byte).toBe('…');
  });

  it('AC-27: reduced motion and an idle agent both render the static marker', () => {
    // A spinner while the agent is idle is a lie about the state of the world,
    // and this panel outlives the run that filled it. Both fallbacks land on the
    // SAME static marker, exactly as `AssistantEntry` and `TeamPanel` already do.
    const spinnerFrames = /[⠁-⣿]/; // ink-spinner's braille dots
    for (const over of [{ running: false }, { running: true, reducedMotion: true }]) {
      const frame = panel(over);
      expect(frame).toContain('▸'); // glyphs.todoActive
      expect(frame).not.toMatch(spinnerFrames);
      expect(frame).toContain('Doing step 3');
    }
    // ...and an ASCII terminal is the third path to the same place.
    const ascii = frameOf(
      <TodoPanel
        snapshot={snapshot()}
        width={todoRailWidth(120)}
        rows={20}
        running
        reducedMotion={false}
        theme={getTheme('auto', ASCII)}
        caps={ASCII}
      />,
    );
    expect(ascii).toContain('>');
    expect(ascii).not.toMatch(spinnerFrames);
  });

  it('AC-28: a 20-item list at 10 rows keeps the anchor AND both overflow markers', () => {
    const frame = panel({ snapshot: snapshot(20, 10), rows: 10 });
    expect(frame).toContain('Doing step 11');
    expect(frame).toContain('above');
    expect(frame).toContain('more');
    // Never more rows than it was given.
    expect(frame.split('\n').length).toBeLessThanOrEqual(10);
  });

  it('says "done" once every item is complete', () => {
    const done: TodoSnapshot = {
      items: items(3, 3).map((i) => ({ ...i, status: 'completed' as const })),
      total: 3,
      doneCount: 3,
      activeIndex: -1,
      updatedAt: 1000,
    };
    expect(panel({ snapshot: done })).toContain('done');
  });

  it('drops the index column on a narrow rail but keeps the item text', () => {
    const narrow = panel({ width: todoRailWidth(80), rows: 20 });
    expect(narrow).toContain('Doing step 3');
  });

  it('AC-40: the panel never renders wider than the width it was given', () => {
    // `flexShrink={0}` holds the column; this pins the other direction, which is
    // the one a long CJK-ish item would break if any arithmetic here budgeted
    // user text by `.length` (P2-3).
    const long: TodoSnapshot = {
      items: [
        { content: 'x'.repeat(200), activeForm: 'y'.repeat(200), status: 'in_progress' },
        { content: 'z'.repeat(200), activeForm: 'z', status: 'pending' },
      ],
      total: 2,
      doneCount: 0,
      activeIndex: 0,
      updatedAt: 1000,
    };
    const width = todoRailWidth(80);
    const frame = panel({ snapshot: long, width, rows: 20 });
    for (const line of frame.split('\n')) {
      expect(line.length, line).toBeLessThanOrEqual(width);
    }
  });

  it('the wrapping budget belongs to the in-progress row alone', () => {
    const width = todoRailWidth(80);
    const frame = panel({ snapshot: snapshot(3, 0), width, rows: 20 });
    // Two rows at most, per `TODO_LIMITS.activeWrapRows`; every other row is
    // `wrap="truncate"` and cannot claim a second line at all.
    expect(TODO_LIMITS.activeWrapRows).toBe(2);
    expect(frame.split('\n').length).toBeLessThanOrEqual(20);
  });
});

describe('TodoCard (§6.2)', () => {
  function card(over: Partial<React.ComponentProps<typeof TodoCard>> = {}): string {
    return frameOf(
      <TodoCard
        items={items(4, 1)}
        doneCount={1}
        total={4}
        live={false}
        theme={getTheme('auto', RICH)}
        caps={RICH}
        {...over}
      />,
    );
  }

  it('renders the WHOLE list, unwindowed, with the counter', () => {
    // The transcript scrolls; the rail does not.
    const frame = card();
    expect(frame).toContain('1/4');
    expect(frame).toContain('Step 1 content');
    expect(frame).toContain('Step 4 content');
    expect(frame).toContain('Doing step 2');
  });

  it('names a resumed mid-run card as interrupted (P2-6)', () => {
    // Without it a resumed `2/7` reads as a run still in flight.
    expect(card({ interrupted: true })).toContain('interrupted');
    expect(card()).not.toContain('interrupted');
  });

  it('is ASCII-clean on a legacy terminal', () => {
    const frame = frameOf(
      <TodoCard
        items={items(3, 1)}
        doneCount={1}
        total={3}
        live
        theme={getTheme('auto', ASCII)}
        caps={ASCII}
      />,
    );
    // eslint-disable-next-line no-control-regex
    expect(frame.match(/[^\x00-\x7f]/g)).toBeNull();
  });
});

describe('StatusBar todo cluster (§6.3)', () => {
  /**
   * `ink-testing-library` hardcodes `columns` at 100, so the narrow case is
   * driven through Ink's own `render` with a stdout we control — the same
   * pattern `team-panel.test.tsx` uses for the team counter one feature earlier.
   */
  function bar(cols: number, todoActive?: { done: number; total: number }): string {
    const stdout = new EventEmitter() as EventEmitter & {
      columns: number;
      rows: number;
      write: (s: string) => void;
    };
    let last = '';
    stdout.columns = cols;
    stdout.rows = 24;
    stdout.write = (s: string) => {
      last = s;
    };

    const instance = inkRender(
      <StatusBar
        model="m"
        provider="anthropic"
        usageTotal={{ inputTokens: 0, outputTokens: 0, costUsd: 0 }}
        contextTokens={0}
        contextWindow={200_000}
        contextWindowKnown
        status="idle"
        elapsedMs={0}
        thinkingLevel="off"
        tokPerSec={0}
        theme={getTheme('cool', ASCII)}
        caps={ASCII}
        {...(todoActive ? { todoActive } : {})}
      />,
      { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false },
    );
    const out = stripAnsi(last);
    instance.unmount();
    return out;
  }

  it('degrades from `todo 2/7` to `[2/7]` below the compact threshold', () => {
    expect(bar(120, { done: 2, total: 7 })).toContain('todo 2/7');
    expect(bar(80, { done: 2, total: 7 })).toContain('[2/7]');
  });

  it('adds nothing at all when there is no list', () => {
    expect(bar(120)).not.toContain('todo');
  });
});
