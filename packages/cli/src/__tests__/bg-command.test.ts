/**
 * `/bg` — the user's handle on what the agent left running (§7.5 / AC-32).
 *
 * Driven through `runSlashInput` rather than by calling the command object, so
 * argument parsing (`stop all`, `logs s1 5`) is exercised the way a user reaches
 * it.
 *
 * IT IS THE LIVE VIEW, and that is why it exists at all. The transcript records
 * EVENTS about a service (D-11) - a card printed into `<Static>` cannot be
 * rewritten - so "what is running right now" lives here, in the status chip, and
 * in `bash_output`. Without this command a user whose server card scrolled away
 * an hour ago has no way to name it.
 */

import { describe, expect, it } from 'vitest';
import { registerBuiltinCommands } from '../commands/builtins.js';
import { CommandRegistry, runSlashInput, type CommandContext } from '../commands/registry.js';
import type { AgentController } from '../agent/controller.js';
import type { ServiceSnapshot } from '../proc/types.js';

const registry = new CommandRegistry();
registerBuiltinCommands(registry);

function snapshot(over: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    id: 's1',
    toolCallId: 'c1',
    command: 'npm run dev',
    cwd: '/tmp',
    pid: 11,
    status: 'ready',
    startedAt: Date.now() - 5000,
    readyAt: Date.now() - 3600,
    exitCode: null,
    signal: null,
    url: 'http://localhost:3000',
    rows: ['> next dev', '  - Local: http://localhost:3000'],
    rowsSeen: 2,
    truncated: false,
    ...over,
  };
}

interface Harness {
  ctx: (args: string) => CommandContext;
  notices: string[];
  toasts: string[];
  stopped: string[];
}

function harness(
  over: { services?: ServiceSnapshot[]; registered?: boolean } = {},
): Harness {
  let services = over.services ?? [];
  const notices: string[] = [];
  const toasts: string[] = [];
  const stopped: string[] = [];

  const controller = {
    isBackgroundRegistered: () => over.registered !== false,
    listServices: () => services,
    liveServiceCount: () =>
      services.filter((s) => s.status === 'starting' || s.status === 'ready' || s.status === 'running')
        .length,
    getServiceSnapshot: (id: string) => services.find((s) => s.id === id),
    readServiceLog: (id: string) => {
      const service = services.find((s) => s.id === id);
      return service
        ? { rows: service.rows, cursor: service.rowsSeen, truncated: service.truncated }
        : undefined;
    },
    stopService: async (id: string) => {
      stopped.push(id);
      const targets = id === 'all' ? services : services.filter((s) => s.id === id);
      const result = targets.map((s) => ({ ...s, status: 'stopped' as const }));
      // `/bg` reads the LIVE list afterwards, so the harness has to move too -
      // otherwise AC-32's second half would pass against a stale array.
      services = services.map((s) => ({ ...s, status: 'stopped' as const }));
      return result;
    },
  } as unknown as AgentController;

  return {
    notices,
    toasts,
    stopped,
    ctx: (args: string) =>
      ({
        args,
        controller,
        notify: (_level: string, text: string) => notices.push(text),
        toast: (_level: string, text: string) => toasts.push(text),
      }) as unknown as CommandContext,
  };
}

describe('/bg', () => {
  it('lists id, status, uptime, url and command', async () => {
    const h = harness({ services: [snapshot()] });
    await runSlashInput(registry, '/bg', h.ctx);
    expect(h.notices.join('\n')).toContain('s1');
    expect(h.notices.join('\n')).toContain('ready');
    expect(h.notices.join('\n')).toContain('http://localhost:3000');
    expect(h.notices.join('\n')).toContain('npm run dev');
  });

  it('AC-32: `/bg stop all` then `/bg` reports an empty list', async () => {
    const h = harness({ services: [snapshot(), snapshot({ id: 's2', url: undefined })] });
    await runSlashInput(registry, '/bg stop all', h.ctx);
    expect(h.stopped).toEqual(['all']);
    expect(h.toasts.join('\n')).toContain('Stopped 2 services');

    h.notices.length = 0;
    await runSlashInput(registry, '/bg status', h.ctx);
    expect(h.notices.join('\n')).toContain('No background services running');
  });

  it('`logs` prints the tail without going through the model', async () => {
    const h = harness({ services: [snapshot()] });
    await runSlashInput(registry, '/bg logs s1', h.ctx);
    expect(h.notices.join('\n')).toContain('- Local: http://localhost:3000');
  });

  it('`logs` on an unknown id says so rather than printing nothing', async () => {
    const h = harness({ services: [snapshot()] });
    await runSlashInput(registry, '/bg logs s9', h.ctx);
    expect(h.notices.join('\n')).toContain('No service "s9"');
  });

  it('reports honestly when a stop may have left a detached child (R-2 / P2-6)', async () => {
    // `taskkill /t` cannot reach a grandchild that re-parented itself, and an
    // honest warning beats a silent leak: it is the difference between a puzzle
    // and a `netstat` the user knows to run.
    const h = harness({ services: [snapshot({ killIncomplete: true })] });
    await runSlashInput(registry, '/bg stop s1', h.ctx);
    expect(h.notices.join('\n')).toContain('may have left a detached child');
  });

  it('says so when background services are off for the session', async () => {
    const h = harness({ registered: false });
    await runSlashInput(registry, '/bg', h.ctx);
    expect(h.notices.join('\n')).toContain('off for this session');
  });

  it('rejects an unknown verb by naming the real ones', async () => {
    const h = harness({ services: [snapshot()] });
    await runSlashInput(registry, '/bg frobnicate', h.ctx);
    expect(h.notices.join('\n')).toContain('/bg [list|logs|stop|status]');
  });
});
