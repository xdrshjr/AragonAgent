import { describe, expect, it } from 'vitest';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { helpRows } from '../ui/overlays/HelpOverlay.js';
import { getTheme } from '../ui/theme.js';
import { scrollModeNoticeText, SCROLL_MODE_NOTICE_VERSION } from '../ui/use-startup-notices.js';

const CAPS = { colorLevel: 0 as const, unicode: false };
const THEME = getTheme('cool', CAPS);
const keysOf = (rows: ReturnType<typeof helpRows>): string[] => rows.map((row) => String(row.key));

describe('/mouse in native scroll mode', () => {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);

  it('explains that the terminal handles scrolling and selection', async () => {
    const notices: string[] = [];
    const ctx = {
      args: '', nativeScroll: true,
      notify: (_level: string, text: string) => notices.push(text),
      toast: () => undefined,
    } as unknown as CommandContext;
    await runSlashInput(registry, '/mouse off', () => ctx);
    expect(notices).toEqual([
      'Mouse capture is not used in native scroll mode; your terminal handles scrolling and selection.',
    ]);
  });
});

describe('help overlay rows', () => {
  it('app mode keeps every scroll and selection row', () => {
    const keys = keysOf(helpRows(THEME, CAPS));
    for (const key of ['r-Wheel', 'r-Shift+Wheel', 'r-Shift+Up / Shift+Down', 'r-Drag right edge']) {
      expect(keys).toContain(key);
    }
  });

  it('native mode drops the app-owned scroll rows and points at the terminal', () => {
    const native = keysOf(helpRows(THEME, CAPS, true));
    for (const key of ['r-Wheel', 'r-Shift+Wheel', 'r-Shift+Up / Shift+Down', 'r-Drag right edge',
      'r-^N', 'r-Drag text (left button)', 'r-Ctrl+C (with a selection)']) {
      expect(native).not.toContain(key);
    }
    expect(native).toContain('r-Scroll');
    // Overlay paging is application content and stays.
    expect(native).toContain('r-PgUp / PgDn');
  });

  it('is the default, argument-free form for every existing caller', () => {
    expect(helpRows(THEME, CAPS).length).toBe(helpRows(THEME, CAPS, false).length);
  });
});

describe('the one-time native scroll notice', () => {
  it('names the one-step way back and the config key', () => {
    expect(SCROLL_MODE_NOTICE_VERSION).toBeGreaterThanOrEqual(1);
    const text = scrollModeNoticeText();
    expect(text).toContain('aragon config set scrollMode app');
    expect(text).toMatch(/^[\x20-\x7e]*$/);
  });
});
