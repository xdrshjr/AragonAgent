/**
 * `/terminal-setup` and the `/mouse status` wording
 * (tui-shift-enter-copy-queue 3.6 / 4.4).
 *
 * Both commands exist to TEACH a gesture that changed, so the test pins the
 * two halves a silent regression would break first: the setup advice still
 * names the CSI-u sequence the stdin filter recognizes, and the mouse status
 * row still names the commit key now that releasing no longer copies.
 */

import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../commands/registry.js';
import { registerBuiltinCommands } from '../commands/builtins.js';
import type { CommandContext } from '../commands/registry.js';

function makeCtx(): CommandContext & { notices: Array<[string, string]> } {
  const notices: Array<[string, string]> = [];
  return {
    args: '',
    controller: {},
    state: { entries: [] },
    dispatch: vi.fn(),
    setOverlay: vi.fn(),
    notify: (level: string, text: string) => notices.push([level, text]),
    toast: (level: string, text: string) => notices.push([`toast:${level}`, text]),
    persistConfig: vi.fn(),
    exit: vi.fn(),
    submit: vi.fn(),
    notices,
  } as unknown as CommandContext & { notices: Array<[string, string]> };
}

function run(name: string, ctx: CommandContext): Promise<void> | void {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  return registry.get(name)!.run(ctx);
}

describe('/terminal-setup (tui-shift-enter-copy-queue 3.6)', () => {
  it('is registered, read-only, and prints the CSI-u binding advice', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    expect(registry.get('terminal-setup')).toBeDefined();

    const ctx = makeCtx();
    await run('terminal-setup', ctx);
    expect(ctx.notices).toHaveLength(1);
    const [level, text] = ctx.notices[0]!;
    expect(level).toBe('info');
    // The sequence the stdin filter recognizes (input/enter-sequences.ts) is
    // the one the advice must teach -- the two can only drift together.
    expect(text).toContain('\\u001b[13;2u');
    expect(text).toContain('Windows Terminal');
    expect(text).toContain('VS Code');
    expect(text).toContain('iTerm2');
    // conhost cannot rebind Enter; the advice must say what to use instead.
    expect(text).toContain('Ctrl+J');
    expect(text).toContain('"copyOnSelect": false');
    expect(text).toContain('"terminal.integrated.copyOnSelection": false');
    expect(text).toContain('"when": "terminalFocus"');
    expect(text).not.toContain('every terminal');
    // glyphs.test.ts scans for non-ASCII in commands/**; this keeps the
    // command's own contract visible in its own file.
    expect(text).toMatch(/^[\x20-\x7e\r\n]*$/);
  });
});

describe('/mouse status drag-select row (tui-shift-enter-copy-queue 4.4)', () => {
  function mouseCtx(selectEnabled: boolean): CommandContext & { notices: Array<[string, string]> } {
    const ctx = makeCtx();
    (ctx as unknown as { mouse: unknown }).mouse = {
      captured: () => true,
      setCapture: vi.fn(),
      selectEnabled: () => selectEnabled,
    };
    return ctx;
  }

  it('names the Ctrl+C commit key while drag-select is on', async () => {
    const ctx = mouseCtx(true);
    await run('mouse', ctx);
    expect(ctx.notices[0]![1]).toContain('drag-select  on (drag to select, ctrl+c to copy)');
  });

  it('still reports the off state without teaching the gesture', async () => {
    const ctx = mouseCtx(false);
    await run('mouse', ctx);
    expect(ctx.notices[0]![1]).toContain('drag-select  off (mouseSelect is false)');
    expect(ctx.notices[0]![1]).not.toContain('ctrl+c to copy');
  });
});
