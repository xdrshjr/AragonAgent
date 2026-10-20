/**
 * `waitForJob` — the bounded wait primitive (long-task-jobs AC-8..AC-13).
 *
 * A HAND-BUILT PORT RATHER THAN A SUPERVISOR, because the whole point of D-9 is
 * that waiting needs only `get` / `read` / `subscribe`: if this file had to build
 * a real child process to test a timeout, the design would be wrong.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForJob, type WaitPort } from '../proc/wait.js';
import type { ProcEvent, ServiceSnapshot } from '../proc/types.js';

function snapshot(over: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    id: 't1',
    kind: 'task',
    toolCallId: 'c1',
    command: 'python train.py',
    cwd: '/tmp',
    pid: 11,
    status: 'running',
    startedAt: Date.now() - 5000,
    exitCode: null,
    signal: null,
    rows: [],
    rowsSeen: 3,
    truncated: false,
    lastOutputAt: Date.now(),
    ...over,
  };
}

interface Harness {
  port: WaitPort;
  emit(event: ProcEvent): void;
  set(snapshot: ServiceSnapshot): void;
  subscriptions: number;
  unsubscribes: number;
}

function harness(initial: ServiceSnapshot[]): Harness {
  const jobs = new Map(initial.map((job) => [job.id, job]));
  const listeners = new Set<(event: ProcEvent) => void>();
  const state: Harness = {
    subscriptions: 0,
    unsubscribes: 0,
    emit: (event) => {
      jobs.set(event.service.id, event.service);
      for (const listener of [...listeners]) listener(event);
    },
    set: (next) => {
      jobs.set(next.id, next);
    },
    port: {
      get: (id) => jobs.get(id),
      read: (id) => ({ rows: ['a'], cursor: 3, truncated: false }),
      subscribe: (listener) => {
        state.subscriptions += 1;
        listeners.add(listener);
        return () => {
          state.unsubscribes += 1;
          listeners.delete(listener);
        };
      },
    },
  };
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForJob', () => {
  it('AC-8: an already-terminal target resolves with no timer and no listener', async () => {
    const h = harness([snapshot({ status: 'exited', exitCode: 0 })]);
    const outcome = await waitForJob(h.port, { targets: ['t1'], timeoutMs: 30_000 });
    expect(outcome).toMatchObject({ terminal: true, waitedMs: 0, timedOut: false });
    expect(h.subscriptions).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an empty target list is a no-op, not a full-timeout wait', async () => {
    const h = harness([]);
    const outcome = await waitForJob(h.port, { targets: [], timeoutMs: 30_000 });
    expect(outcome.terminal).toBe(true);
    expect(h.subscriptions).toBe(0);
  });

  it('AC-9: a target that exits mid-wait settles on that event', async () => {
    const h = harness([snapshot()]);
    const done = waitForJob(h.port, { targets: ['t1'], timeoutMs: 30_000 });
    h.emit({ type: 'exited', service: snapshot({ status: 'exited', exitCode: 0 }) });
    const outcome = await done;
    expect(outcome.terminal).toBe(true);
    expect(outcome.jobs[0]?.exitCode).toBe(0);
    expect(h.unsubscribes).toBe(1);
  });

  it('an unrelated job finishing does not settle the wait', async () => {
    const h = harness([snapshot(), snapshot({ id: 't2' })]);
    let settled = false;
    const done = waitForJob(h.port, { targets: ['t1'], timeoutMs: 30_000 }).then((o) => {
      settled = true;
      return o;
    });
    h.emit({ type: 'exited', service: snapshot({ id: 't2', status: 'exited', exitCode: 0 }) });
    await Promise.resolve();
    expect(settled).toBe(false);
    h.emit({ type: 'exited', service: snapshot({ status: 'exited', exitCode: 1 }) });
    expect((await done).terminal).toBe(true);
  });

  it('AC-10: the timeout fires, reports "still running", and leaks nothing', async () => {
    const h = harness([snapshot()]);
    const done = waitForJob(h.port, { targets: ['t1'], timeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await done;
    expect(outcome).toMatchObject({ timedOut: true, terminal: false });
    expect(vi.getTimerCount()).toBe(0);
    expect(h.unsubscribes).toBe(1);
  });

  it('AC-12: an abort settles at once and removes its listener', async () => {
    const h = harness([snapshot()]);
    const controller = new AbortController();
    const done = waitForJob(h.port, {
      targets: ['t1'],
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await done;
    expect(outcome.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an already-aborted signal resolves before anything is armed', async () => {
    const h = harness([snapshot()]);
    const controller = new AbortController();
    controller.abort();
    const outcome = await waitForJob(h.port, {
      targets: ['t1'],
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    expect(outcome.aborted).toBe(true);
    expect(h.subscriptions).toBe(1);
    expect(h.unsubscribes).toBe(1);
  });

  it('AC-13: `all` waits for every target, and only then settles', async () => {
    const h = harness([snapshot(), snapshot({ id: 's1', kind: 'service', status: 'ready' })]);
    const done = waitForJob(h.port, { targets: ['t1', 's1'], timeoutMs: 30_000 });
    h.emit({ type: 'exited', service: snapshot({ status: 'exited', exitCode: 0 }) });
    await Promise.resolve();
    h.emit({ type: 'stopped', service: snapshot({ id: 's1', kind: 'service', status: 'stopped' }) });
    const outcome = await done;
    expect(outcome.terminal).toBe(true);
    expect(outcome.jobs.map((job) => job.id)).toEqual(['t1', 's1']);
  });

  it('a reclaimed id counts as settled rather than burning the timeout', async () => {
    const h = harness([]);
    const outcome = await waitForJob(h.port, { targets: ['t9'], timeoutMs: 30_000 });
    expect(outcome.terminal).toBe(true);
    expect(outcome.waitedMs).toBe(0);
  });
});
