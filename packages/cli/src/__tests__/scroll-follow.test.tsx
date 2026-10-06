/**
 * `ScrollViewport` as an ADAPTER (tui-selection-and-scroll-follow §4.3 / P1-10).
 *
 * SMOKE ONLY, AND DELIBERATELY SO. `ink-testing-library`'s stdout stub reports no
 * height, so a mounted viewport measures `content === viewport`,
 * `overflowLines === 0`, and neither follow rule can ever engage — the same
 * limitation `render-at-width.ts` and `budget.test.ts` both record. The
 * BEHAVIOURAL cases therefore live in `follow-state.test.ts`, against the pure
 * reducer, and what is left to check here is the wiring: that the component reads
 * the tail sink, publishes `shiftUp`, and survives every prop being absent.
 */

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Box, Text } from 'ink';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';
import { render } from 'ink-testing-library';
import { ScrollViewport } from '../ui/layout/ScrollViewport.js';
import { emptyTailState } from '../ui/layout/follow-state.js';
import { getTheme } from '../ui/theme.js';
import type { TermCapabilities } from '../ui/capabilities.js';

const CAPS: TermCapabilities = { colorLevel: 3, unicode: true };
const THEME = getTheme('cool', CAPS);

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('ScrollViewport — the adapter', () => {
  it('AC-3: the hint really left the viewport', async () => {
    // It renders inside the composer's input box now (§4.2). A viewport that
    // still drew it would be spending a content row on chrome AND feeding the
    // number back into its own derivation.
    const { lastFrame, unmount } = render(
      <ScrollViewport theme={THEME} caps={CAPS}>
        <Text>body</Text>
      </ScrollViewport>,
    );
    await delay(20);
    expect(lastFrame()).not.toContain('PgDn for the latest');
    expect(lastFrame()).not.toContain('new lines');
    unmount();
  });

  it('publishes the offset and the shift, and starts pinned', async () => {
    const offsets: number[] = [];
    const shifts: number[] = [];
    const onScrolledLinesChange = vi.fn((n: number) => offsets.push(n));
    const onViewportShiftChange = vi.fn((n: number) => shifts.push(n));
    const { unmount } = render(
      <ScrollViewport
        theme={THEME}
        caps={CAPS}
        onScrolledLinesChange={onScrolledLinesChange}
        onViewportShiftChange={onViewportShiftChange}
      >
        <Text>body</Text>
      </ScrollViewport>,
    );
    await delay(20);
    expect(offsets[0]).toBe(0);
    expect(shifts[0]).toBe(0);
    unmount();
  });

  it('reads the tail sink without requiring it', async () => {
    // ABSENT ⇒ NO ANCHORING AT ALL, deliberately: `tailDelta` is then permanently
    // 0, so every caller and every test that predates this feature behaves
    // exactly as it did. That is what let this land without touching a single
    // existing viewport case.
    const sink = { current: emptyTailState() };
    sink.current = { rows: 42, lastId: 'a', lastHeight: 3 };
    const withSink = render(
      <ScrollViewport theme={THEME} caps={CAPS} tailRowsRef={sink} resumeMs={5000}>
        <Text>body</Text>
      </ScrollViewport>,
    );
    await delay(20);
    const withoutSink = render(
      <ScrollViewport theme={THEME} caps={CAPS}>
        <Text>body</Text>
      </ScrollViewport>,
    );
    await delay(20);
    // Same picture either way in a stub with no height — which is exactly the
    // limitation this file's header records, and the reason the rules are tested
    // elsewhere.
    expect(withSink.lastFrame()).toBe(withoutSink.lastFrame());
    withSink.unmount();
    withoutSink.unmount();
  });

  it('AC-9: creates no timer at all with `resumeMs: 0`', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const before = spy.mock.calls.length;
    const sink = { current: { rows: 30, lastId: 'a', lastHeight: 1 } };
    const { unmount } = render(
      <ScrollViewport theme={THEME} caps={CAPS} tailRowsRef={sink} resumeMs={0}>
        <Text>body</Text>
      </ScrollViewport>,
    );
    await delay(20);
    // Ink itself schedules timers, so this asserts on OUR arming path rather than
    // on a global count: `shouldArmResume` refuses on `resumeMs <= 0` before
    // anything else is considered, so the viewport contributes none.
    const ours = spy.mock.calls.slice(before).filter(([, ms]) => ms === 0);
    expect(ours).toHaveLength(0);
    spy.mockRestore();
    unmount();
  });

  it('accepts `hold` without disturbing a pinned viewport', async () => {
    const { lastFrame, unmount } = render(
      <ScrollViewport theme={THEME} caps={CAPS} hold resumeMs={5000}>
        <Text>body</Text>
      </ScrollViewport>,
    );
    await delay(20);
    expect(lastFrame()).toContain('body');
    unmount();
  });
});


describe('unified follow with actual Yoga height', () => {
  it('combines output and footer shrink before clamping the old position', async () => {
    const terminal = createTerminalHarness();
    const sink = { current: emptyTailState() };
    let offset = 0;
    const node = (body: number, footer: number, nonce: number) => <Box height={20} width={80}>
      <ScrollViewport theme={THEME} caps={CAPS} tailRowsRef={sink}
        intent={{ kind: 'lineUp', repeat: 60, nonce }}
        onScrolledLinesChange={(n) => { offset = n; }}
        footer={<Box height={footer} flexShrink={0}><Text>editor</Text></Box>}>
        <Box height={body} flexShrink={0}><Text>messages</Text></Box>
      </ScrollViewport></Box>;
    try {
      terminal.mount(node(70, 10, 0)); await settleTerminal();
      terminal.rerender(node(70, 10, 1)); await settleTerminal();
      expect(offset).toBe(60);
      sink.current.rows = 5;
      terminal.rerender(node(75, 0, 1)); await settleTerminal();
      expect(offset).toBe(55);
    } finally { terminal.dispose(); }
  });
  it('freezes resume during an overlay and starts a full timer after restoration', async () => {
    const terminal = createTerminalHarness();
    const sink = { current: emptyTailState() };
    let offset = 0;
    const node = (active: boolean, body: number, nonce: number) => <Box height={20} width={80}>
      <ScrollViewport theme={THEME} caps={CAPS} active={active} tailRowsRef={sink}
        resumeMs={250} intent={{ kind: 'lineUp', repeat: 10, nonce }}
        onScrolledLinesChange={(n) => { offset = n; }} footer={<Text>editor</Text>}>
        <Box height={body} flexShrink={0}><Text>messages</Text></Box>
      </ScrollViewport></Box>;
    try {
      terminal.mount(node(true, 100, 0)); await settleTerminal();
      terminal.rerender(node(true, 100, 1)); await settleTerminal();
      sink.current.rows = 5;
      terminal.rerender(node(true, 105, 1)); await settleTerminal();
      expect(offset).toBe(15);
      terminal.rerender(node(false, 105, 2)); await delay(300);
      expect(offset).toBe(15);
      sink.current.rows = 9;
      terminal.rerender(node(false, 109, 2)); await settleTerminal();
      terminal.rerender(node(true, 109, 2)); await settleTerminal();
      expect(offset).toBe(19);
      await delay(270);
      expect(offset).toBe(0);
    } finally { terminal.dispose(); }
  });
});
