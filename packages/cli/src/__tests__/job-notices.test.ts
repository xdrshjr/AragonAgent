/**
 * `JobNoticeQueue`, `renderJobNotices` and the relay's ledger
 * (long-task-jobs AC-21 / AC-22 / AC-36 / I-6 / I-11).
 *
 * THE LEDGER TESTS ARE THE POINT OF THIS FILE. `fast/reviewer.ts` can wipe the
 * steering queue on the premise that `AgentController.steer()` is the only other
 * writer; a steered notice is invisible to that premise. These assertions prove
 * the wipe costs a DELAY and not a fact.
 */

import { describe, expect, it, vi } from 'vitest';
import { JobNoticeQueue, renderJobNotices, type JobNotice } from '../proc/notices.js';
import { JobNoticeRelay } from '../agent/job-notices.js';
import { PROC_LIMITS } from '../proc/limits.js';
import type { ProcEvent, ServiceSnapshot } from '../proc/types.js';

function notice(over: Partial<JobNotice> = {}): JobNotice {
  return {
    id: 't1',
    kind: 'task',
    status: 'exited',
    exitCode: 0,
    signal: null,
    elapsedMs: 41 * 60_000 + 12_000,
    at: 1000,
    tailRows: [],
    ...over,
  };
}

function snapshot(over: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    id: 't1',
    kind: 'task',
    toolCallId: 'c1',
    command: 'python train.py',
    cwd: '/tmp',
    pid: 11,
    status: 'exited',
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    exitCode: 0,
    signal: null,
    rows: ['epoch 9 done', 'epoch 10 done'],
    rowsSeen: 10,
    truncated: false,
    lastOutputAt: Date.now(),
    ...over,
  };
}

describe('JobNoticeQueue', () => {
  it('drains once: the second drain is empty (I-6)', () => {
    const queue = new JobNoticeQueue();
    queue.push(notice());
    expect(queue.drain()).toHaveLength(1);
    expect(queue.drain()).toHaveLength(0);
    expect(queue.pending()).toBe(0);
  });

  it('is idempotent by id, which is what makes a re-queue safe (I-11)', () => {
    const queue = new JobNoticeQueue();
    queue.push(notice());
    queue.push(notice({ at: 2000 }));
    expect(queue.pending()).toBe(1);
  });

  it('is bounded: the oldest notice is dropped first', () => {
    const queue = new JobNoticeQueue();
    for (let i = 0; i < PROC_LIMITS.maxNotices + 2; i += 1) {
      queue.push(notice({ id: `t${i}`, at: i }));
    }
    const drained = queue.drain();
    expect(drained).toHaveLength(PROC_LIMITS.maxNotices);
    expect(drained[0]?.id).toBe('t2');
  });
});

describe('renderJobNotices', () => {
  it('renders nothing for an empty list, so no tool result gains two lines', () => {
    expect(renderJobNotices([])).toBe('');
  });

  it('renders the documented block', () => {
    const text = renderJobNotices([notice({ progressText: '47%' })]);
    expect(text).toContain('<job_notices>');
    expect(text).toContain('task t1 exited code 0 after 41m12s (47% at last check)');
    expect(text.trimEnd().endsWith('</job_notices>')).toBe(true);
  });

  it('puts failures first, with at most two tail rows', () => {
    const text = renderJobNotices([
      notice({ id: 't3' }),
      notice({
        id: 't7',
        status: 'failed',
        exitCode: 1,
        elapsedMs: 122_000,
        tailRows: ["ModuleNotFoundError: No module named 'torch'", 'line two', 'line three'],
      }),
    ]);
    const lines = text.split('\n');
    expect(lines[1]).toContain('t7');
    expect(lines[2]).toContain('ModuleNotFoundError');
    expect(lines[3]).toContain('line two');
    // The third row is over the bound.
    expect(text).not.toContain('line three');
  });

  it('gives a successful job no tail rows at all', () => {
    const text = renderJobNotices([notice({ tailRows: ['noise one', 'noise two'] })]);
    expect(text).not.toContain('noise one');
  });
});

describe('JobNoticeRelay (the ledger, AC-36)', () => {
  function makeRelay(over: { steerEnabled?: boolean; safe?: boolean; canFlush?: boolean } = {}) {
    const queue = new JobNoticeQueue();
    const steered: string[] = [];
    const relay = new JobNoticeRelay({
      queue,
      steer: (text) => steered.push(text),
      isAtSafeSteerPoint: () => over.safe !== false,
      canSteerBeforeTurn: () => over.canFlush !== false,
      steerEnabled: () => over.steerEnabled !== false,
    });
    const listeners: Array<(event: ProcEvent) => void> = [];
    relay.attach((listener) => {
      listeners.push(listener);
      return () => {};
    });
    return {
      relay,
      queue,
      steered,
      emit: (event: ProcEvent) => listeners.forEach((listener) => listener(event)),
    };
  }

  it('queues a terminal event and pushes it at the safe point', () => {
    const h = makeRelay();
    h.emit({ type: 'exited', service: snapshot() });
    expect(h.queue.pending()).toBe(1);
    expect(h.relay.tryPush()).toBe(true);
    expect(h.steered).toHaveLength(1);
    expect(h.steered[0]).toContain('<job_notices>');
  });

  it('never pushes while a tool batch is open (I-5)', () => {
    const h = makeRelay({ safe: false });
    h.emit({ type: 'exited', service: snapshot() });
    expect(h.relay.tryPush()).toBe(false);
    expect(h.steered).toHaveLength(0);
    expect(h.queue.pending()).toBe(1);
  });

  it('noticeSteer=false disables only the push; the queue keeps the notice', () => {
    const h = makeRelay({ steerEnabled: false });
    h.emit({ type: 'exited', service: snapshot() });
    expect(h.relay.tryPush()).toBe(false);
    expect(h.queue.pending()).toBe(1);
    // The pull channel still sees it.
    expect(h.relay.drainForTail()).toHaveLength(1);
  });

  it('AC-25: the FILL channel delivers when the engine is NOT running (RV-P1-7)', () => {
    // The whole reason `flushForTurn` exists. `flushPendingNotices()` runs just
    // before `agent.prompt()`, and `isRunning()` is false there by contract, so
    // reusing the push predicate would leave every stranded notice waiting for a
    // tool batch instead of going out with the user's own message.
    const h = makeRelay({ safe: false });
    h.emit({ type: 'exited', service: snapshot() });
    expect(h.queue.pending()).toBe(1);
    expect(h.relay.flushForTurn()).toBe(true);
    expect(h.steered).toHaveLength(1);
    expect(h.steered[0]).toContain('<job_notices>');
  });

  it('AC-25: noticeSteer=false still FILLS - it is not a notification off switch', () => {
    const h = makeRelay({ steerEnabled: false });
    h.emit({ type: 'exited', service: snapshot() });
    expect(h.relay.flushForTurn()).toBe(true);
    expect(h.steered).toHaveLength(1);
  });

  it('the FILL channel still refuses while a tool batch is open (I-5)', () => {
    const h = makeRelay({ canFlush: false });
    h.emit({ type: 'exited', service: snapshot() });
    expect(h.relay.flushForTurn()).toBe(false);
    expect(h.queue.pending()).toBe(1);
  });

  it('AC-36: a queue wipe delays the notice instead of losing it', () => {
    const h = makeRelay();
    h.emit({ type: 'exited', service: snapshot() });
    h.relay.tryPush();
    // Nothing arrived to release it — this is what `clearAllQueues()` looks like
    // from the relay's side.
    h.relay.requeueUndelivered();
    expect(h.queue.pending()).toBe(1);
    const text = renderJobNotices(h.relay.drainForTail());
    expect(text.split('task t1').length - 1).toBe(1);
  });

  it('a receipt releases the ledger, so nothing is delivered twice', () => {
    const h = makeRelay();
    h.emit({ type: 'exited', service: snapshot() });
    h.relay.tryPush();
    h.relay.onSteeringAccepted();
    h.relay.requeueUndelivered();
    expect(h.queue.pending()).toBe(0);
  });

  it('remembers terminal ids so job_wait can tell "reclaimed" from "never existed"', () => {
    const h = makeRelay();
    h.emit({ type: 'exited', service: snapshot({ status: 'failed', exitCode: 1 }) });
    expect(h.relay.terminalRecord('t1')).toEqual({ kind: 'task', status: 'failed' });
    expect(h.relay.terminalRecord('t9')).toBeUndefined();
  });

  it('ignores non-terminal events', () => {
    const h = makeRelay();
    h.emit({ type: 'output', service: snapshot({ status: 'running', endedAt: undefined }) });
    expect(h.queue.pending()).toBe(0);
  });
});

describe('renderJobNotices: bounds (I-7)', () => {
  it('stays within head + maxNotices + tail', () => {
    const many = Array.from({ length: PROC_LIMITS.maxNotices + 4 }, (_, i) =>
      notice({ id: `t${i}`, status: 'failed', exitCode: 1, tailRows: ['a', 'b'] }),
    );
    const lines = renderJobNotices(many).split('\n');
    // 2 (head/tail) + 4 lines per notice (one line + two tail rows is the cap,
    // and both tails are printed) is the worst case for one block.
    expect(lines.length).toBeLessThanOrEqual(2 + PROC_LIMITS.maxNotices * 3);
  });

  it('formats a stopped job without an exit code', () => {
    const text = renderJobNotices([notice({ status: 'stopped', exitCode: null })]);
    expect(text).toContain('task t1 stopped after');
  });
});

describe('relay with a real queue identity', () => {
  it('one notice per terminal event even when the supervisor emits twice', () => {
    const queue = new JobNoticeQueue();
    const relay = new JobNoticeRelay({
      queue,
      steer: vi.fn(),
      isAtSafeSteerPoint: () => true,
      canSteerBeforeTurn: () => true,
      steerEnabled: () => true,
    });
    const listeners: Array<(event: ProcEvent) => void> = [];
    relay.attach((listener) => {
      listeners.push(listener);
      return () => {};
    });
    const event: ProcEvent = { type: 'exited', service: snapshot() };
    listeners.forEach((listener) => listener(event));
    listeners.forEach((listener) => listener(event));
    expect(queue.pending()).toBe(1);
  });
});
