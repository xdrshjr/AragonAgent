import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initialViewState, type ViewAction } from '@aragon-agent/tui/model/agent/reducer';
import type { FilePatch } from '@aragon-agent/tui/model/tools/patch';
import type { ServiceSnapshot } from '@aragon-agent/tui/model/proc/types';
import { setLanguage } from '../../i18n/index.js';
import { installBridge, ok, removeBridge } from '../../settings/__tests__/test-bridge.js';
import { AgentsPanel } from '../AgentsPanel.js';
import { ChangesPanel } from '../ChangesPanel.js';
import { ContextPanel } from '../ContextPanel.js';
import { GovernancePanel } from '../GovernancePanel.js';
import { InspectorPanel } from '../InspectorPanel.js';
import { JobsPanel } from '../JobsPanel.js';
import { PlanPanel } from '../PlanPanel.js';
import { mountSession, run, unmountSession, type CommandHandler } from './session-fixture.js';

const ID = 's1';

beforeEach(() => { setLanguage('en'); });
afterEach(() => { cleanup(); unmountSession(ID); removeBridge(); });

function patchOf(path: string, kind: 'create' | 'update', lines: Array<['add' | 'del' | 'ctx', string]>): FilePatch {
  const added = lines.filter(([k]) => k === 'add').length;
  const removed = lines.filter(([k]) => k === 'del').length;
  return {
    path, kind, added, removed, truncated: false, lineCount: lines.length,
    hunks: [{ oldStart: 1, oldCount: removed, newStart: 1, newCount: added, lines: lines.map(([k, text], index) => ({ kind: k, newLine: index + 1, text })) }],
  };
}

function edit(id: string, name: string, path: string, patch?: FilePatch): ViewAction[] {
  return [
    { type: 'toolCallStart', toolCallId: id, toolName: name },
    { type: 'toolCallEnd', toolCallId: id, args: { path } },
    { type: 'toolExecStart', toolCallId: id, toolName: name },
    { type: 'toolExecEnd', toolCallId: id, isError: false, duration: 3, preview: 'ok', ...(patch ? { patch } : {}) },
  ];
}

describe('ChangesPanel', () => {
  it('says so when nothing has changed', () => {
    mountSession(ID, initialViewState());
    render(<InspectorPanel sessionId={ID} tab="changes" />);
    expect(screen.getByText('No file changes yet')).toBeTruthy();
  });

  it('lists edited files with an M/A status and shows the diff of the selected one', async () => {
    mountSession(ID, run([
      ...edit('t1', 'write', 'src/new.ts', patchOf('src/new.ts', 'create', [['add', 'const a = 1;'], ['add', 'export {};']])),
      ...edit('t2', 'edit', 'src/old.ts', patchOf('src/old.ts', 'update', [['ctx', 'keep'], ['del', 'gone'], ['add', 'fresh']])),
    ]));
    render(<ChangesPanel sessionId={ID} />);
    const list = await screen.findByRole('list', { name: 'Changed files' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]!.textContent).toContain('src/new.ts');
    expect(within(rows[0]!).getByLabelText('Added').textContent).toBe('A');
    expect(within(rows[1]!).getByLabelText('Modified').textContent).toBe('M');
    expect(rows[1]!.textContent).toContain('+1 −1');

    const user = userEvent.setup();
    await user.click(within(rows[1]!).getByRole('button', { name: /^Modified src\/old\.ts/ }));
    const diff = screen.getByRole('group', { name: 'src/old.ts' });
    const lines = Array.from(diff.querySelectorAll('.patch-line')).map((line) => [line.getAttribute('data-kind'), line.textContent]);
    expect(lines).toEqual([['ctx', '1 keep'], ['del', '2-gone'], ['add', '3+fresh']]);
  });

  it('fetches the diff with file-patch.get when the entry carries none', async () => {
    const handler: CommandHandler = (cmd) => (cmd.c === 'file-patch.get'
      ? { ok: true, value: patchOf('lib/a.ts', 'update', [['add', 'from the host']]) } : { ok: true });
    const session = mountSession(ID, run(edit('t9', 'edit', 'lib/a.ts')), { handler });
    render(<ChangesPanel sessionId={ID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Modified lib\/a\.ts/ }));
    expect(await screen.findByText('+from the host')).toBeTruthy();
    expect(session.commands).toEqual([{ c: 'file-patch.get', toolCallId: 't9' }]);
  });

  it('shows why when the host no longer has the diff', async () => {
    const handler: CommandHandler = () => ({ ok: false, code: 'rejected', message: 'That change is no longer available.' });
    mountSession(ID, run(edit('t9', 'edit', 'lib/a.ts')), { handler });
    render(<ChangesPanel sessionId={ID} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: /^Modified lib\/a\.ts/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('The session declined this.');
    expect(screen.getByText('The diff for this change is no longer available.')).toBeTruthy();
  });

  it('picks up a new edit streamed in after it was opened', async () => {
    const session = mountSession(ID, initialViewState());
    render(<ChangesPanel sessionId={ID} />);
    expect(screen.getByText('No file changes yet')).toBeTruthy();
    await act(async () => { session.push(...edit('t1', 'write', 'late.ts', patchOf('late.ts', 'create', [['add', 'x']]))); });
    expect(await screen.findByRole('button', { name: /^Added late\.ts/ })).toBeTruthy();
  });

  it('asks the main process to open a file', async () => {
    const bridge = installBridge({ 'native:open-path': () => ok({ opened: true }) });
    mountSession(ID, run(edit('t1', 'write', 'a.ts', patchOf('a.ts', 'create', [['add', 'x']]))));
    render(<ChangesPanel sessionId={ID} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Open a.ts' }));
    expect(bridge.calls('native:open-path')).toEqual([{ sessionId: ID, relPath: 'a.ts' }]);
  });
});

describe('PlanPanel', () => {
  const todos = run([{
    type: 'todoUpdate',
    snapshot: {
      items: [
        { content: 'Read the code', activeForm: 'Reading the code', status: 'completed' },
        { content: 'Write the fix', activeForm: 'Writing the fix', status: 'in_progress' },
        { content: 'Run the tests', activeForm: 'Running the tests', status: 'pending' },
      ],
      total: 3, doneCount: 1, activeIndex: 1, updatedAt: 1,
      acceptance: {
        items: [
          { content: 'Tests pass', check: 'npm test', status: 'passed', evidence: 'ran 12 tests' },
          { content: 'No lint errors', check: 'npm run lint', status: 'failed', evidence: '' },
        ],
        total: 2, checkedCount: 2, passedCount: 1, failedCount: 1, updatedAt: 1,
      },
    },
  }]);

  it('says so when there is no plan', () => {
    mountSession(ID, initialViewState());
    render(<PlanPanel sessionId={ID} />);
    expect(screen.getByText('No plan yet')).toBeTruthy();
  });

  it('shows todo status and acceptance verdicts as words', () => {
    mountSession(ID, todos);
    render(<PlanPanel sessionId={ID} />);
    expect(screen.getByText('1 of 3 done')).toBeTruthy();
    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items[0]).toContain('Read the code');
    expect(items[0]).toContain('done');
    // The active item reads in its progressive form.
    expect(items[1]).toContain('Writing the fix');
    expect(items[1]).toContain('in progress');
    expect(items[2]).toContain('to do');
    expect(screen.getByText('1 passed, 1 failed, 2 total')).toBeTruthy();
    expect(items.some((text) => text?.includes('Tests pass') && text.includes('passed'))).toBe(true);
    expect(items.some((text) => text?.includes('No lint errors') && text.includes('failed'))).toBe(true);
    expect(screen.getByText('Evidence')).toBeTruthy();
  });

  it('re-opens acceptance through the host and reports a refusal', async () => {
    const session = mountSession(ID, todos, { handler: () => ({ ok: false, code: 'busy', message: 'Busy.' }) });
    render(<PlanPanel sessionId={ID} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Re-open acceptance' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The session is busy.');
    expect(session.commands).toEqual([{ c: 'todo.reopen-acceptance' }]);
  });
});

describe('AgentsPanel', () => {
  const usage = { inputTokens: 1200, outputTokens: 300 };
  const team = (runs: Array<Record<string, unknown>>) => run([{
    type: 'teamUpdate',
    snapshot: {
      dispatchId: 'd1', active: true, requested: 3, startedAt: 1, messageCount: 2,
      runs: runs.map((entry) => ({ description: 'does a thing', turns: 2, toolCalls: 4, usage, filesTouched: [], messagesSent: 0, ...entry })),
    },
  } as never]);

  it('says so when no team is running', () => {
    mountSession(ID, initialViewState());
    render(<AgentsPanel sessionId={ID} />);
    expect(screen.getByText('No sub-agents')).toBeTruthy();
  });

  it('shows each sub-agent with its phase as a word, counters and failures', () => {
    mountSession(ID, team([
      { label: 'researcher', phase: 'tool', activity: 'reading the docs' },
      { label: 'writer', phase: 'done', summary: 'wrote it' },
      { label: 'tester', phase: 'failed', error: 'tests crashed', filesTouched: ['a.ts', 'b.ts'] },
    ]));
    render(<AgentsPanel sessionId={ID} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('using a tool');
    expect(rows[0]!.textContent).toContain('reading the docs');
    expect(rows[0]!.textContent).toContain('2 turns, 4 tool calls, 1.5k tokens');
    expect(rows[1]!.textContent).toContain('done');
    expect(rows[2]!.textContent).toContain('tests crashed');
    expect(rows[2]!.textContent).toContain('2 files');
    expect(screen.getByText('2 of 3 finished')).toBeTruthy();
    expect(screen.getByText('2 messages passed between agents.')).toBeTruthy();
  });
});

describe('JobsPanel', () => {
  const job = (id: string, status: ServiceSnapshot['status'], extra: Partial<ServiceSnapshot> = {}): ServiceSnapshot => ({
    id, kind: 'service', toolCallId: `tc-${id}`, command: `npm run ${id}`, cwd: '/w', pid: 1, status, startedAt: 1000,
    exitCode: null, signal: null, rows: [], rowsSeen: 0, truncated: false, lastOutputAt: 1000, ...extra,
  });
  const state = run([
    { type: 'serviceStart', service: job('dev', 'running', { url: 'http://localhost:5173' }) },
    { type: 'serviceStart', service: job('build', 'running') },
    { type: 'serviceEnd', service: job('build', 'exited', { exitCode: 0, endedAt: 4000 }) },
  ]);

  it('says so when no job exists', () => {
    mountSession(ID, initialViewState());
    render(<JobsPanel sessionId={ID} />);
    expect(screen.getByText('No background jobs')).toBeTruthy();
  });

  it('shows live and finished jobs, with Stop only on the live one', () => {
    mountSession(ID, state);
    render(<JobsPanel sessionId={ID} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('running');
    expect(rows[0]!.textContent).toContain('http://localhost:5173');
    expect(within(rows[0]!).getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(rows[1]!.textContent).toContain('finished');
    expect(rows[1]!.textContent).toContain('Exited with code 0.');
    expect(within(rows[1]!).queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('tails the log of a job through service.read-log', async () => {
    const handler: CommandHandler = (cmd) => (cmd.c === 'service.read-log'
      ? { ok: true, value: { rows: ['ready in 120 ms', 'listening'], cursor: 2, truncated: false } } : { ok: true });
    const session = mountSession(ID, state, { handler });
    render(<JobsPanel sessionId={ID} />);
    const rows = screen.getAllByRole('listitem');
    await userEvent.setup().click(within(rows[1]!).getByRole('button', { name: 'Show output' }));
    const log = await screen.findByLabelText('Output of job build');
    await waitFor(() => expect(log.textContent).toContain('ready in 120 ms\nlistening'));
    expect(session.commands[0]).toEqual({ c: 'service.read-log', id: 'build' });
  });

  it('stops a job and says why when the host refuses', async () => {
    const session = mountSession(ID, state, { handler: () => ({ ok: false, code: 'rejected', message: 'No such job.' }) });
    render(<JobsPanel sessionId={ID} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Stop' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No such job.');
    expect(session.commands).toEqual([{ c: 'service.stop', id: 'dev' }]);
  });
});

describe('ContextPanel', () => {
  const pressure = { windowSource: 'api', occupied: 0, contextWindow: 0, ratio: 0, headroom: 0, source: 'usage', windowKnown: true };
  const compaction = (extra: Record<string, unknown> = {}) => ({
    type: 'compactionSnapshot',
    snapshot: {
      live: true, model: 'fast', compactions: 1, applied: 1, declined: 0, tokensReclaimed: 52_000,
      usage: { inputTokens: 0, outputTokens: 0 }, pricingUnknown: false, inFlight: false, selfDisabled: false, generation: 1, pressure,
      ...extra,
    },
  }) as never;
  const usage = (extra: Record<string, unknown> = {}) => ({
    type: 'contextUsage',
    snapshot: { occupied: 82_000, window: 200_000, pct: 41, source: 'usage', deltaTokens: 0, windowKnown: true, windowOverridden: false, ...extra },
  }) as never;

  it('shows the gauge as a measurement when the window is known and as an estimate when it is not', () => {
    mountSession(ID, run([usage()]));
    const { unmount } = render(<ContextPanel sessionId={ID} />);
    expect(screen.getByRole('img', { name: 'Context window 41% full' })).toBeTruthy();
    expect(screen.getByText('82k of 200k tokens')).toBeTruthy();
    unmount();
    unmountSession(ID);

    mountSession(ID, run([usage({ windowKnown: false })]));
    render(<ContextPanel sessionId={ID} />);
    expect(screen.getByRole('img', { name: 'Context window ~41% full' })).toBeTruthy();
    expect(screen.getByText(/window size is unknown/)).toBeTruthy();
  });

  it('compacts on request and reports the host’s refusal', async () => {
    const session = mountSession(ID, run([usage(), compaction()]), { handler: () => ({ ok: false, code: 'rejected', message: 'Nothing to compact.' }) });
    render(<ContextPanel sessionId={ID} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Compact now' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Nothing to compact.');
    expect(session.commands).toEqual([{ c: 'compact' }]);
  });

  it('will not compact while a run is going, and says why', () => {
    mountSession(ID, run([usage(), compaction(), { type: 'runStart' }]));
    render(<ContextPanel sessionId={ID} />);
    expect((screen.getByRole('button', { name: 'Compact now' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Wait for the current run to finish before compacting.')).toBeTruthy();
  });

  it('lists past compactions with the tokens they reclaimed', () => {
    mountSession(ID, run([
      usage(), compaction(),
      { type: 'compactionStart', index: 1, trigger: 'pressure', model: 'fast' },
      {
        type: 'compactionEnd',
        record: {
          index: 1, trigger: 'pressure', mode: 'summarized', applied: true, messagesBefore: 80, messagesAfter: 12,
          tokensBefore: 150_000, tokensAfter: 30_000, summary: 'We fixed the parser.', model: 'fast', durationMs: 4000,
        },
      },
    ]));
    render(<ContextPanel sessionId={ID} />);
    expect(screen.getByText('52k reclaimed')).toBeTruthy();
    expect(screen.getByText('Compaction 1')).toBeTruthy();
    expect(screen.getByText('applied')).toBeTruthy();
    expect(screen.getByText(/150k → 30k tokens/)).toBeTruthy();
    expect(screen.getByText('We fixed the parser.')).toBeTruthy();
  });

  it('says compaction is off for the session', () => {
    mountSession(ID, run([usage()]));
    render(<ContextPanel sessionId={ID} />);
    expect(screen.getByText('Compaction is switched off for this session.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Compact now' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('GovernancePanel', () => {
  const snapshot = (extra: Record<string, unknown> = {}) => ({
    type: 'govSnapshot',
    snapshot: {
      runId: 'run-1', goal: 'Ship the parser', status: 'executing', phase: 1, phaseCount: 3, stage: 'dev', stageRunning: true,
      startedAt: 1, pipeline: [{ key: 'intake', state: 'done' }, { key: 'dev', state: 'active' }, { key: 'review', state: 'pending' }],
      roster: [{ id: 'DEV-1', role: 'DEV', generation: 1, state: 'working', wpId: 'wp1', activity: 'coding', confirmed: 4, provisional: 0, label: 'NORMAL', lastDelta: null, replacedBy: null }],
      health: 80, recent: [], usage: { inputTokens: 1000, outputTokens: 500, costUsd: null }, budgetTokens: 10_000, alerts: ['Budget at 75%'],
      reworkNote: null, rev: 1, ...extra,
    },
  }) as never;

  const runsHandler: CommandHandler = (cmd) => {
    if (cmd.c === 'gov.runs') return { ok: true, value: [{ runId: 'run-0', goal: 'Earlier goal', status: 'closed', updatedAt: 1 }] };
    if (cmd.c === 'gov.report') return { ok: true, value: { kind: 'ok', runId: 'run-0', file: 'reports/phase-1.md', text: 'REPORT BODY', path: '/p' } };
    return { ok: true };
  };

  it('gives the host’s reason when governance is unavailable', async () => {
    mountSession(ID, initialViewState(), { meta: { governanceUnavailable: 'Governance is switched off in settings.' }, handler: runsHandler });
    render(<GovernancePanel sessionId={ID} />);
    expect(screen.getByText('Governance is switched off in settings.')).toBeTruthy();
    expect(screen.getByText('No governed run')).toBeTruthy();
  });

  it('shows the live run with its pipeline, roster and alerts', async () => {
    mountSession(ID, run([snapshot()]), { handler: runsHandler });
    render(<GovernancePanel sessionId={ID} />);
    expect(screen.getByText('Ship the parser')).toBeTruthy();
    expect(screen.getByText(/Phase 1 of 3/)).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Stages' }).textContent).toContain('Develop now');
    expect(screen.getByText('DEV-1', { exact: false })).toBeTruthy();
    expect(screen.getByText('working')).toBeTruthy();
    expect(screen.getByText('Budget at 75%')).toBeTruthy();
    expect(await screen.findByText('Earlier goal')).toBeTruthy();
  });

  it('pauses at the next stage and then offers to cancel the pause', async () => {
    const session = mountSession(ID, run([snapshot()]), { handler: runsHandler });
    render(<GovernancePanel sessionId={ID} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Pause at the next stage' }));
    expect(session.commands).toContainEqual({ c: 'gov.pause' });

    await act(async () => { session.push(...[snapshot({ rev: 2, pauseRequested: true })] as ViewAction[]); });
    await user.click(await screen.findByRole('button', { name: 'Cancel pause' }));
    expect(session.commands).toContainEqual({ c: 'gov.cancel-pause' });
    expect(screen.getByText(/Pause requested/)).toBeTruthy();
  });

  it('reads a past run’s report on request', async () => {
    const session = mountSession(ID, initialViewState(), { handler: runsHandler });
    render(<GovernancePanel sessionId={ID} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'View report' }));
    expect(await screen.findByText('REPORT BODY')).toBeTruthy();
    expect(session.commands).toContainEqual({ c: 'gov.report', runId: 'run-0' });
  });

  it('says so when a run has no report yet', async () => {
    mountSession(ID, initialViewState(), {
      handler: (cmd) => (cmd.c === 'gov.report' ? { ok: true, value: { kind: 'missing', runId: 'run-0' } } : runsHandler(cmd)),
    });
    render(<GovernancePanel sessionId={ID} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'View report' }));
    expect(await screen.findByText('That run has no report yet.')).toBeTruthy();
  });
});
