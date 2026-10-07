import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { CommandRegistry, type CommandContext } from '../commands/registry.js';
import { initialViewState } from '../agent/reducer.js';

const directory = resolve('.agentmesh/queue-session-tests');
mkdirSync(directory, { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const registry = new CommandRegistry();
registerBuiltinCommands(registry);
function context(): CommandContext {
  return {
    args: resolve(directory, 'session.json'), state: initialViewState(),
    controller: {
      isRunning: vi.fn(() => false), isModelSettingsBusy: () => false, getCwd: () => directory,
      getConfig: () => ({ provider: 'anthropic', model: 'custom' }),
      getMessages: () => [], getTodoSnapshot: () => null,
      clearMessages: vi.fn(), clearAllQueues: vi.fn(), replaceMessages: vi.fn(),
      restoreTodos: vi.fn(), setModel: vi.fn(),
    },
    dispatch: vi.fn(), notify: vi.fn(), toast: vi.fn(),
  } as unknown as CommandContext;
}

describe('session command commit boundary', () => {
  it('reports the number of unreceived messages cancelled by reset', () => {
    const ctx = context();
    ctx.state.pendingSteering = [{ queueId: 'a', text: 'keep until reset' }];
    registry.get('reset')!.run(ctx);
    expect(ctx.notify).toHaveBeenCalledWith('warn', expect.stringContaining('1'));
    expect(ctx.controller.clearAllQueues).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'invalid-json'])('keeps the session on %s read failure', (kind) => {
    const ctx = context();
    ctx.args = resolve(directory, `${kind}.json`);
    if (kind === 'invalid-json') writeFileSync(ctx.args, '{');
    registry.get('resume')!.run(ctx);
    expect(ctx.controller.clearAllQueues).not.toHaveBeenCalled();
    expect(ctx.controller.replaceMessages).not.toHaveBeenCalled();
    expect(ctx.controller.restoreTodos).not.toHaveBeenCalled();
    expect(ctx.controller.setModel).not.toHaveBeenCalled();
    expect(ctx.dispatch).not.toHaveBeenCalled();
    expect(ctx.notify).toHaveBeenCalledWith('error', expect.stringContaining('Resume failed'));
  });

  it.each(['reset', 'resume'])('refuses %s while engine is running despite idle UI', (name) => {
    const ctx = context();
    vi.mocked(ctx.controller.isRunning).mockReturnValue(true);
    registry.get(name)!.run(ctx);
    expect(ctx.controller.clearMessages).not.toHaveBeenCalled();
    expect(ctx.controller.clearAllQueues).not.toHaveBeenCalled();
    expect(ctx.controller.replaceMessages).not.toHaveBeenCalled();
    expect(ctx.dispatch).not.toHaveBeenCalled();
    expect(ctx.notify).toHaveBeenCalledWith('warn', expect.stringContaining('running'));
  });

  it.each([
    { entries: [null], messages: [] },
    { entries: [{ id: 'q', kind: 'queued', text: null }], messages: [] },
    { entries: [], messages: [{ role: 'assistant', content: [{ type: 'text', text: 1 }] }] },
    { entries: [], messages: [], model: { providerId: 'bad', modelId: 'm' } },
  ])('leaves the live session intact on invalid file (%#)', (session) => {
    const ctx = context();
    writeFileSync(ctx.args, JSON.stringify(session));
    registry.get('resume')!.run(ctx);
    expect(ctx.controller.clearAllQueues).not.toHaveBeenCalled();
    expect(ctx.controller.replaceMessages).not.toHaveBeenCalled();
    expect(ctx.controller.restoreTodos).not.toHaveBeenCalled();
    expect(ctx.controller.setModel).not.toHaveBeenCalled();
    expect(ctx.dispatch).not.toHaveBeenCalled();
    expect(ctx.notify).toHaveBeenCalledWith('error', expect.stringContaining('Resume failed'));
  });

  it('checks engine again after preparation and before any setter', () => {
    const ctx = context();
    writeFileSync(ctx.args, JSON.stringify({ entries: [], messages: [] }));
    vi.mocked(ctx.controller.isRunning).mockReturnValueOnce(false).mockReturnValueOnce(true);
    registry.get('resume')!.run(ctx);
    expect(ctx.controller.replaceMessages).not.toHaveBeenCalled();
    expect(ctx.dispatch).not.toHaveBeenCalled();
  });

  it('clears old queue only on successful resume and restores warnings without replay', () => {
    const ctx = context();
    writeFileSync(ctx.args, JSON.stringify({ messages: [],
      entries: [{ id: 'q', kind: 'queued', text: 'full\nbody' }],
      todos: [{ content: ' task ' }] }));
    registry.get('resume')!.run(ctx);
    expect(ctx.controller.clearAllQueues).toHaveBeenCalledOnce();
    expect(ctx.controller.restoreTodos).toHaveBeenCalledWith([
      { content: 'task', activeForm: 'task', status: 'in_progress' },
    ]);
    expect(ctx.dispatch).toHaveBeenCalledWith({ type: 'restoreEntries', entries: [
      { id: 'q', kind: 'notice', level: 'warn', text: 'Queued but never sent: full\nbody' },
    ] });
  });

  it('saves every trimmed pending full body in pending order', () => {
    const ctx = context();
    ctx.state.pendingSteering = ['a', 'b', 'c'].map((queueId) => ({ queueId, text: 'same\nbody' }));
    ctx.state.entries = [{ id: 'visible', kind: 'queued', ...ctx.state.pendingSteering[1]! }];
    registry.get('save')!.run(ctx);
    const saved = JSON.parse(readFileSync(ctx.args, 'utf8'));
    expect(saved.entries.map((entry: { queueId: string }) => entry.queueId)).toEqual(['a', 'b', 'c']);
    expect(saved.entries.every((entry: { text: string }) => entry.text === 'same\nbody')).toBe(true);
  });
});
