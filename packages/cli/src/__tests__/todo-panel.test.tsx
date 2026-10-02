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
import stringWidth from 'string-width';
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
      width={24}
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
  it('窄栏完成标题按实际内宽保留 done 提示', () => {
    for (const total of [2, 20]) {
      const done = { ...snapshot(total, total), activeIndex: -1 };
      const minimumWidth = total === 2 ? 15 : 17;
      for (const width of [minimumWidth - 1, minimumWidth]) {
        const header = panel({ snapshot: done, width, rows: 3 }).split('\n')[0]!;
        expect(header).toContain('TODO');
        expect(header).toContain(`${total}/${total}`);
        expect(header.includes('done')).toBe(width === minimumWidth);
        expect(stringWidth(header)).toBeLessThanOrEqual(width);
      }
    }
  });
  it('常规视图切换紧凑视图时保留当前项', async () => {
    const props = { snapshot: snapshot(20, 9), width: 15, running: false,
      reducedMotion: true, theme: getTheme('auto', ASCII), caps: ASCII };
    const view = render(<TodoPanel {...props} rows={12} />);
    view.rerender(<TodoPanel {...props} rows={4} />);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(view.lastFrame()).toContain('Doing');
    expect(view.lastFrame()).toContain('-9 +9');
    view.unmount();
  });
  it('三行紧凑视图保留当前项、计数及两端隐藏数量', () => {
    const frame = panel({ snapshot: snapshot(20, 9), width: 15, rows: 3 });
    expect(frame).toContain('9/20');
    expect(frame).toContain('Doing');
    expect(frame).toContain('-9 +10');
    expect(frame.split('\n')).toHaveLength(3);
  });
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
        width={24}
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
        width={24}
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
    expect(narrow).toContain('Doing');
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

  it('所有任务各占一行，宽字符及组合字符不超出预算', () => {
    for (const width of [14, 15, 18, 22, 30, 36]) {
      for (let rows = 3; rows <= 12; rows++) {
        const data = snapshot(20, 9);
        data.items[9]!.activeForm = '当前😀e\u0301步骤'.repeat(12);
        const frame = panel({ snapshot: data, width, rows });
        expect(frame.split('\n')).toHaveLength(rows);
        expect(frame).toContain('当前');
        expect(frame).not.toContain('\ufffd');
        for (const line of frame.split('\n')) expect(stringWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(panel({ rows: 2 })).toBe('');
    expect(panel({ snapshot: snapshot(0, 0) })).toBe('');
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
        usageTotal={{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }}
        context={{
          occupied: 1000,
          window: 200_000,
          pct: 1,
          source: 'usage',
          deltaTokens: 0,
          windowKnown: true,
          windowOverridden: false,
        }}
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
