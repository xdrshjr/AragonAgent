/**
 * `job_wait` / `job_list` — schema, clamping, output grammar, unknown ids, and
 * the notice tail (long-task-jobs AC-14 / AC-15 / AC-18 / AC-20 / AC-21).
 */

import { describe, expect, it, vi } from 'vitest';
import type { ToolResult } from '@aragon-agent/core';
import { makeJobList, makeJobWait, withJobNoticeTail, type JobToolDeps } from '../tools/job-tools.js';
import { PROC_LIMITS } from '../proc/limits.js';
import { JobNoticeQueue, type JobNotice } from '../proc/notices.js';
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
    startedAt: Date.now() - 12 * 60_000,
    exitCode: null,
    signal: null,
    rows: [],
    rowsSeen: 900,
    truncated: false,
    lastOutputAt: Date.now() - 12_000,
    ...over,
  };
}

interface Harness {
  deps: JobToolDeps;
  emit(event: ProcEvent): void;
  set(job: ServiceSnapshot): void;
  waits: number[];
  /** The not-yet-terminated line the stubbed `read()` reports, if any. */
  carry: string;
}

function harness(jobs: ServiceSnapshot[], over: Partial<JobToolDeps> = {}): Harness {
  const map = new Map(jobs.map((job) => [job.id, job]));
  const listeners = new Set<(event: ProcEvent) => void>();
  const h: Harness = {
    waits: [],
    carry: '',
    emit: (event) => {
      map.set(event.service.id, event.service);
      for (const listener of [...listeners]) listener(event);
    },
    set: (job) => map.set(job.id, job),
    deps: {
      supervisor: {
        get: (id) => map.get(id),
        list: () => [...map.values()],
        read: (id) => {
          const job = map.get(id);
          if (!job) return undefined;
          // THE CARRY RIDES THE PAGE, exactly as `LogRing.page()` reports it: the
          // not-yet-terminated line is the last element of `rows` AND is named by
          // `carryRow` (RV-P1-5).
          const rows = h.carry.length > 0 ? [...job.rows, h.carry] : job.rows;
          return { rows, cursor: job.rowsSeen, truncated: job.truncated, carryRow: h.carry };
        },
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        start: async () => ({ ok: false }),
        stop: async () => [],
        trackForeground: () => () => {},
        killForeground: () => 0,
        liveCount: () => 0,
        reapSync: () => {},
        dispose: () => {},
      },
      waitSeconds: () => 30,
      stallSeconds: () => 300,
      toolTimeoutMs: () => 180_000,
      maxConsecutiveWaits: PROC_LIMITS.maxConsecutiveWaits,
      ...over,
    },
  };
  return h;
}

function text(result: ToolResult): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

const ctx = { signal: undefined } as never;

describe('job_wait: the bounded wait', () => {
  it('AC-14: an out-of-range timeout falls back to the configured default', async () => {
    const h = harness([snapshot({ status: 'exited', exitCode: 0 })]);
    const tool = makeJobWait(h.deps);
    const result = await tool.execute('1', { job: 't1', timeoutSeconds: 1 }, ctx);
    expect(text(result)).toContain('JOB t1  task  exited code 0');
  });

  it('AC-14: the tool ceiling converges the wait (I-4)', async () => {
    // 40s ceiling - 30s margin => 10s. A `timeoutSeconds: 60` must NOT produce a
    // 60s wait, or the tool hosting it would time out first. The `[wait Ns]` line
    // is the observable: it prints the CLAMPED value, so advancing the clock past
    // both candidates settles which one the tool actually used - with no hang if
    // the clamp is wrong, because 60s is advanced too.
    vi.useFakeTimers();
    try {
      const h = harness([snapshot()], { toolTimeoutMs: () => 40_000 });
      const pending = makeJobWait(h.deps).execute('1', { job: 't1', timeoutSeconds: 60 }, ctx);
      await vi.advanceTimersByTimeAsync(60_000);
      const body = text(await pending);
      expect(body).toContain('[wait 10s]');
      expect(body).not.toContain('[wait 60s]');
      expect(body).toContain('still running');
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC-18: at most twelve lines, at most six output rows', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => `row ${i}`);
    const h = harness([snapshot({ rows, rowsSeen: 200 })]);
    const tool = makeJobWait(h.deps);
    const pending = tool.execute('1', { job: 't1', since: 1 }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.emit({ type: 'exited', service: snapshot({ status: 'exited', exitCode: 0, rows, rowsSeen: 200 }) });
    const body = text(await pending);
    const lines = body.split('\n');
    expect(lines.length).toBeLessThanOrEqual(12);
    const rowsShown = lines.filter((line) => line.startsWith('  row ')).length;
    expect(rowsShown).toBeLessThanOrEqual(PROC_LIMITS.waitTailRows);
  });

  it('AC-15: an unknown id names the live ones', async () => {
    const h = harness([snapshot({ id: 't1' }), snapshot({ id: 's2', kind: 'service', status: 'ready' })]);
    const tool = makeJobWait(h.deps);
    const result = await tool.execute('1', { job: 't9' }, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No job "t9"');
    expect(text(result)).toContain('Live:');
  });

  it('AC-15b: with nothing live it says how to start one', async () => {
    const h = harness([]);
    const tool = makeJobWait(h.deps);
    const result = await tool.execute('1', { job: 't9' }, ctx);
    expect(text(result)).toContain('bash({ command, background: true })');
  });

  it('a reclaimed id is reported as finished, not as never having existed (RV-P2-7)', async () => {
    const h = harness([], { terminalRecord: () => ({ kind: 'task', status: 'exited' }) });
    const tool = makeJobWait(h.deps);
    const result = await tool.execute('1', { job: 't9' }, ctx);
    expect(text(result)).toContain('already finished');
    expect(text(result)).toContain('Do not re-run it');
  });

  it('the reclaimed answer WINS over the live-id list (RV-P2-7)', async () => {
    // The expensive mistake is telling a model `No job "t9"` about a training run
    // that FINISHED - it starts it again. That answer must not depend on whether
    // some unrelated job happens to be live at the time.
    const h = harness([snapshot({ id: 't1' })], {
      terminalRecord: (id) => (id === 't9' ? { kind: 'task', status: 'exited' } : undefined),
    });
    const body = text(await makeJobWait(h.deps).execute('1', { job: 't9' }, ctx));
    expect(body).toContain('already finished');
    expect(body).not.toContain('Live:');
  });

  it('AC-19: an unchanged progress line is reported as unchanged', async () => {
    const job = snapshot({
      progress: { text: '47%', kind: 'percent' },
      status: 'exited',
      exitCode: 0,
    });
    const h = harness([job]);
    const tool = makeJobWait(h.deps);
    await tool.execute('1', { job: 't1' }, ctx);
    const second = await tool.execute('2', { job: 't1' }, ctx);
    expect(text(second)).toContain('[progress] 47% (unchanged)');
  });

  it('AC-18b: an unchanged carry row is not reprinted and does not reset the guard (RV-P1-5)', async () => {
    // The realistic shape: a download that only ever redraws ONE line with `\r`, so
    // it completes no rows at all. Every wait hands that same line back from the
    // ring; reprinting it would spend the six-row budget on one sentence, and
    // counting it as "new output" would reset the spin guard forever.
    const bar = 'Downloading 47%|#####     | 4.7M/10M';
    const h = harness(
      [snapshot({ status: 'exited', exitCode: 0, progress: { text: '47%', kind: 'percent' } })],
      { maxConsecutiveWaits: 2 },
    );
    h.carry = bar;
    const tool = makeJobWait(h.deps);
    const first = text(await tool.execute('1', { job: 't1' }, ctx));
    expect(first).toContain(bar);
    const second = text(await tool.execute('2', { job: 't1' }, ctx));
    expect(second).not.toContain(bar);
    expect(second).toContain('[progress] 47% (unchanged)');
    // Two no-change waits after the baseline => the guard leads the third result.
    const third = text(await tool.execute('3', { job: 't1' }, ctx));
    expect(third.split('\n')[0]).toContain('[guard]');
  });

  it('AC-18c: a carry row that MOVED is printed and spends one row (RV-P1-5)', async () => {
    const h = harness([snapshot({ status: 'exited', exitCode: 0 })]);
    const tool = makeJobWait(h.deps);
    h.carry = 'Downloading 10%';
    await tool.execute('1', { job: 't1' }, ctx);
    h.carry = 'Downloading 20%';
    const body = text(await tool.execute('2', { job: 't1' }, ctx));
    expect(body).toContain('Downloading 20%');
  });

  it('AC-20: after enough no-change waits the guard line leads the result', async () => {
    // FAKE TIMERS, because the property under test is a COUNTER and not a clock:
    // three real five-second waits would add fifteen seconds to every run of this
    // suite for a number that has nothing to do with elapsed time.
    vi.useFakeTimers();
    try {
      const job = snapshot({ progress: { text: '47%', kind: 'percent' } });
      const h = harness([job], { maxConsecutiveWaits: 2 });
      const tool = makeJobWait(h.deps);
      const bodies: string[] = [];
      for (const id of ['1', '2', '3']) {
        const pending = tool.execute(id, { job: 't1', timeoutSeconds: 5 }, ctx);
        await vi.advanceTimersByTimeAsync(5_000);
        bodies.push(text(await pending));
      }
      // The baseline wait is not a "no change", so the guard appears on the third.
      expect(bodies[0]?.split('\n')[0]).not.toContain('[guard]');
      expect(bodies[1]?.split('\n')[0]).not.toContain('[guard]');
      expect(bodies[2]?.split('\n')[0]).toContain('[guard]');
    } finally {
      vi.useRealTimers();
    }
  });

  it('`all` with nothing live explains rather than hanging', async () => {
    const h = harness([snapshot({ status: 'exited', exitCode: 0 })]);
    const tool = makeJobWait(h.deps);
    const result = await tool.execute('1', { job: 'all' }, ctx);
    expect(text(result)).toContain('No background jobs are running');
  });

  it('a stalled job gets the three options and no action', async () => {
    const h = harness([snapshot({ status: 'exited', exitCode: 0, stalled: true })]);
    const tool = makeJobWait(h.deps);
    const result = await tool.execute('1', { job: 't1' }, ctx);
    // A finished job is not stalled: `stalled` is derived only for a live one, so
    // the supervisor never sets it here - this asserts the tool does not invent it.
    expect(text(result)).not.toContain('[stalled]');
  });
});

describe('job_list', () => {
  it('says how to start one when there are none', async () => {
    const h = harness([]);
    const result = await makeJobList(h.deps).execute('1', {}, ctx);
    expect(text(result)).toContain('No background jobs.');
  });

  it('one line per job, live first, with a summary', async () => {
    const h = harness([
      snapshot({ id: 't1', status: 'exited', exitCode: 0 }),
      snapshot({ id: 't2', progress: { text: '47%', kind: 'percent' } }),
    ]);
    const body = text(await makeJobList(h.deps).execute('1', {}, ctx));
    const lines = body.split('\n');
    expect(lines[0]).toContain('t2  task  running');
    expect(lines[0]).toContain('47%');
    expect(body).toContain('1 live of 2');
  });
});

describe('withJobNoticeTail (AC-21 / AC-22)', () => {
  const tool = {
    name: 'read_file',
    label: 'read',
    description: 'read',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text' as const, text: 'body' }] }),
  };

  it('appends the block on success', async () => {
    const queue = new JobNoticeQueue();
    queue.push({
      id: 't1',
      kind: 'task',
      status: 'exited',
      exitCode: 0,
      signal: null,
      elapsedMs: 1000,
      at: 1,
      tailRows: [],
    } satisfies JobNotice);
    const wrapped = withJobNoticeTail(tool, () => queue.drain());
    const result = await wrapped.execute('1', {}, ctx);
    expect(text(result)).toContain('body');
    expect(text(result)).toContain('<job_notices>');
  });

  it('delivers on an ERROR result too — a refused call is still a delivery', async () => {
    const queue = new JobNoticeQueue();
    queue.push({
      id: 't1',
      kind: 'task',
      status: 'failed',
      exitCode: 1,
      signal: null,
      elapsedMs: 1000,
      at: 1,
      tailRows: [],
    } satisfies JobNotice);
    const failing = {
      ...tool,
      execute: async () => ({ content: [{ type: 'text' as const, text: 'boom' }], isError: true }),
    };
    const result = await withJobNoticeTail(failing, () => queue.drain()).execute('1', {}, ctx);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('<job_notices>');
  });

  it('AC-22: a delivered notice never appears twice', async () => {
    const queue = new JobNoticeQueue();
    queue.push({
      id: 't1',
      kind: 'task',
      status: 'exited',
      exitCode: 0,
      signal: null,
      elapsedMs: 1000,
      at: 1,
      tailRows: [],
    } satisfies JobNotice);
    const wrapped = withJobNoticeTail(tool, () => queue.drain());
    expect(text(await wrapped.execute('1', {}, ctx))).toContain('<job_notices>');
    expect(text(await wrapped.execute('2', {}, ctx))).not.toContain('<job_notices>');
  });

  it('leaves the result untouched when there is nothing to deliver', async () => {
    const queue = new JobNoticeQueue();
    const result = await withJobNoticeTail(tool, () => queue.drain()).execute('1', {}, ctx);
    expect(text(result)).toBe('body');
  });
});
