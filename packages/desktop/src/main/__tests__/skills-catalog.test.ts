import { describe, expect, it, vi } from 'vitest';
import type { HostControlMsg, MainControlMsg } from '../../shared/port-protocol.js';
import { queryInstalledSkills, type CatalogProcess } from '../skills-catalog.js';

function fakeChild() {
  const listeners: { message: Array<(m: HostControlMsg) => void>; exit: Array<(c: number | null) => void> } = { message: [], exit: [] };
  const sent: MainControlMsg[] = [];
  const kill = vi.fn(() => true);
  const child: CatalogProcess = {
    postMessage: (m) => { sent.push(m); },
    on: ((event: 'message' | 'exit', listener: never) => { (listeners[event] as unknown[]).push(listener); }) as CatalogProcess['on'],
    kill,
  };
  return { child, sent, kill, say: (m: HostControlMsg) => listeners.message.forEach((l) => l(m)), exit: (c: number | null) => listeners.exit.forEach((l) => l(c)) };
}

const skill = { name: 'review', source: 'user', description: 'd', enabled: true, invalid: false } as const;

describe('queryInstalledSkills', () => {
  it('asks the child for the directory it was given and returns what it answers', async () => {
    const fake = fakeChild();
    const pending = queryInstalledSkills({ forkCatalog: () => fake.child }, 'C:/work');
    expect(fake.sent).toEqual([{ v: 1, kind: 'skills-query', cwd: 'C:/work' }]);
    fake.say({ v: 1, kind: 'skills', skills: [skill] });
    await expect(pending).resolves.toEqual({ ok: true, skills: [skill] });
    expect(fake.kill).toHaveBeenCalled(); // never leaves the process behind
  });

  it('reports a fatal answer as a failure with the child\'s own message', async () => {
    const fake = fakeChild();
    const pending = queryInstalledSkills({ forkCatalog: () => fake.child }, '/w');
    fake.say({ v: 1, kind: 'fatal', code: 'catalog_failed', message: 'boom' });
    await expect(pending).resolves.toEqual({ ok: false, reason: 'failed', message: 'boom' });
  });

  it('reports a child that dies before answering', async () => {
    const fake = fakeChild();
    const pending = queryInstalledSkills({ forkCatalog: () => fake.child }, '/w');
    fake.exit(1);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'exited' });
  });

  it('gives up after the deadline, kills the child and does not wait forever', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeChild();
      const pending = queryInstalledSkills({ forkCatalog: () => fake.child }, '/w', { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(101);
      await expect(pending).resolves.toMatchObject({ ok: false, reason: 'timeout' });
      expect(fake.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles once: a late answer after the timeout changes nothing', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeChild();
      const pending = queryInstalledSkills({ forkCatalog: () => fake.child }, '/w', { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(51);
      fake.say({ v: 1, kind: 'skills', skills: [skill] });
      await expect(pending).resolves.toMatchObject({ ok: false, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
