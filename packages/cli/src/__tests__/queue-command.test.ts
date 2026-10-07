import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry, type CommandContext } from '../commands/registry.js';
import { registerBuiltinCommands } from '../commands/builtins.js';

describe('/queue command', () => {
  it('registers in ordinary completion and opens the read-only overlay', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const ctx = { setOverlay: vi.fn(), dispatch: vi.fn() } as unknown as CommandContext;
    await registry.get('queue')!.run(ctx);
    expect(ctx.setOverlay).toHaveBeenCalledExactlyOnceWith('queue');
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });
});
