import React from 'react';
import { Box, Text, useInput } from 'ink';
import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { buildQueueLayout } from '../ui/layout/queue-layout.js';
import { QueuePanel } from '../ui/QueuePanel.js';
import { getTheme } from '../ui/theme.js';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';

describe('queue footer allocation', () => {
  it('keeps FIFO IDs, limits rows and counts hidden messages', () => {
    const pending = Array.from({ length: 8 }, (_, i) => ({ queueId: `${i}`, text: 'same\nbody' }));
    const layout = buildQueueLayout({ pending, columns: 40, terminalRows: 24,
      availableRows: 4, paused: false });
    expect(layout.rows).toBe(4);
    expect(layout.items.map((item) => item.queueId)).toEqual(['0', '1', '2']);
    expect(layout.hiddenCount).toBe(5);
    expect([layout.title, ...layout.items.map((item) => item.label)]
      .every((line) => stringWidth(line) <= 40)).toBe(true);
  });
  it('respects zero and one row allocations', () => {
    const input = { pending: [{ queueId: 'a', text: 'hello' }], columns: 40,
      terminalRows: 12, paused: true };
    expect(buildQueueLayout({ ...input, availableRows: 0 }).rows).toBe(0);
    expect(buildQueueLayout({ ...input, availableRows: 1 }).rows).toBe(1);
  });
});

describe('queue panel measured output in real Ink', () => {
  it.each([[40, 12, 2], [80, 24, 4], [40, 12, 1], [40, 12, 0]])
  ('renders FIFO summaries within %i columns, %i terminal rows and %i allocated rows',
    async (columns, terminalRows, availableRows) => {
      const caps = { unicode: false, colorLevel: 0 } as const;
      const theme = getTheme('cool', caps);
      const pending = ['FIRST', 'SECOND', 'THIRD', 'FOURTH'].map((label, index) => ({
        queueId: `q${index}`,
        text: `\x1b[31m${label} ${'\u4e2d\ud83d\udc69\u200d\ud83d\udcbb'.repeat(30)}\nbody`,
      }));
      const layout = buildQueueLayout({ pending, columns, terminalRows,
        availableRows, paused: true });
      const terminal = createTerminalHarness(columns, terminalRows);
      function Frame() {
        useInput(() => {});
        return <Box width={columns} flexDirection="column">
          <Text>BEFORE</Text>
          <QueuePanel layout={layout} theme={theme} />
          <Text>AFTER</Text>
        </Box>;
      }
      try {
        terminal.mount(<Frame />);
        await settleTerminal();
        // Ink may emit a cursor-visibility control after the initial paint.
        const frame = [...terminal.frames].reverse().find((chunk) => chunk.includes('BEFORE'));
        expect(frame).toBeDefined();
        const rows = stripAnsi(frame!).trimEnd().split('\n');
        const start = rows.findIndex((row) => row.trim() === 'BEFORE');
        const end = rows.findIndex((row) => row.trim() === 'AFTER');
        expect(start).toBe(0);
        expect(end - start - 1).toBe(layout.rows);
        expect(layout.rows).toBe(availableRows);
        expect(rows.every((row) => stringWidth(row) <= columns)).toBe(true);
        const panelRows = rows.slice(start + 1, end);
        expect(panelRows.join('\n')).not.toContain('[31m');
        if (availableRows === 0) {
          expect(panelRows).toEqual([]);
          return;
        }
        expect(panelRows[0]?.trimEnd()).toBe(layout.title);
        expect(panelRows[0]).toContain('/queue');
        if (availableRows > 1) {
          expect(panelRows.slice(1).map((row) => row.trimEnd()))
            .toEqual(layout.items.map((item) => item.label));
          expect(panelRows[1]).toContain('1. FIRST');
          expect(panelRows[1]).toContain('(+1 lines)');
          if (availableRows === 4) {
            expect(panelRows[2]).toContain('2. SECOND');
            expect(panelRows[3]).toContain('3. THIRD');
            expect(panelRows.join('\n')).not.toContain('FOURTH');
          }
        }
      } finally { terminal.dispose(); }
    });
});
