import React from 'react';
import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { formatQueueStatus, queueSummary } from '../ui/QueueStatusRow.js';
import { StatusBar } from '../ui/StatusBar.js';
import { getTheme } from '../ui/theme.js';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';

describe('fixed queue status', () => {
  it.each([40, 60, 80, 120].flatMap((cols) => [false, true].map((unicode) => ({ cols, unicode }))))
  ('preserves queue, required state and redraw at $cols cells (unicode=$unicode)', async ({ cols, unicode }) => {
    const terminal = createTerminalHarness(cols, 12);
    const frame = () => terminal.frames.map((chunk) => stripAnsi(chunk))
      .filter((chunk) => chunk.includes('0%')).at(-1) ?? '';
    const caps = { unicode, colorLevel: 0 } as const;
    const node = (nonce: number) => <StatusBar columns={cols} speedKnown={false}
      model="model" provider="provider" status="idle" thinkingLevel="off"
      usageTotal={{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        cacheWriteTokens: 0, costUsd: 0 }}
      context={{ occupied: 0, window: 1000, pct: 0, source: 'usage', deltaTokens: 0,
        windowKnown: true, windowOverridden: false }}
      elapsedMs={0} tokPerSec={0} theme={getTheme('cool', caps)} caps={caps}
      servicesActive={{ live: 12345 }} todoActive={{ done: 12, total: 12345 }}
      agentMode="plan" pendingAgentMode="build" interruptHint="Esc again to force stop"
      redrawNonce={nonce} pendingSteering={[
        { queueId: 'a', text: '\n中文👩‍💻 first full line\nsecond line' },
        ...Array.from({ length: 101 }, (_, id) => ({ queueId: `b${id}`, text: 'another' })),
      ]} />;
    try {
      terminal.mount(node(0)); await settleTerminal();
      const before = frame();
      expect(before).not.toContain('102');
      expect(before).toContain('0%');
      expect(before).toContain('Idle');
      expect(before).toMatch(/(?:PLAN>BUILD|P>B)/);
      expect(before).not.toContain('Esc');
      expect(before).not.toContain('plan>build');
      expect(before).not.toContain('12345');
      expect(before).not.toContain('second line');
      expect(before.trimEnd().split('\n')).toHaveLength(1);
      expect(stringWidth(before.trimEnd())).toBeLessThanOrEqual(cols);
      terminal.rerender(node(1)); await settleTerminal();
      expect(frame()).not.toBe(before);
      expect(frame().startsWith(String.fromCharCode(0xa0))).toBe(true);
    } finally { terminal.dispose(); }
  });

  it.each([false, true])('keeps a lower-bound count and whole graphemes (unicode=%s)', (unicode) => {
    const pending = Array.from({ length: 102 }, (_, id) => ({ queueId: `${id}`,
      text: '👩‍💻e\u0301中文'.repeat(30) }));
    const parts = formatQueueStatus({ pending, paused: true, compact: true, columns: 26,
      caps: { unicode, colorLevel: 0 } });
    expect(parts.prefix).toBe('Queue(p): ');
    expect(parts.suffix).toBe(' (+99+)');
    expect(stringWidth(parts.prefix + parts.body + parts.suffix)).toBeLessThanOrEqual(26);
    expect(parts.body).not.toMatch(/\u200d$/);
    expect(parts.body).not.toMatch(/e(?:\.|\u2026)/);
  });

  it('uses the first nonempty sanitized line without changing pending text', () => {
    expect(queueSummary('\n\t\n\x1b[31mhello\x1b[0m\tthere\x00\nother')).toBe('hello there');
    expect(queueSummary('\n\r\t')).toBe('(empty)');
  });
});
