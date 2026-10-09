import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import stripAnsi from 'strip-ansi';
import { OverlayFrame } from '../ui/layout/OverlayFrame.js';
import { overlayListLimit } from '../ui/layout/overlay-window.js';
import { buildFrameBudget } from '../ui/layout/budget.js';
const viewportRows = (rows: number) => buildFrameBudget({ rows, cols: 80, draftRows: 1, popupRows: 0, statusExpanded: false }).viewportRows;
import { getTheme } from '../ui/theme.js';
import type { TermCapabilities } from '../ui/capabilities.js';
import type { ModelRegistry } from '@aragon-agent/core';
import { ModelPicker } from '../ui/overlays/ModelPicker.js';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';

const RICH: TermCapabilities = { colorLevel: 3, unicode: true };
const THEME = getTheme('warm', RICH);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rowsOf(n: number): React.ReactElement[] {
  return Array.from({ length: n }, (_, i) => (
    <Text key={i} wrap="truncate">{`ROW${i + 1}`}</Text>
  ));
}

/**
 * The overlay is dropped into a viewport-sized box with `overflow: hidden`, so a
 * frame that renders even one row too tall loses that row without a word — the
 * exact failure mode this whole round exists to remove, reappearing in the
 * component built to fix it. The margin row is the easy one to forget: it is a
 * prop on the outer `Box`, not part of the visible chrome anyone counts.
 */
describe('OverlayFrame height (fits its row budget)', () => {
  for (const cols of [100, 40]) {
    it(`never renders taller than maxRows at cols=${cols}`, () => {
      for (const rows of [24, 28, 30, 40]) {
        const budget = viewportRows(rows);
        const { lastFrame, unmount } = render(
          <OverlayFrame
            title="Help"
            hint="Esc close"
            maxRows={budget}
            cols={cols}
            rows={rowsOf(40)}
            scrollOffset={0}
            theme={THEME}
            caps={RICH}
          />,
        );
        const rendered = stripAnsi(lastFrame() ?? '').split('\n').length;
        expect(rendered, `rows=${rows} cols=${cols}`).toBeLessThanOrEqual(budget);
        unmount();
      }
    });
  }

  it('keeps its bottom border on screen when the content overflows', () => {
    const budget = viewportRows(24);
    const { lastFrame, unmount } = render(
      <OverlayFrame
        title="Help"
        hint="Esc close"
        maxRows={budget}
        cols={100}
        rows={rowsOf(40)}
        scrollOffset={0}
        theme={THEME}
        caps={RICH}
      />,
    );
    const lines = stripAnsi(lastFrame() ?? '').split('\n');
    expect(lines[lines.length - 1]).toMatch(/^[╰└]/);
    expect(lines.join('\n')).toMatch(/1-\d+\/40/); // and it still says so
    unmount();
  });

  it('leaves the self-managed list the same chrome allowance (A-11)', () => {
    // Mode B cannot be sliced, so `limit` is the only lever; it has to subtract
    // the same 5 rows the controlled mode does or the picker overflows instead.
    for (let maxRows = 8; maxRows <= 24; maxRows += 1) {
      expect(overlayListLimit(maxRows) + 5, `maxRows=${maxRows}`).toBeLessThanOrEqual(maxRows);
    }
  });
});

describe('OverlayFrame scroll clamping', () => {
  it('reports a past-the-end offset back to the owner', async () => {
    // Without this the owner keeps its own counter: eight PgDn presses park it
    // ~60 rows past the end, and the next several PgUp presses then move that
    // invisible number while the screen does not budge.
    const onScrollClamp = vi.fn();
    const { unmount } = render(
      <OverlayFrame
        title="Help"
        hint="Esc close"
        maxRows={viewportRows(24)}
        cols={100}
        rows={rowsOf(20)}
        scrollOffset={999}
        onScrollClamp={onScrollClamp}
        theme={THEME}
        caps={RICH}
      />,
    );
    await delay(20);
    expect(onScrollClamp).toHaveBeenCalledTimes(1);
    expect(onScrollClamp.mock.calls[0]![0]).toBeLessThan(20);
    unmount();
  });

  it('stays quiet while the offset is already in range', async () => {
    const onScrollClamp = vi.fn();
    const { unmount } = render(
      <OverlayFrame
        title="Help"
        hint="Esc close"
        maxRows={viewportRows(24)}
        cols={100}
        rows={rowsOf(20)}
        scrollOffset={3}
        onScrollClamp={onScrollClamp}
        theme={THEME}
        caps={RICH}
      />,
    );
    await delay(20);
    expect(onScrollClamp).not.toHaveBeenCalled();
    unmount();
  });

  it('clamps an unbounded overlay offset back to zero', async () => {
    // `maxRows = Infinity` renders everything, so any non-zero offset is stale.
    const onScrollClamp = vi.fn();
    const { lastFrame, unmount } = render(
      <OverlayFrame
        title="Help"
        hint="Esc close"
        maxRows={Number.POSITIVE_INFINITY}
        cols={100}
        rows={rowsOf(20)}
        scrollOffset={7}
        onScrollClamp={onScrollClamp}
        theme={THEME}
        caps={RICH}
      />,
    );
    await delay(20);
    expect(onScrollClamp).toHaveBeenCalledWith(0);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('ROW20'); // nothing was cut
    expect(frame).not.toMatch(/\d+-\d+\/\d+/); // and no position indicator
    unmount();
  });
});


describe('three-row overlay', () => {
  it.each([40, 80])('keeps title, current body and action visible at %i columns', cols => {
    const { lastFrame, unmount } = render(<OverlayFrame title="Confirm" hint="y approve / n reject"
      maxRows={3} cols={cols} rows={rowsOf(12)} scrollOffset={7} theme={THEME} caps={RICH} />);
    const lines = stripAnsi(lastFrame() ?? '').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Confirm');
    expect(lines[1]).toContain('ROW8');
    expect(lines[2]).toContain('y approve');
    unmount();
  });
});

describe('model picker keeps logical selection across viewport changes', () => {
  const registry = { getModels: (provider: string) => provider === 'anthropic'
    ? Array.from({ length: 10 }, (_, index) => ({ id: `model-${index}`,
      name: `CHOICE${index} ${'long model label '.repeat(8)}` })) : [] } as unknown as ModelRegistry;

  it('shrinks the real terminal to three rows and confirms the same selected model', async () => {
    const terminal = createTerminalHarness(100, 24);
    const onSelect = vi.fn();
    const node = (cols: number, maxRows: number, isActive = true) => <ModelPicker
      registry={registry} currentProvider="anthropic" currentModel="model-0"
      cols={cols} maxRows={maxRows} isActive={isActive}
      onSelect={onSelect} theme={THEME} caps={RICH} />;
    try {
      terminal.mount(node(100, 12));
      await settleTerminal();
      for (let i = 0; i < 4; i++) {
        terminal.input('\x1b[B');
        await settleTerminal();
      }
      terminal.resize(40, 12);
      terminal.rerender(node(40, 3));
      await settleTerminal();
      const lines = terminal.lastFrame().trimEnd().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain('CHOICE4');
      expect(lines[2]).toContain('Enter choose');
      terminal.input('\r');
      await settleTerminal();
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('anthropic', 'model-4');
    } finally { terminal.dispose(); }
  });

  it('ignores hidden navigation and Enter, then restores selection and input', async () => {
    const terminal = createTerminalHarness(80, 24);
    const onSelect = vi.fn();
    const node = (active: boolean, cols = 80, maxRows = 12) => <ModelPicker
      registry={registry} currentProvider="anthropic" currentModel="model-5"
      cols={cols} maxRows={maxRows} isActive={active}
      onSelect={onSelect} theme={THEME} caps={RICH} />;
    try {
      terminal.mount(node(true));
      await settleTerminal();
      terminal.resize(39, 11);
      terminal.rerender(node(false, 39, 0));
      await settleTerminal();
      terminal.input('\x1b[B');
      terminal.input('\r');
      await settleTerminal();
      expect(onSelect).not.toHaveBeenCalled();
      terminal.resize(40, 12);
      terminal.rerender(node(true, 40, 3));
      await settleTerminal();
      expect(terminal.lastFrame()).toContain('CHOICE5');
      terminal.input('\r');
      await settleTerminal();
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('anthropic', 'model-5');
    } finally { terminal.dispose(); }
  });
});
