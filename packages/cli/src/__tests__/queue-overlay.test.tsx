import { describe, it, expect } from 'vitest';
import React from 'react';
import { Box, useInput } from 'ink';
import stringWidth from 'string-width';
import { QueueOverlay, projectQueueRows, restoreQueueAnchor } from '../ui/overlays/QueueOverlay.js';
import { getTheme } from '../ui/theme.js';
import { OVERLAY_PAGE } from '../ui/use-wheel-routing.js';
import type { PendingSteering } from '../agent/queued-messages.js';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';

describe('queue full text projection', () => {
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
