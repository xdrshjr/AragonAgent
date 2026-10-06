import React from 'react';
import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { StatusBar } from '../ui/StatusBar.js';
import { getTheme } from '../ui/theme.js';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';

const caps = { unicode: false, colorLevel: 0 } as const;

describe('统一滚动的固定状态栏', () => {
  it.each([40, 49, 80, 120])('%i 列紧急提示拥挤时仍能重绘，且提示不换行', async (cols) => {
    const terminal = createTerminalHarness(cols, 12);
    const node = (redrawNonce: number) => <StatusBar
      model="model" provider="provider" status="running" thinkingLevel="off"
      usageTotal={{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        cacheWriteTokens: 0, costUsd: 0 }}
      context={{ occupied: 0, window: 1000, pct: 0, source: 'usage', deltaTokens: 0,
        windowKnown: true, windowOverridden: false }}
      elapsedMs={0} tokPerSec={0} theme={getTheme('cool', caps)} caps={caps}
      servicesActive={{ live: 2 }} scrolledLines={100}
      interruptHint="Esc x2 interrupt" redrawNonce={redrawNonce} />;
    try {
      terminal.mount(node(0));
      await settleTerminal();
      const before = terminal.lastFrame();
      terminal.rerender(node(1));
      await settleTerminal();
      const after = terminal.lastFrame();
      expect(after).not.toBe(before);
      expect(after.startsWith(String.fromCharCode(0x00a0))).toBe(true);
      expect(after).toContain('Esc x2 interrupt');
      expect(after).toContain('Ctrl+C stop 2');
      const lines = after.trimEnd().split('\n');
      expect(lines).toHaveLength(1);
      expect(stringWidth(lines[0]!)).toBeLessThanOrEqual(cols);
    } finally { terminal.dispose(); }
  });
});
