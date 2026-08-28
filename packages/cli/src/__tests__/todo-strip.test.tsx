/**
 * `TodoStrip` and the `AppShell` slot that carries it
 * (todo-plan-followthrough §3.7 / W2 / AC-28..AC-32, AC-41).
 *
 * ROW COUNTING, NOT `measureElement`. Nothing in this package asserts layout the
 * other way — the sole mention of `measureElement` in a test is a comment — and
 * `stripAnsi(lastFrame()).split('\n')` is the established idiom
 * (`overlay-frame.test.tsx`, `session-opener.test.tsx`). P2-6.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { TodoStrip } from '../ui/TodoStrip.js';
import { AppShell } from '../ui/layout/AppShell.js';
import { getTheme } from '../ui/theme.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import { TODO_LIMITS } from '../todo/limits.js';
import { todoAnchorIndex } from '../todo/panel-rows.js';
import type { TodoItem, TodoSnapshot } from '../todo/types.js';

const RICH = { colorLevel: 3 as const, unicode: true };
const ASCII = { colorLevel: 0 as const, unicode: false };
const THEME = getTheme('cool', RICH);
const ASCII_THEME = getTheme('cool', ASCII);

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function snapshotOf(statuses: TodoItem['status'][], label = 'content'): TodoSnapshot {
  const items = statuses.map((status, i) => ({
    content: `${label} ${i + 1}`,
    activeForm: `active ${i + 1}`,
    status,
  }));
  return {
    items,
    total: items.length,
    doneCount: items.filter((s) => s.status === 'completed').length,
    activeIndex: items.findIndex((s) => s.status === 'in_progress'),
    updatedAt: 1000,
  };
}

function frameOf(node: React.ReactElement): string {
  const { lastFrame, unmount } = render(node);
  const out = stripAnsi(lastFrame() ?? '');
  unmount();
  return out;
}

// `caps` is ANNOTATED rather than inferred from `RICH`: the default's
// `colorLevel: 3 as const` would narrow the parameter to the literal `3`, so
// passing `ASCII` (`colorLevel: 0`) is a type error even though it is exactly
// what the ASCII case is for. Same repair as `question-overlay.test.tsx` (W3) —
// and this one was introduced BY this round and caught by the new gate rather
// than by vitest, which transpiles without checking.
function strip(snapshot: TodoSnapshot, cols = 120, caps: TermCapabilities = RICH): string {
  return frameOf(
    <TodoStrip
      snapshot={snapshot}
      cols={cols}
      theme={caps === RICH ? THEME : ASCII_THEME}
      caps={caps}
    />,
  );
}

describe('TodoStrip — one row, always', () => {
  it('shows the counter, the anchor and the done suffix', () => {
    const out = strip(snapshotOf(['completed', 'completed', 'in_progress', 'pending']));
    expect(out).toContain('todo 2/4');
    expect(out).toContain('active 3');
    expect(out).toContain('+2 done');
  });

  it('AC-29: renders EXACTLY ONE line, at 40 columns with an 80-character item', () => {
    const snap = snapshotOf(['in_progress', 'pending']);
    snap.items[0]!.activeForm = 'x'.repeat(80);
    const lines = strip(snap, 40).split('\n');
    expect(lines).toHaveLength(1);
    // ...and the line itself stays inside the terminal.
    expect(lines[0]!.length).toBeLessThanOrEqual(40);
  });

  it('never wraps a long item, whatever the width', () => {
    const snap = snapshotOf(['in_progress']);
    snap.items[0]!.activeForm = 'y'.repeat(300);
    for (const cols of [20, 40, 80, 120]) {
      expect(strip(snap, cols).split('\n')).toHaveLength(1);
    }
  });

  it('AC-41: the `+N done` suffix appears AT `stripDoneCols` and not one below', () => {
    const snap = snapshotOf(['completed', 'in_progress', 'pending']);
    expect(strip(snap, TODO_LIMITS.stripDoneCols)).toContain('+1 done');
    expect(strip(snap, TODO_LIMITS.stripDoneCols - 1)).not.toContain('done');
  });

  it('omits the suffix when nothing is done, however wide the terminal', () => {
    expect(strip(snapshotOf(['in_progress', 'pending']), 200)).not.toContain('done');
  });

  it('degrades the counter at the SAME threshold the status bar uses', () => {
    const snap = snapshotOf(['completed', 'in_progress']);
    expect(strip(snap, TODO_LIMITS.statusCompactCols)).toContain('todo 1/2');
    expect(strip(snap, TODO_LIMITS.statusCompactCols - 1)).toContain('[1/2]');
  });

  it('AC-30: the anchor is `todoAnchorIndex`, for every shape the rail tests use', () => {
    // Shared function, so the rail and the strip cannot disagree about which
    // step is "current" (R-9).
    const shapes: TodoItem['status'][][] = [
      ['in_progress', 'pending', 'pending'],
      ['completed', 'in_progress', 'pending'],
      ['completed', 'completed', 'in_progress'],
      ['completed', 'completed', 'completed'],
      ['pending', 'pending'],
      ['completed', 'pending', 'pending'],
    ];
    for (const shape of shapes) {
      const snap = snapshotOf(shape, 'item');
      const anchor = todoAnchorIndex(snap.items);
      const item = snap.items[anchor]!;
      const expected = item.status === 'in_progress' ? item.activeForm : item.content;
      expect(strip(snap, 200)).toContain(expected);
    }
  });

  it('shows `content` for a non-active anchor and `activeForm` for an active one', () => {
    // `TodoPanel`'s rule, repeated here rather than inferred.
    const done = snapshotOf(['completed', 'completed']);
    expect(strip(done, 200)).toContain('content 2');
    const running = snapshotOf(['in_progress', 'pending']);
    expect(strip(running, 200)).toContain('active 1');
  });

  it('emits no non-ASCII byte when the terminal cannot render Unicode (C-4)', () => {
    const out = strip(snapshotOf(['completed', 'in_progress', 'pending']), 120, ASCII);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[^\x00-\x7f]/);
    // The separator came from `pickGlyphs`, so it degraded with everything else.
    expect(out).toContain('->');
  });

  it('survives an empty list without throwing', () => {
    const empty: TodoSnapshot = {
      items: [],
      total: 0,
      doneCount: 0,
      activeIndex: -1,
      updatedAt: 0,
    };
    expect(() => strip(empty)).not.toThrow();
  });
});

describe('AppShell — the strip slot is structural (C-8 / D-13 / I-6)', () => {
  const SLOTS = {
    rows: 24,
    cols: 80,
    header: <Text>HEADER</Text>,
    viewport: <Text>VIEWPORT</Text>,
    toast: <Text>TOAST</Text>,
    composer: <Text>COMPOSER</Text>,
    status: <Text>STATUS</Text>,
  };

  it('AC-28: `strip` is absent from the fullscreen branch ENTIRELY', () => {
    // Not "the caller passes null" — the fullscreen branch does not reference
    // the prop at all, so a future caller that forgets the gate cannot put the
    // rail and the strip on screen together.
    const out = frameOf(
      <AppShell {...SLOTS} mode="fullscreen" strip={<Text>STRIP-MARKER</Text>} />,
    );
    expect(out).not.toContain('STRIP-MARKER');
    expect(out).toContain('VIEWPORT');
  });

  it('renders the strip in the inline branch, between the viewport and the team', () => {
    const out = frameOf(
      <AppShell
        {...SLOTS}
        mode="inline"
        strip={<Text>STRIP-MARKER</Text>}
        team={<Text>TEAM-MARKER</Text>}
      />,
    );
    const lines = out.split('\n');
    const at = (needle: string): number => lines.findIndex((l) => l.includes(needle));
    expect(at('STRIP-MARKER')).toBeGreaterThan(at('VIEWPORT'));
    expect(at('STRIP-MARKER')).toBeLessThan(at('TEAM-MARKER'));
  });

  it('an absent strip leaves the inline tree byte-identical', () => {
    const without = frameOf(<AppShell {...SLOTS} mode="inline" />);
    const withNull = frameOf(<AppShell {...SLOTS} mode="inline" strip={null} />);
    expect(withNull).toBe(without);
  });

  it('AC-29 (comparative): the strip costs exactly one row', () => {
    const without = frameOf(<AppShell {...SLOTS} mode="inline" />).split('\n').length;
    const snap = snapshotOf(['completed', 'in_progress', 'pending']);
    snap.items[1]!.activeForm = 'z'.repeat(80);
    const withStrip = frameOf(
      <AppShell
        {...SLOTS}
        mode="inline"
        strip={<TodoStrip snapshot={snap} cols={40} theme={THEME} caps={RICH} />}
      />,
    ).split('\n').length;
    expect(withStrip - without).toBe(1);
  });
});
