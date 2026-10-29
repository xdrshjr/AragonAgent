/**
 * Host-side units: the fail-closed approval gates (AC-2/AC-3), descendant discovery for orphan
 * cleanup (AC-20) and the bounded `@` file search.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRequest, HostResponse } from '../../shared/port-protocol.js';
import { ignoreGlobsFrom, scorePath, searchFiles } from '../file-search.js';
import { Gates } from '../gates.js';
import { Heartbeat, collectDescendants, parsePsOutput, parseWindowsProcessJson } from '../heartbeat.js';

function makeGates(attached = true) {
  const sent: { id: string; req: HostRequest }[] = [];
  const denied: string[] = [];
  const pending: number[] = [];
  const gates = new Gates({
    send: (id, req) => { sent.push({ id, req }); return true; },
    onPendingChange: (count) => pending.push(count),
    onDenied: (reason) => denied.push(reason),
  });
  gates.setAttached(attached);
  return { gates, sent, denied, pending };
}

const questions = [{
  id: 'q1', header: 'Pick', question: 'Which database?',
  options: [
    { label: 'Postgres', description: '', recommended: true, isOther: false },
    { label: 'Other', description: '', recommended: false, isOther: true },
  ],
  allowMultiple: false,
}];

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Gates: tool confirmation', () => {
  it('allows only on an explicit allow', async () => {
    const { gates, sent } = makeGates();
    const decision = gates.confirmTool({ tool: 'bash', summary: 'rm -rf build' });
    gates.answer(sent[0]!.id, { k: 'tool-approval', decision: 'allow' });
    await expect(decision).resolves.toBe(true);
  });

  it('denies on deny, on a mismatched answer kind, and on the tool abort signal', async () => {
    const first = makeGates();
    const denied = first.gates.confirmTool({ tool: 'bash', summary: 'x' });
    first.gates.answer(first.sent[0]!.id, { k: 'tool-approval', decision: 'deny', reason: 'too risky' });
    await expect(denied).resolves.toBe(false);
    expect(first.gates.lastDenyReason).toBe('too risky');

    const second = makeGates();
    const wrongKind = second.gates.confirmTool({ tool: 'bash', summary: 'x' });
    second.gates.answer(second.sent[0]!.id, { k: 'skill-install', approved: true });
    await expect(wrongKind).resolves.toBe(false);

    const third = makeGates();
    const controller = new AbortController();
    const aborted = third.gates.confirmTool({ tool: 'bash', summary: 'x', signal: controller.signal });
    controller.abort();
    await expect(aborted).resolves.toBe(false);
    expect(third.gates.pendingCount).toBe(0);
  });

  it('"always allow this session" skips later prompts for that tool only', async () => {
    const { gates, sent } = makeGates();
    const first = gates.confirmTool({ tool: 'read', summary: 'a' });
    gates.answer(sent[0]!.id, { k: 'tool-approval', decision: 'allow-session' });
    await first;
    await expect(gates.confirmTool({ tool: 'read', summary: 'b' })).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    const other = gates.confirmTool({ tool: 'bash', summary: 'c' });
    expect(sent).toHaveLength(2);
    gates.answer(sent[1]!.id, { k: 'tool-approval', decision: 'deny' });
    await other;
  });

  it('caps the denial reason at 500 characters', async () => {
    const { gates, sent } = makeGates();
    const decision = gates.confirmTool({ tool: 'bash', summary: 'x' });
    gates.answer(sent[0]!.id, { k: 'tool-approval', decision: 'deny', reason: 'r'.repeat(5000) });
    await decision;
    expect(gates.lastDenyReason).toHaveLength(500);
  });

  it('refuses after 30 s with no window attached, and says so', async () => {
    const { gates, denied } = makeGates(false);
    const decision = gates.confirmTool({ tool: 'bash', summary: 'x' });
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(decision).resolves.toBe(false);
    expect(denied[0]).toContain('30 s');
  });

  it('does not refuse when a window attaches in time, and replays the request to it', async () => {
    const { gates, sent } = makeGates(false);
    const decision = gates.confirmTool({ tool: 'bash', summary: 'x' });
    await vi.advanceTimersByTimeAsync(20_000);
    gates.setAttached(true);
    gates.replayPending();
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20_000);
    gates.answer(sent[0]!.id, { k: 'tool-approval', decision: 'allow' });
    await expect(decision).resolves.toBe(true);
  });

  it('ignores a late answer for a request that already settled', async () => {
    const { gates, sent } = makeGates();
    const decision = gates.confirmTool({ tool: 'bash', summary: 'x' });
    gates.cancelAll('run ended');
    await expect(decision).resolves.toBe(false);
    expect(() => gates.answer(sent[0]!.id, { k: 'tool-approval', decision: 'allow' })).not.toThrow();
  });
});

describe('Gates: questions and plan review', () => {
  it('rebuilds answers from the host\'s own questions and drops what it never asked', async () => {
    const { gates, sent } = makeGates();
    const result = gates.humanInput({ kind: 'questions', questions });
    const reply: HostResponse = {
      k: 'ask-user', cancelled: false,
      answers: [
        { id: 'q1', selected: ['Other', 'Not an option'], custom: 'x'.repeat(5000) },
        { id: 'invented', selected: ['Postgres'], custom: null },
      ],
    };
    gates.answer(sent[0]!.id, reply);
    const response = await result;
    expect(response).toMatchObject({ kind: 'answers', cancelled: false });
    const answers = (response as { answers: { id: string; question: string; selected: string[]; custom: string | null }[] }).answers;
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ id: 'q1', question: 'Which database?', selected: ['Other'] });
    expect(answers[0]!.custom).toHaveLength(2000);
  });

  it('takes the free text only when Other was actually chosen', async () => {
    const { gates, sent } = makeGates();
    const result = gates.humanInput({ kind: 'questions', questions });
    gates.answer(sent[0]!.id, { k: 'ask-user', cancelled: false, answers: [{ id: 'q1', selected: ['Postgres'], custom: 'sneaky' }] });
    const response = await result as { answers: { custom: string | null }[] };
    expect(response.answers[0]!.custom).toBeNull();
  });

  it('a cancelled wizard answers cancelled, and plan feedback is capped', async () => {
    const { gates, sent } = makeGates();
    const cancelled = gates.humanInput({ kind: 'questions', questions });
    gates.answer(sent[0]!.id, { k: 'ask-user', cancelled: true, answers: [] });
    await expect(cancelled).resolves.toEqual({ kind: 'answers', answers: [], cancelled: true });

    const plan = gates.humanInput({ kind: 'plan', plan: { title: 't', summary: 's', steps: [], filesTouched: [], risks: [], openQuestions: [] } });
    gates.answer(sent[1]!.id, { k: 'plan-review', decision: 'revise', feedback: 'f'.repeat(9000) });
    const decision = await plan as { decision: string; feedback: string };
    expect(decision.decision).toBe('revise');
    expect(decision.feedback).toHaveLength(2000);
  });

  it('an invalid plan decision is treated as no decision', async () => {
    const { gates, sent } = makeGates();
    const plan = gates.humanInput({ kind: 'plan', plan: { title: 't', summary: 's', steps: [], filesTouched: [], risks: [], openQuestions: [] } });
    gates.answer(sent[0]!.id, { k: 'plan-review', decision: 'run-everything' as never, feedback: '' });
    await expect(plan).resolves.toBeNull();
  });
});

describe('descendant discovery', () => {
  const rows = [
    { pid: 1, ppid: 0, startedAt: 1 }, { pid: 10, ppid: 1, startedAt: 2 }, { pid: 11, ppid: 10, startedAt: 3 },
    { pid: 12, ppid: 11, startedAt: 4 }, { pid: 20, ppid: 1, startedAt: 5 }, { pid: 99, ppid: 98, startedAt: 6 },
  ];

  it('collects the whole subtree under a root and nothing else', () => {
    expect(collectDescendants(rows, 10).map((d) => d.pid).sort()).toEqual([11, 12]);
    expect(collectDescendants(rows, 1).map((d) => d.pid).sort((a, b) => a - b)).toEqual([10, 11, 12, 20]);
    expect(collectDescendants(rows, 12)).toEqual([]);
  });

  it('survives a cycle in the parent links', () => {
    expect(collectDescendants([{ pid: 2, ppid: 3, startedAt: 1 }, { pid: 3, ppid: 2, startedAt: 1 }], 2).length).toBeLessThanOrEqual(2);
  });

  it('parses `ps` and PowerShell output, skipping rows it cannot read', () => {
    const ps = parsePsOutput('  100     1 Mon Oct 27 10:00:00 2026\n  garbage line\n  200   100 Mon Oct 27 10:00:05 2026\n');
    expect(ps.map((row) => [row.pid, row.ppid])).toEqual([[100, 1], [200, 100]]);
    const win = parseWindowsProcessJson(JSON.stringify([{ ProcessId: 5, ParentProcessId: 4, Created: '2026-10-27T10:00:00.000Z' }, { ProcessId: 'x' }]));
    expect(win).toEqual([{ pid: 5, ppid: 4, startedAt: Date.parse('2026-10-27T10:00:00.000Z') }]);
    expect(parseWindowsProcessJson('not json')).toEqual([]);
    expect(parseWindowsProcessJson(JSON.stringify({ ProcessId: 5, ParentProcessId: 4, Created: '2026-10-27T10:00:00.000Z' }))).toHaveLength(1);
  });
});

describe('Heartbeat', () => {
  it('answers with an empty list for free while there is nothing to find', async () => {
    const sent: unknown[] = [];
    const list = vi.fn(async () => []);
    const beat = new Heartbeat({ hasWork: () => false, send: (m) => sent.push(m), list });
    beat.pong();
    expect(sent).toEqual([{ v: 1, kind: 'pong', descendants: [] }]);
    expect(list).not.toHaveBeenCalled();
  });

  it('reports the descendants from the PREVIOUS refresh immediately and refreshes in the background', async () => {
    const sent: { descendants: unknown[] }[] = [];
    const list = vi.fn(async () => [{ pid: 7, ppid: 1, startedAt: 11 }]);
    const beat = new Heartbeat({ hasWork: () => true, send: (m) => sent.push(m as never), rootPid: 1, platform: 'linux', list });
    beat.pong();
    expect(sent[0]!.descendants).toEqual([]); // nothing cached yet; never blocks the pong
    await vi.advanceTimersByTimeAsync(0);
    beat.pong();
    expect(sent[1]!.descendants).toEqual([{ pid: 7, startedAt: 11 }]);
  });
});

describe('file search', () => {
  let dir: string;
  beforeEach(() => {
    vi.useRealTimers();
    dir = mkdtempSync(join(os.tmpdir(), 'aragon-search-'));
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'src', 'session-host.ts'), '');
    writeFileSync(join(dir, 'src', 'deep', 'host.ts'), '');
    writeFileSync(join(dir, 'README.md'), '');
    writeFileSync(join(dir, 'node_modules', 'pkg', 'session-host.js'), '');
    writeFileSync(join(dir, '.gitignore'), 'secret.txt\n/build\n# comment\n!keep.txt\n');
    writeFileSync(join(dir, 'secret.txt'), '');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('ranks tight file-name matches first and skips node_modules and ignored files', async () => {
    const result = await searchFiles(dir, 'host');
    expect(result.paths[0]).toBe('src/deep/host.ts');
    expect(result.paths).toContain('src/session-host.ts');
    expect(result.paths.some((path) => path.includes('node_modules'))).toBe(false);
    expect((await searchFiles(dir, 'secret')).paths).toEqual([]);
  });

  it('treats the query as characters, never a pattern', async () => {
    expect((await searchFiles(dir, '.*')).paths).toEqual([]);
    expect((await searchFiles(dir, '[')).paths).toEqual([]);
  });

  it('scores subsequence matches and rejects non-matches', () => {
    expect(scorePath('src/session-host.ts', 'sh')).not.toBeNull();
    expect(scorePath('src/session-host.ts', 'zz')).toBeNull();
    expect(scorePath('a/host.ts', 'host')!).toBeGreaterThan(scorePath('a/h/o/s/t.ts', 'host')!);
  });

  it('turns the root .gitignore into glob ignores (names, rooted paths; negations skipped)', () => {
    expect(ignoreGlobsFrom('node_modules\n/build\n# c\n!keep\n\ndist/\n')).toEqual([
      '**/node_modules', '**/node_modules/**', 'build', 'build/**', '**/dist', '**/dist/**',
    ]);
  });
});
