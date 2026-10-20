/**
 * `/kit` (agent-model-kits §4.9 / AC-40's release leg).
 *
 * THE COMMAND IS THE FALLBACK THAT CANNOT BE EATEN: a terminal, tmux, a IME or an
 * xterm `modifyOtherKeys` mode can all swallow `ctrl+K` (R-4), so every session
 * action must be reachable by typing. These tests drive the REAL command body
 * against a real controller, so "the two surfaces agree" is checked rather than
 * assumed.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type PersistedConfig } from '../config/schema.js';
import { normalizeModelProfiles } from '../config/model-profiles.js';
import { CommandRegistry, runSlashInput } from '../commands/registry.js';
import { registerKitCommand } from '../commands/kit-command.js';

// A PRIVATE CONFIG PATH - see the long note in `kit-apply.test.ts`. Assigning the
// mutable env key is what moves this file onto the forks pool, and the unique
// directory keeps it apart even if it ever shares a process again.
process.env.ARAGON_HOME = process.env.ARAGON_HOME
  ?? mkdtempSync(join(tmpdir(), 'aragon-kit-command-'));

const { AgentController } = await import('../agent/controller.js');
const { loadConfig } = await import('../config/load.js');
const { getConfigPath, writeConfigFile } = await import('../config/store.js');

const instances: Array<InstanceType<typeof AgentController>> = [];
beforeEach(() => { rmSync(getConfigPath(), { force: true }); });
afterAll(() => {
  instances.forEach((instance) => instance.dispose());
  rmSync(getConfigPath(), { force: true });
});

const library = (over: Record<string, unknown> = {}) => normalizeModelProfiles({
  version: 1, mainId: 'p-main', fastId: 'p-fast',
  entries: [
    { id: 'p-main', name: 'Opus', provider: 'anthropic', model: 'opus-4',
      baseUrl: null, apiKey: null, contextWindow: 200000 },
    { id: 'p-fast', name: 'Haiku', provider: 'anthropic', model: 'haiku-4',
      baseUrl: null, apiKey: null, contextWindow: 120000 },
  ],
  kits: [
    { id: 'kit-1', name: 'Deep work', mainProfileId: 'p-main', fastProfileId: 'p-fast',
      subagent: { model: 'fast', modelProfileId: null } },
    { id: 'kit-2', name: 'Cheap', mainProfileId: 'p-fast', fastProfileId: null,
      subagent: { model: 'main', modelProfileId: null } },
  ],
  defaultKitId: 'kit-1', kitsVersion: 1, ...over });

function fixture(over: Record<string, unknown> = {}) {
  writeConfigFile({ ...structuredClone(DEFAULT_CONFIG), provider: 'anthropic', model: 'opus-4',
    apiKeys: {}, modelProfiles: library(over) } as unknown as PersistedConfig);
  const live = loadConfig({ cwd: process.cwd() });
  live.skills.enabled = false;
  live.team.enabled = false;
  live.fast.enabled = false;
  live.compaction.enabled = false;
  const controller = new AgentController(live, {});
  instances.push(controller);
  const notify = vi.fn<(level: string, text: string) => void>();
  const toast = vi.fn<(level: string, text: string) => void>();
  const registry = new CommandRegistry();
  registerKitCommand(registry);
  const run = async (args: string) => {
    await runSlashInput(registry, `/kit ${args}`.trim(), (rest) => ({
      args: rest, controller, state: {} as never, dispatch: () => {}, setOverlay: () => {},
      notify: (level, text) => notify(level, text),
      toast: (level, text) => toast(level, text),
      persistConfig: () => {}, exit: () => {}, submit: () => {}, refreshSkills: () => {},
      applyAgentMode: () => ({ effective: 'build' as const, pending: null }),
    }));
  };
  return { controller, notify, toast, run };
}

const lastText = (mock: ReturnType<typeof vi.fn>): string =>
  String((mock.mock.calls.at(-1) as string[] | undefined)?.[1] ?? '');

describe('/kit: the readback', () => {
  it('names the default kit and what its three slots resolve to', async () => {
    const { run, notify } = fixture();
    await run('');
    const text = lastText(notify);
    expect(text).toContain('Kit pack: Deep work');
    expect(text).toContain('default');
    expect(text).toContain('main anthropic:opus-4');
    expect(text).toContain('sub fast tier');
  });

  it('says what the session kit holds, and what drifted', async () => {
    const { controller, run, notify } = fixture();
    controller.applySessionKit('kit-2');
    await run('');
    const text = lastText(notify);
    expect(text).toContain('Cheap');
    expect(text).toContain('session');
  });

  it('answers honestly on an empty library', async () => {
    const { run, notify } = fixture({ kits: [], defaultKitId: null });
    await run('');
    expect(lastText(notify)).toContain('No kits yet');
  });
});

describe('/kit list', () => {
  it('marks the default and prints each kit with its connections', async () => {
    const { run, notify } = fixture();
    await run('list');
    const text = lastText(notify);
    expect(text).toContain('Kits (2)');
    expect(text).toContain('[Default]');
    expect(text).toContain('Deep work');
    expect(text).toContain('Cheap');
    expect(text).toContain('fast off');
  });

  it('marks the kit in use', async () => {
    const { controller, run, notify } = fixture();
    controller.applySessionKit('kit-2');
    await run('list');
    expect(lastText(notify)).toContain('[In use] Cheap');
  });
});

describe('/kit use', () => {
  it('applies a kit by name for this session only', async () => {
    const { controller, run, toast } = fixture();
    await run('use Cheap');
    expect(controller.getConfig().sessionKit?.id).toBe('kit-2');
    expect(lastText(toast)).toContain('Kit Cheap applied for this session');
  });

  it('releases the session kit with `use current`', async () => {
    const { controller, run, toast } = fixture();
    controller.applySessionKit('kit-2');
    await run('use current');
    expect(controller.getConfig().sessionKit).toBeUndefined();
    expect(lastText(toast)).toContain('Kit released');
  });

  it('explains a name it cannot resolve instead of guessing', async () => {
    const { run, notify } = fixture();
    await run('use Nope');
    expect(lastText(notify)).toContain('No kit named "Nope"');
    expect(lastText(notify)).toContain('Deep work');
  });

  it('refuses a dangling kit with the slot that is broken', async () => {
    const { controller, run, notify } = fixture({ kits: [
      { id: 'kit-1', name: 'Deep work', mainProfileId: 'gone', fastProfileId: null,
        subagent: { model: 'main', modelProfileId: null } }] });
    await run('use Deep work');
    const text = lastText(notify);
    expect(text).toContain('no longer exists');
    expect(text).toContain('main');
    expect(controller.getConfig().sessionKit).toBeUndefined();
  });

  it('asks which kit when `use` has no argument', async () => {
    const { run, notify } = fixture();
    await run('use');
    expect(lastText(notify)).toContain('Which kit');
  });
});

describe('the surface contract', () => {
  it('rejects an unknown subcommand with the three things that do work', async () => {
    const { run, notify } = fixture();
    await run('default');
    const text = lastText(notify);
    expect(text).toContain('Unknown /kit subcommand');
    expect(text).toContain('/kit list');
    expect(text).toContain('/kit use');
  });

  it('registers exactly one command named `kit`', () => {
    const registry = new CommandRegistry();
    registerKitCommand(registry);
    expect(registry.get('kit')?.name).toBe('kit');
    expect(registry.all()).toHaveLength(1);
  });
});
