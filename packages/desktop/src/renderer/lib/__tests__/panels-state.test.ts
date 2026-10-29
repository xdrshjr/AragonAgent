import { describe, expect, it } from 'vitest';
import { initialViewState, viewReducer, type ViewAction, type ViewState } from '@aragon-agent/tui/model/agent/reducer';
import type { FilePatch } from '@aragon-agent/tui/model/tools/patch';
import type { ServiceSnapshot } from '@aragon-agent/tui/model/proc/types';
import { aggregateChanges } from '../panels-changes.js';
import { isJobLive, latestJobs } from '../panels-jobs.js';

const run = (actions: ViewAction[]): ViewState => actions.reduce(viewReducer, initialViewState());

export function patchOf(path: string, kind: 'create' | 'update', added: number, removed: number): FilePatch {
  return {
    path, kind, added, removed, truncated: false, lineCount: added + removed,
    hunks: [{ oldStart: 1, oldCount: removed, newStart: 1, newCount: added, lines: [{ kind: 'add', newLine: 1, text: 'x' }] }],
  };
}

function editCall(id: string, name: string, args: Record<string, unknown>, patch?: FilePatch): ViewAction[] {
  return [
    { type: 'toolCallStart', toolCallId: id, toolName: name },
    { type: 'toolCallEnd', toolCallId: id, args },
    { type: 'toolExecStart', toolCallId: id, toolName: name },
    { type: 'toolExecEnd', toolCallId: id, isError: false, duration: 5, preview: 'ok', ...(patch ? { patch } : {}) },
  ];
}

describe('aggregateChanges', () => {
  it('lists each file once, newest call first-class, with summed counts', () => {
    const state = run([
      ...editCall('t1', 'write', { path: 'a.ts' }, patchOf('a.ts', 'create', 10, 0)),
      ...editCall('t2', 'edit', { path: 'a.ts' }, patchOf('a.ts', 'update', 2, 1)),
      ...editCall('t3', 'edit', { path: 'b.ts' }, patchOf('b.ts', 'update', 4, 4)),
    ]);
    const files = aggregateChanges(state.entries);
    expect(files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    // A file this session created stays "added" however often it is edited afterwards.
    expect(files[0]).toMatchObject({ status: 'A', added: 12, removed: 1, edits: 2, toolCallId: 't2' });
    expect(files[1]).toMatchObject({ status: 'M', added: 4, removed: 4, edits: 1 });
  });

  it('skips failed calls and tools that are not file writes', () => {
    const state = run([
      { type: 'toolCallStart', toolCallId: 'e1', toolName: 'edit' },
      { type: 'toolCallEnd', toolCallId: 'e1', args: { path: 'bad.ts' } },
      { type: 'toolExecStart', toolCallId: 'e1' },
      { type: 'toolExecEnd', toolCallId: 'e1', isError: true, duration: 1, preview: 'boom' },
      ...editCall('r1', 'read', { path: 'only-read.ts' }),
    ]);
    expect(aggregateChanges(state.entries)).toEqual([]);
  });

  it('still lists a write that carries no patch, so its diff can be fetched on demand', () => {
    const files = aggregateChanges(run(editCall('w1', 'write', { path: 'no-patch.ts' })).entries);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'no-patch.ts', status: 'M', toolCallId: 'w1', patch: undefined });
  });
});

function job(id: string, status: ServiceSnapshot['status'], extra: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return {
    id, kind: 'service', toolCallId: `tc-${id}`, command: `run ${id}`, cwd: '/w', pid: 1, status, startedAt: 1000,
    exitCode: null, signal: null, rows: [], rowsSeen: 0, truncated: false, lastOutputAt: 1000, ...extra,
  };
}

describe('latestJobs', () => {
  it('shows one row per job with its newest state, and the terminal marker does not hide the real entry', () => {
    const state = run([
      { type: 'serviceStart', service: job('s1', 'starting') },
      { type: 'serviceUpdate', service: job('s1', 'running', { rows: ['listening'], rowsSeen: 1 }) },
      { type: 'serviceStart', service: job('s2', 'running') },
      { type: 'serviceEnd', service: job('s2', 'exited', { exitCode: 0, endedAt: 2000 }) },
    ]);
    const jobs = latestJobs(state.entries);
    expect(jobs.map((entry) => entry.serviceId)).toEqual(['s1', 's2']);
    expect(isJobLive(jobs[0]!)).toBe(true);
    expect(isJobLive(jobs[1]!)).toBe(false);
    expect(jobs[1]!.status).toBe('exited');
  });

  it('is empty for a session with no jobs', () => {
    expect(latestJobs(run([{ type: 'notice', level: 'info', text: 'hi' }]).entries)).toEqual([]);
  });
});
