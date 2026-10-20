/**
 * The `job` event on the machine contract (long-task-jobs AC-31 / §4.10).
 *
 * THE SUBSCRIPTION-COUNT ASSERTION IS THE POINT OF THE FILE. The design's first
 * draft subscribed in `start()`; the follow-through chain enters `run()` more
 * than once, so that placement re-subscribed on every turn and released nothing.
 * `attach()` is the lifecycle the four existing optional streams already use, and
 * this test is what keeps a later "simplification" from moving it back.
 */

import { describe, expect, it, vi } from 'vitest';
import { ExecRunner } from '../exec/runner.js';
import type { ExecEvent } from '../exec/events.js';
import type { ProcEvent, ServiceSnapshot } from '../proc/types.js';
import type { AgentEvent } from '@aragon-agent/core';

function snapshot(over: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    id: 't1',
    kind: 'task',
    toolCallId: 'c1',
    command: 'python train.py',
    cwd: '/tmp',
    pid: 11,
    status: 'running',
    startedAt: Date.now() - 1000,
    exitCode: null,
    signal: null,
    rows: [],
    rowsSeen: 0,
    truncated: false,
    lastOutputAt: Date.now(),
    ...over,
  };
}

interface Harness {
  runner: ExecRunner;
  events: ExecEvent[];
  /** Emit a supervisor event to whatever the runner subscribed. */
  procs: (event: ProcEvent) => void;
  procSubscriptions: number;
  procUnsubscribes: number;
  agent: (event: AgentEvent) => void;
}

function harness(): Harness {
  const events: ExecEvent[] = [];
  const agentListeners = new Set<(event: AgentEvent) => void>();
  const procListeners = new Set<(event: ProcEvent) => void>();
  const state: Harness = {
    events,
    procSubscriptions: 0,
    procUnsubscribes: 0,
    procs: (event) => {
      for (const listener of [...procListeners]) listener(event);
    },
    agent: (event) => {
      for (const listener of [...agentListeners]) listener(event);
    },
    runner: undefined as unknown as ExecRunner,
  };
  const runner = new ExecRunner({
    emitter: {
      init: () => {},
      emit: (event: ExecEvent) => events.push(event),
      result: () => {},
    } as never,
    sessionId: 's1',
    quiet: true,
  } as never);
  state.runner = runner;
  const controller = {
    subscribe: (listener: (event: AgentEvent) => void) => {
      agentListeners.add(listener);
      return () => agentListeners.delete(listener);
    },
    subscribeProc: (listener: (event: ProcEvent) => void) => {
      state.procSubscriptions += 1;
      procListeners.add(listener);
      return () => {
        state.procUnsubscribes += 1;
        procListeners.delete(listener);
      };
    },
    abort: () => {},
  };
  runner.attach(controller as never);
  return state;
}

describe('ExecRunner: the job stream', () => {
  it('maps started / progress / exited onto the `job` channel', () => {
    const h = harness();
    h.procs({ type: 'started', service: snapshot() });
    h.procs({
      type: 'output',
      service: snapshot({ progress: { text: '47%', kind: 'percent' } }),
    });
    h.procs({ type: 'exited', service: snapshot({ status: 'exited', exitCode: 0 }) });
    const jobs = h.events.filter((event) => event.type === 'job');
    expect(jobs.map((event) => (event as { subtype: string }).subtype)).toEqual([
      'started',
      'progress',
      'exited',
    ]);
    const exited = jobs.at(-1) as { exitCode?: number | null; jobId: string; kind: string };
    expect(exited.jobId).toBe('t1');
    expect(exited.kind).toBe('task');
    expect(exited.exitCode).toBe(0);
  });

  it('never repeats the same progress text', () => {
    const h = harness();
    const withProgress = snapshot({ progress: { text: '47%', kind: 'percent' } });
    h.procs({ type: 'output', service: withProgress });
    h.procs({ type: 'output', service: withProgress });
    h.procs({ type: 'output', service: withProgress });
    expect(h.events.filter((event) => event.type === 'job')).toHaveLength(1);
  });

  it('announces a stall once per silent stretch', () => {
    const h = harness();
    const stalled = snapshot({ stalled: true });
    h.procs({ type: 'output', service: stalled });
    h.procs({ type: 'output', service: stalled });
    const subtypes = h.events
      .filter((event) => event.type === 'job')
      .map((event) => (event as { subtype: string }).subtype);
    expect(subtypes).toEqual(['stalled']);
  });

  it('AC-31: attaching once subscribes once, however many runs happen (RV-P1-6)', () => {
    const h = harness();
    // `attach()` is called once by the CLI; the follow-through chain then enters
    // `run()` repeatedly. Moving the subscription into `run()` would multiply
    // this number.
    expect(h.procSubscriptions).toBe(1);
    expect(h.procUnsubscribes).toBe(0);
    h.runner.detach();
    expect(h.procUnsubscribes).toBe(1);
  });

  it('a controller without a supervisor emits nothing and does not throw', () => {
    const events: ExecEvent[] = [];
    const runner = new ExecRunner({
      emitter: {
        init: () => {},
        emit: (event: ExecEvent) => events.push(event),
        result: () => {},
      } as never,
      sessionId: 's1',
      quiet: true,
    } as never);
    expect(() =>
      runner.attach({
        subscribe: () => () => {},
        abort: () => {},
      } as never),
    ).not.toThrow();
    runner.detach();
    expect(events.filter((event) => event.type === 'job')).toEqual([]);
  });
});
