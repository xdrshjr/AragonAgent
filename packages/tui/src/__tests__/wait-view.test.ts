/** `buildWaitView`, the pure projection behind the wait card (extended-job-wait §3.8.1). */

import { describe, expect, it } from 'vitest';
import { buildWaitView, type BuildWaitViewInput } from '../model/proc/wait-view.js';
import type { ServiceSnapshot } from '../model/proc/types.js';

function job(over: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    id: 't3',
    kind: 'task',
    toolCallId: 'c1',
    command: 'python train.py --epochs 10',
    cwd: '/tmp',
    pid: 1,
    status: 'running',
    startedAt: 1_000,
    exitCode: null,
    signal: null,
    rows: ['step 911/1000', 'step 912/1000  loss 0.4098'],
    rowsSeen: 912,
    truncated: false,
    lastOutputAt: 50_000,
    progress: { text: '47%  epoch 3/10  ETA 13m', kind: 'percent', fraction: 0.47 },
    ...over,
  };
}

function input(snapshots: ServiceSnapshot[], over: Partial<BuildWaitViewInput> = {}): BuildWaitViewInput {
  return {
    toolCallId: 'call-1',
    snapshots,
    mode: 'all',
    waitStartedAt: 10_000,
    upToMs: 600_000,
    nowMs: 60_000,
    stallSeconds: 300,
    ...over,
  };
}

describe('buildWaitView', () => {
  it('returns undefined when no target remains, instead of an empty view', () => {
    expect(buildWaitView(input([]))).toBeUndefined();
  });

  it('projects a single job with its command, progress and newest row', () => {
    const view = buildWaitView(input([job()]))!;
    expect(view).toMatchObject({
      toolCallId: 'call-1',
      jobLabel: 't3',
      command: 'python train.py --epochs 10',
      waitStartedAt: 10_000,
      upToMs: 600_000,
      beatAt: 60_000,
      mode: 'all',
      liveJobs: 1,
      jobStartedAt: 1_000,
      status: 'running',
      lastRow: 'step 912/1000  loss 0.4098',
      lastOutputAt: 50_000,
      stalled: false,
    });
    expect(view.progress).toEqual({ text: '47%  epoch 3/10  ETA 13m', kind: 'percent', fraction: 0.47 });
  });

  it('omits progress and lastRow rather than inventing them', () => {
    const view = buildWaitView(input([job({ progress: undefined, rows: ['', '  '] })]))!;
    expect(view.progress).toBeUndefined();
    expect(view.lastRow).toBeUndefined();
  });

  it('strips control characters and clips the row and the command', () => {
    const view = buildWaitView(
      input([job({ rows: [`a\u001b[31mb${'x'.repeat(400)}`], command: 'c'.repeat(300) })]),
    )!;
    expect(view.lastRow).not.toMatch(/\u001b/);
    expect(view.lastRow!.length).toBeLessThanOrEqual(200);
    expect(view.command.length).toBeLessThanOrEqual(80);
    expect(view.command.endsWith('...')).toBe(true);
  });

  it('summarises several jobs without a command or a single progress', () => {
    const view = buildWaitView(
      input([job(), job({ id: 't4', startedAt: 500, lastOutputAt: 59_000, rows: ['newer'] })], {
        mode: 'any',
      }),
    )!;
    expect(view).toMatchObject({
      jobLabel: '2 jobs',
      command: '',
      mode: 'any',
      liveJobs: 2,
      jobStartedAt: 500,
      status: 'running',
      lastRow: 'newer',
      lastOutputAt: 59_000,
    });
    expect(view.progress).toBeUndefined();
  });

  it('flags silence past the threshold, for live jobs only', () => {
    const quiet = input([job({ lastOutputAt: 1_000 })], { nowMs: 400_000 });
    expect(buildWaitView(quiet)!.stalled).toBe(true);
    const ended = input([job({ lastOutputAt: 1_000, status: 'exited', exitCode: 0 })], {
      nowMs: 400_000,
    });
    expect(buildWaitView(ended)!.stalled).toBe(false);
  });
});
