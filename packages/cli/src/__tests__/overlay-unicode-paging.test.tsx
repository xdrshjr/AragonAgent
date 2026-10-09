import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../ui/overlays/ConfirmDialog.js';
import { getTheme } from '../ui/theme.js';
import { createTerminalHarness, settleTerminal } from './helpers/terminal-harness.js';

describe('Unicode confirmation paging', () => {
  it.each([40, 80])('can read the complete summary at %i columns and one body row', async cols => {
    const caps = { colorLevel: 0 as const, unicode: true };
    const summary = '甲'.repeat(cols) + '重要删除目标👨‍👩‍👧‍👦e\u0301🇨🇳👍🏽';
    const terminal = createTerminalHarness(cols, 12);
    const resolve = vi.fn();
    try {
      terminal.mount(<ConfirmDialog state={{ summary, resolve }} maxRows={3}
        cols={cols} caps={caps} theme={getTheme('warm', caps)} onClose={() => {}} />);
      await settleTerminal();
      let recovered = '';
      for (let page = 0; page < 20; page++) {
        const lines = (terminal.layoutFrames.at(-1) ?? '').trimEnd().split('\n');
        expect(lines).toHaveLength(3);
        expect(lines[2]).toContain('y approve');
        recovered += lines[1]!.trimEnd();
        const position = lines[0]!.match(/(\d+)-(\d+)\/(\d+)/);
        if (!position || position[2] === position[3]) break;
        terminal.input('\x1b[6~');
        await settleTerminal();
      }
      expect(recovered).toBe(summary);
      expect(resolve).not.toHaveBeenCalled();
    } finally { terminal.dispose(); }
  });
});
