import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RENDERER = join(__dirname, '..', '..', 'renderer');

describe('developer mode chord', () => {
  it('is hidden: the shortcut sheet, palette and shortcut table never mention it', () => {
    const sources = ['layout/ShortcutSheet.tsx', 'layout/CommandPalette.tsx', 'lib/settings-shortcuts.ts'];
    for (const path of sources) {
      const text = readFileSync(join(RENDERER, path), 'utf8');
      expect(text, path).not.toMatch(/shift\+d|developer/i);
    }
  });

  it('is bound exactly once, in the app shell', () => {
    const shell = readFileSync(join(RENDERER, 'layout/AppShell.tsx'), 'utf8');
    expect(shell.match(/combo: 'mod\+shift\+d'/g)).toHaveLength(1);
  });
});
