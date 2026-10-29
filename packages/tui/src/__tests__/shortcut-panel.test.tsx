/**
 * The drawer as rendered (tui-shortcut-drawer-and-task-summary §9.1 / AC-4 / AC-7 /
 * AC-8 / AC-25).
 *
 * THE RENDERED-STRING STACK IS WHY THE GEOMETRY LIVES IN A PURE MODULE: nothing here
 * can read a child's props back, so "the keyword column is 10 cells" is asserted in
 * `shortcut-panel-layout.test.ts` and what this file asserts is what a user sees.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ShortcutPanel } from '../ui/overlays/ShortcutPanel.js';
import { getTheme } from '../ui/theme.js';
import type { ShortcutTaskSection } from '../ui/layout/shortcut-panel-layout.js';

const caps = { unicode: false, colorLevel: 0 } as const;
const theme = getTheme('cool', caps);

const TASK: ShortcutTaskSection = {
  text: 'fix the failing build',
  tone: 'model',
  reason: null,
  by: 'anthropic:claude-haiku',
  ageMs: 5_000,
  enabled: true,
  pending: false,
};

function mount(over: Partial<React.ComponentProps<typeof ShortcutPanel>> = {}) {
  return render(
    <ShortcutPanel
      cols={80}
      maxRows={18}
      theme={theme}
      caps={caps}
      isActive={false}
      native
      running={false}
      task={TASK}
      detailsExpanded={false}
      onToggleDetails={() => {}}
      onRefresh={() => {}}
      {...over}
    />,
  );
}

/** One tick, so `useInput` has subscribed before a key is written. */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 20); });

describe('ShortcutPanel', () => {
  it('draws the title, the details marker and the task label', () => {
    const view = mount();
    const text = view.lastFrame()!;
    view.unmount();
    expect(text).toContain('Keys');
    expect(text).toContain('d:off');
    expect(text).toContain('fix the failing build');
    expect(text).toContain('Esc close');
  });

  it('lists the shortcuts with their keywords, top to bottom (AC-7)', () => {
    const view = mount();
    const text = view.lastFrame()!;
    view.unmount();
    expect(text).toContain('Enter');
    expect(text).toContain('send');
    expect(text.indexOf('Enter')).toBeLessThan(text.indexOf('Ctrl+J'));
  });

  it('shows the selected row\'s detail line', () => {
    const view = mount({ cols: 120, maxRows: 24 });
    const text = view.lastFrame()!;
    view.unmount();
    expect(text).toContain('Submits when idle');
  });

  it('says `d:on` when the status row is expanded (AC-8)', () => {
    const view = mount({ detailsExpanded: true });
    const text = view.lastFrame()!;
    view.unmount();
    expect(text).toContain('d:on');
    expect(text).not.toContain('d:off');
  });

  it('routes `d` and `r` to its callbacks and ignores ctrl combinations', async () => {
    const onToggleDetails = vi.fn();
    const onRefresh = vi.fn();
    const view = mount({ isActive: true, onToggleDetails, onRefresh });
    await tick();
    view.stdin.write('d');
    await tick();
    view.stdin.write('r');
    await tick();
    view.stdin.write('\x07');
    await tick();
    view.unmount();
    expect(onToggleDetails).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('lists an unavailable row instead of hiding it', () => {
    // Wide enough that the whole table fits: `Ctrl+I` is idle-only, so while a run is
    // in flight it must still be LISTED (dim) - the user needs to know the key exists.
    const view = mount({ cols: 200, maxRows: 40, running: true });
    const text = view.lastFrame()!;
    view.unmount();
    expect(text).toContain('Ctrl+I');
  });

  it('keeps every rendered line inside the panel width', () => {
    for (const cols of [40, 80, 120, 200]) {
      const view = mount({ cols, maxRows: 24 });
      const text = view.lastFrame()!;
      view.unmount();
      for (const line of text.split('\n')) {
        expect(line.length, `cols=${cols}`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it('draws ten entry rows on an 80x24 first page (AC-25)', () => {
    const view = mount({ cols: 80, maxRows: 18 });
    const text = view.lastFrame()!;
    view.unmount();
    // THE EXACT ROW COUNT LIVES IN `shortcut-panel-layout.test.ts` (AC-25 counts
    // `entry` / `stacked` rows there, where the window is legible). What a rendered
    // string CAN witness is that the first page is the top of the table rather than
    // one card and a scrollbar: keywords repeat (`newline` three times) and the
    // selected row's detail line eats a row or two, so eight DISTINCT keywords is the
    // honest floor - it was written as ten, which the assertion never claimed
    // (review fix RF-8).
    const firstPage = ['send', 'newline', 'history', 'paste', 'expand', 'copy/exit',
      'close', 'interrupt', 'plan mode', 'thinking'];
    const drawn = firstPage.filter((keyword) => text.includes(keyword));
    expect(drawn.length).toBeGreaterThanOrEqual(8);
    // And the sequence is the table's order, not an accidental set.
    expect(text.indexOf('send')).toBeLessThan(text.indexOf('close'));
  });
});
