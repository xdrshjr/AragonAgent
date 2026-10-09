import { describe, it, expect } from 'vitest';
import React from 'react';
import { Box, useInput } from 'ink';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { QueueOverlay, projectQueueRows, restoreQueueAnchor } from '../ui/overlays/QueueOverlay.js';
import { getTheme } from '../ui/theme.js';
import { OVERLAY_PAGE } from '../ui/use-wheel-routing.js';
import type { PendingSteering } from '../agent/queued-messages.js';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';

describe('queue full text projection', () => {
  it('preserves Unicode source text and complete graphemes through wrapping', () => {
    const text = '\u4e2d\u6587\ud83d\udc69\u200d\ud83d\udcbb' + 'e\u0301'.repeat(12);
    const rows = projectQueueRows([{ queueId: 'unicode', text }], 6);
    expect(rows.slice(1).map(row => row.text).join('')).toBe(text);
    expect(rows.every(row => row.offset < 0 || stringWidth(row.text) <= 6)).toBe(true);
    expect(rows.slice(1).some(row => row.text.includes('\ud83d\udc69\u200d\ud83d\udcbb'))).toBe(true);
    expect(rows.slice(1).every(row => !row.text.startsWith('\u0301') && !row.text.endsWith('\u200d'))).toBe(true);
  });
  it('preserves whitespace and escapes controls within bounded display rows', () => {
    const rows = projectQueueRows([{ queueId: 'a', text: '  a\tb\n\u001b[31mcode' }], 8);
    expect(rows.every((row) => stringWidth(row.text) <= 8)).toBe(true);
    expect(rows.map((row) => row.text).join('')).toContain('\\x1b[31mcode');
    expect(rows.some((row) => row.text.startsWith('  a'))).toBe(true);
  });
  it('restores a soft-wrap anchor on resize and advances when its message is accepted', () => {
    const pending = [{ queueId: 'a', text: 'abcdefghijklmnop' }, { queueId: 'b', text: 'next' }];
    const before = projectQueueRows(pending, 4);
    const after = projectQueueRows(pending, 8);
    const offset = before.findIndex((row) => row.queueId === 'a' && row.offset === 8);
    expect(after[restoreQueueAnchor(before, after, offset)]?.offset).toBe(8);
    const remaining = projectQueueRows(pending.slice(1), 8);
    expect(remaining[restoreQueueAnchor(before, remaining, offset)]?.queueId).toBe('b');
  });
});

describe('queue overlay ownership and anchors in real Ink', () => {
  it('keeps the full action footer and six-row budget through Unicode content rerenders', async () => {
    const caps = { unicode: true, colorLevel: 0 } as const;
    const theme = getTheme('cool', caps);
    const terminal = createTerminalHarness(40, 12);
    try {
      for (const [index, text] of ['\u4fdd\u7559\u4e2d\u6587 e\u0301',
        '\u4fdd\u7559\u4e2d\u6587 \ud83d\udc69\u200d\ud83d\udcbb e\u0301 tail'].entries()) {
        const node = <QueueOverlay pending={[{ queueId: 'unicode', text }]} cols={40}
          maxRows={6} scrollOffset={0} onScrollClamp={() => {}} theme={theme} caps={caps} />;
        if (index === 0) terminal.mount(node); else terminal.rerender(node);
        await settleTerminal();
        const frame = terminal.layoutFrames.at(-1)!;
        expect(frame).toContain(text);
        expect(frame.trimEnd().split('\n')).toHaveLength(6);
        expect(frame.trimEnd().split('\n').at(-1)).toContain('PgUp/PgDn | Up/Down | Esc');
        expect(frame.split('\n').every(line => stringWidth(line) <= 40)).toBe(true);
      }
    } finally { terminal.dispose(); }
  });
  it.each([3, 6].flatMap(maxRows => [
    '\u4fdd\u7559\u4e2d\u6587 e\u0301',
    '\u4fdd\u7559\u4e2d\u6587 \ud83d\udc69\u200d\ud83d\udcbb e\u0301 tail',
  ].map(text => ({ maxRows, text }))))(
    'preserves full Unicode text $text in a $maxRows-row real frame', async ({ maxRows, text }) => {
    const caps = { unicode: true, colorLevel: 0 } as const;
    const theme = getTheme('cool', caps);
    const terminal = createTerminalHarness(40, 12);
    try {
        terminal.mount(<QueueOverlay pending={[{ queueId: 'unicode', text }]} cols={40}
          maxRows={maxRows} scrollOffset={maxRows === 3 ? 1 : 0}
          onScrollClamp={() => {}} theme={theme} caps={caps} />);
        await settleTerminal();
        const frame = stripAnsi([...terminal.frames].reverse()
          .find(chunk => chunk.includes('Queue:')) ?? '');
        expect(frame).toContain(text);
        expect(frame.trimEnd().split('\n')).toHaveLength(maxRows);
        expect(frame.split('\n').every(line => stringWidth(line) <= 40)).toBe(true);
    } finally { terminal.dispose(); }
  });
  it('shows an English empty state and preserves Unicode message text in the minimum frame', async () => {
    const caps = { unicode: true, colorLevel: 0 } as const;
    const theme = getTheme('cool', caps);
    const terminal = createTerminalHarness(40, 12);
    // Input ownership may write a cursor-control chunk after the complete frame.
    const frame = () => stripAnsi([...terminal.frames].reverse()
      .find(chunk => chunk.includes('Queue:')) ?? '');
    function Frame({ pending }: { pending: readonly PendingSteering[] }) {
      const [offset, setOffset] = React.useState(0);
      useInput((_input, key) => { if (key.downArrow) setOffset(value => value + 1); });
      return <QueueOverlay pending={pending} cols={40} maxRows={3} scrollOffset={offset}
        onScrollClamp={setOffset} theme={theme} caps={caps} />;
    }
    try {
      terminal.mount(<Frame pending={[]} />);
      await settleTerminal();
      expect(frame()).toContain('Queue: 0 pending');
      expect(frame()).toContain('Queue is empty');
      expect(frame().trimEnd().split('\n')).toHaveLength(3);
      const text = '\u4fdd\u7559\u4e2d\u6587 \u539f\u6587';
      terminal.rerender(<Frame pending={[{ queueId: 'unicode', text }]} />);
      await settleTerminal();
      expect(frame()).toContain('Queue: 1 pending');
      terminal.input('\x1b[B');
      await settleTerminal();
      expect(frame()).toContain(text);
      expect(frame().trimEnd().split('\n')).toHaveLength(3);
      expect(frame().split('\n').every(line => stringWidth(line) <= 40)).toBe(true);
    } finally { terminal.dispose(); }
  });
  it('clamps a resized tail before paging and preserves the anchor across partial acceptance', async () => {
    const caps = { unicode: false, colorLevel: 0 } as const;
    const theme = getTheme('cool', caps);
    const pending = [12, 15, 3].map((count, item) => ({
      queueId: String(item),
      text: Array.from({ length: count }, (_, line) =>
        `${String.fromCharCode(65 + item)}${line.toString().padStart(2, '0')} `.padEnd(72, 'x'))
        .join('\n'),
    }));
    const remaining = pending.slice(1);
    const last = pending.slice(2);
    let latestOffset = -1;
    let pageEvents = 0;
    function Frame({ items, cols }: { items: readonly PendingSteering[]; cols: number }) {
      const [offset, setOffset] = React.useState(1_000_000);
      latestOffset = offset;
      // The owner follows App's controlled-overlay routing. QueueOverlay must
      // never install a competing key listener or overwrite this with a stale clamp.
      useInput((_input, key) => {
        if (!key.pageUp) return;
        pageEvents += 1;
        setOffset((current) => Math.max(0, current - OVERLAY_PAGE));
      });
      return <Box width={cols} flexDirection="column">
        <QueueOverlay pending={items} cols={cols} maxRows={10} scrollOffset={offset}
          onScrollClamp={setOffset} theme={theme} caps={caps} />
      </Box>;
    }
    const terminal = createTerminalHarness(40, 12);
    try {
      terminal.mount(<Frame items={pending} cols={40} />);
      await settleTerminal();
      expect(latestOffset).toBe(56);
      terminal.resize(80, 12);
      terminal.rerender(<Frame items={pending} cols={80} />);
      await settleTerminal();
      // The restored anchor is row 29, but only row 28 can head a full page.
      // This catches the old parent-effect override of OverlayFrame's clamp.
      expect(latestOffset).toBe(28);
      expect(terminal.lastFrame()).toContain('B14');
      expect(terminal.lastFrame()).toContain('C02');
      const rows = terminal.lastFrame().trimEnd().split('\n');
      expect(rows.length).toBeLessThanOrEqual(10);
      expect(rows.every((row) => stringWidth(row) <= 80)).toBe(true);

      terminal.input('\x1b[5~');
      await settleTerminal();
      expect(pageEvents).toBe(1);
      expect(latestOffset).toBe(28 - OVERLAY_PAGE);
      expect(terminal.lastFrame()).toContain('B06');
      expect(terminal.lastFrame()).not.toContain('C02');

      terminal.rerender(<Frame items={remaining} cols={80} />);
      await settleTerminal();
      expect(latestOffset).toBe(7);
      expect(terminal.lastFrame()).toContain('B06');
      expect(terminal.lastFrame()).not.toContain('A00');
      terminal.input('\x1b[5~');
      await settleTerminal();
      expect(pageEvents).toBe(2);
      expect(latestOffset).toBe(0);
      expect(terminal.lastFrame()).toContain('B00');

      terminal.rerender(<Frame items={last} cols={80} />);
      await settleTerminal();
      expect(latestOffset).toBe(0);
      expect(terminal.lastFrame()).toContain('C00');
      expect(terminal.lastFrame()).toContain('C02');
      expect(terminal.lastFrame()).not.toContain('B00');
    } finally { terminal.dispose(); }
  });
});
