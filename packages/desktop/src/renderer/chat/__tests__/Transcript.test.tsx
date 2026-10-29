import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry, ViewAction } from '@aragon-agent/tui/model/agent/reducer';
import type { ServiceSnapshot } from '@aragon-agent/tui/model/proc/types';
import { buildPatch } from '@aragon-agent/tui/model/tools/patch';
import { onComposerIntent } from '../../composer/composer-bus.js';
import { sessionStore } from '../../store/session-store.js';
import { useUi } from '../../store/ui-store.js';
import { RetryRow } from '../RetryRow.js';
import { Transcript } from '../Transcript.js';
import { mountSession, reduce, unmountSession, type FakeHost } from './kit.js';

const COMPACTION = {
  index: 1, trigger: 'pressure', mode: 'summarized', applied: true, messagesBefore: 40, messagesAfter: 6,
  tokensBefore: 50_000, tokensAfter: 9_000, model: 'summary-model', durationMs: 3200,
} as const;

const SERVICE = {
  id: 's1', kind: 'service', toolCallId: 'tc9', command: 'npm run dev', cwd: '/work/repo', pid: 4242,
  status: 'ready', startedAt: 1, exitCode: null, signal: null, port: 5173, rows: ['ready in 300 ms'],
  rowsSeen: 1, truncated: false, lastOutputAt: 2,
} as unknown as ServiceSnapshot;

const PATCH = buildPatch('const a = 1;\nconst b = 2;\n', 'const a = 1;\nconst b = 3;\n', { path: 'src/a.ts' });

function conversation(): ViewAction[] {
  return [
    { type: 'submit', text: 'Fix the flaky test' },
    { type: 'runStart' },
    { type: 'turnStart' },
    { type: 'thinkingStart' },
    { type: 'thinkingDelta', delta: 'secret reasoning text' },
    { type: 'textDelta', delta: 'I will run the **suite** first.' },
    { type: 'toolCallStart', toolCallId: 't1', toolName: 'bash' },
    { type: 'toolCallEnd', toolCallId: 't1', args: { command: 'npm test' } },
    { type: 'toolExecStart', toolCallId: 't1' },
    { type: 'toolExecEnd', toolCallId: 't1', isError: false, duration: 12_400, preview: 'ok 12 tests passed' },
    { type: 'toolCallStart', toolCallId: 't2', toolName: 'edit_file' },
    { type: 'toolCallEnd', toolCallId: 't2', args: { path: 'src/a.ts' } },
    { type: 'toolExecStart', toolCallId: 't2' },
    { type: 'toolExecEnd', toolCallId: 't2', isError: false, duration: 40, preview: 'edited', patch: PATCH },
    { type: 'serviceStart', service: SERVICE },
    { type: 'compactionEnd', record: { ...COMPACTION } },
    { type: 'notice', level: 'warn', text: 'Heads up: a warning' },
    { type: 'turnEnd', usage: { inputTokens: 10, outputTokens: 5 }, costDelta: 0.01 },
    { type: 'runEnd' },
  ];
}

let host: FakeHost;

beforeEach(() => { host = mountSession({ view: reduce(conversation()) }); });
afterEach(() => { cleanup(); unmountSession(); });

describe('Transcript entry kinds', () => {
  it('renders user, assistant (as markdown), thinking, tool, service, compaction and notice entries', () => {
    render(<Transcript sessionId="s1" />);
    expect(screen.getByText('Fix the flaky test')).toBeTruthy();
    expect(screen.getByText('suite').tagName).toBe('STRONG');
    expect(screen.getByRole('button', { name: /Thinking/ })).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText('npm run dev')).toBeTruthy();
    expect(screen.getByText('Context compacted: 41k tokens reclaimed')).toBeTruthy();
    expect(screen.getByText('Heads up: a warning')).toBeTruthy();
  });

  it('keeps thinking collapsed by default and reveals it through the shared toggle', () => {
    render(<Transcript sessionId="s1" />);
    expect(screen.queryByText('secret reasoning text')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Thinking/ }));
    expect(screen.getByText('secret reasoning text')).toBeTruthy();
  });

  it('expands a bash card to its command and ANSI output, and collapses it again', () => {
    render(<Transcript sessionId="s1" />);
    const head = screen.getByRole('button', { name: /bash/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('ok 12 tests passed')).toBeNull();
    fireEvent.click(head);
    expect(screen.getByText('ok 12 tests passed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /bash/ }));
    expect(screen.queryByText('ok 12 tests passed')).toBeNull();
  });

  it('shows the change counts on an edit card and a diff, unified or side by side, on expand', () => {
    render(<Transcript sessionId="s1" />);
    const head = screen.getByRole('button', { name: /edit_file/ });
    expect(head.textContent).toContain('+1');
    fireEvent.click(head);
    expect(screen.getByText('const b = 3;')).toBeTruthy();
    expect(document.querySelector('.diff-unified')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show side by side' }));
    expect(document.querySelector('.diff-split')).not.toBeNull();
  });

  it('expands the compaction divider to its details', () => {
    render(<Transcript sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: /Context compacted/ }));
    expect(screen.getByText('summary-model')).toBeTruthy();
  });

  it('draws a service row with its status and a Stop button that stops that job', async () => {
    render(<Transcript sessionId="s1" />);
    expect(screen.getByText(/ready.*:5173/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(host.commandsOf('service.stop')).toEqual([{ c: 'service.stop', id: 's1' }]));
  });

  it('shows the process id of a job beside its command', () => {
    render(<Transcript sessionId="s1" />);
    expect(screen.getByText('pid 4242')).toBeTruthy();
  });

  it('marks the transcript as a polite log and shows the caret only while a run is live', () => {
    render(<Transcript sessionId="s1" />);
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(document.querySelector('.caret')).toBeNull();
    host.dispatch({ type: 'runStart' }, { type: 'turnStart' }, { type: 'textDelta', delta: 'streaming now' });
    expect(document.querySelector('.caret')).not.toBeNull();
    expect(document.querySelector('.assistant-body[aria-busy="true"]')).not.toBeNull();
  });
});

describe('Transcript errors and queue', () => {
  it('offers model settings for a missing-configuration error', () => {
    host.dispatch({ type: 'notice', level: 'error', text: 'No API key for "anthropic" - open /settings or set ANTHROPIC_API_KEY.' });
    render(<Transcript sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open model settings' }));
    expect(useUi.getState().view).toBe('settings');
    expect(useUi.getState().settingsPage).toBe('models');
  });

  it('re-submits the last user message for Retry', async () => {
    host.dispatch({ type: 'notice', level: 'error', text: 'Rate limited by the provider - please retry shortly. (429)' });
    render(<Transcript sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(host.commandsOf('submit')).toEqual([{ c: 'submit', text: 'Fix the flaky test' }]));
  });

  it('compacts first, then re-submits, for "Compact and retry"', async () => {
    host.dispatch({ type: 'notice', level: 'error', text: 'Context length exceeded - try /compact, or start over with /reset. (too long)' });
    render(<Transcript sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Compact and retry' }));
    await waitFor(() => expect(host.commands.map((command) => command.c)).toEqual(['compact', 'submit']));
  });

  it('does not offer Retry when the last user entry is an invocation (its text is not the prompt)', () => {
    host = mountSession({
      view: reduce([
        { type: 'submit', text: '/team 3', invocation: { variant: 'team', name: '', commandLine: '/team 3', input: '', inputHidden: 0, facts: [] } },
        { type: 'notice', level: 'error', text: 'Rate limited by the provider - please retry shortly. (429)' },
      ]),
    });
    render(<Transcript sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(host.commandsOf('submit')).toHaveLength(0);
  });

  it('explains instead of hiding the withdraw button when the host cannot withdraw yet', async () => {
    host = mountSession({
      view: reduce([
        { type: 'runStart' },
        { type: 'steerQueued', queueId: 'q1', text: 'also do this' },
      ]),
    });
    host.respond = (command) => (command.c === 'queue.cancel'
      ? { ok: false, code: 'unsupported', message: 'Withdrawing a queued message is not supported yet.' }
      : { ok: true });
    render(<Transcript sessionId="s1" />);
    expect(screen.getByText('queued #1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw queued message' }));
    await waitFor(() => expect(host.commandsOf('queue.cancel')).toEqual([{ c: 'queue.cancel', queueId: 'q1' }]));
    await waitFor(() => expect(screen.getByText('also do this')).toBeTruthy());
  });
});

describe('withdrawing a queued message', () => {
  function queued() {
    return mountSession({ view: reduce([{ type: 'runStart' }, { type: 'steerQueued', queueId: 'q1', text: 'also do this' }]) });
  }
  const press = () => fireEvent.click(screen.getByRole('button', { name: 'Withdraw queued message' }));

  it('hands the returned text to the composer', async () => {
    host = queued();
    host.respond = (command) => (command.c === 'queue.cancel' ? { ok: true, value: { text: 'also do this' } } : { ok: true });
    const received: Array<string | undefined> = [];
    const off = onComposerIntent('restore-text', (value) => received.push(value));
    render(<Transcript sessionId="s1" />);
    press();
    await waitFor(() => expect(received).toEqual(['also do this']));
    off();
  });

  it('shows a neutral toast, not an error, when the engine already took the message', async () => {
    host = queued();
    host.respond = (command) => (command.c === 'queue.cancel'
      ? { ok: false, code: 'already_delivered', message: 'x' } : { ok: true });
    const received: Array<string | undefined> = [];
    const off = onComposerIntent('restore-text', (value) => received.push(value));
    render(<Transcript sessionId="s1" />);
    press();
    await waitFor(() => expect(host.commandsOf('queue.cancel')).toHaveLength(1));
    await waitFor(() => {
      const toast = sessionStore.get('s1')?.view?.toasts.at(-1);
      expect(toast).toMatchObject({ level: 'info' });
      expect(toast?.text).toContain('already received');
    });
    expect(received).toEqual([]);
    off();
  });
});

describe('Transcript volume', () => {
  it('mounts a bounded window of rows for 5,000 entries', () => {
    const many: Entry[] = Array.from({ length: 5000 }, (_unused, index) => ({ id: `e${index}`, kind: 'user', text: `message ${index}` }));
    const base = reduce([]);
    host = mountSession({ view: { ...base, entries: many } });
    render(<Transcript sessionId="s1" />);
    expect(document.querySelectorAll('.row').length).toBeLessThan(80);
    expect(document.querySelectorAll('.row').length).toBeGreaterThan(0);
  });
});

describe('RetryRow', () => {
  const entry = (patch: Partial<Extract<Entry, { kind: 'retry' }>>): Extract<Entry, { kind: 'retry' }> => ({
    id: 'e1', kind: 'retry', attempt: 2, maxRetries: 5, errorType: 'rate_limit', message: 'slow down',
    delayMs: 3000, resumeAt: Date.now() + 3000, phase: 'waiting', startedAt: Date.now(), ...patch,
  });

  afterEach(() => { vi.useRealTimers(); });

  it('counts down live from the entry and owns a timer only while waiting', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const interval = vi.spyOn(globalThis, 'setInterval');
    const { container, rerender } = render(<RetryRow entry={entry({})} />);
    expect(container.textContent).toContain('retrying in 3 s (attempt 2/5)');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(container.textContent).toContain('retrying in 2 s');
    expect(interval).toHaveBeenCalled();

    interval.mockClear();
    rerender(<RetryRow entry={entry({ phase: 'recovered', totalRetries: 2 })} />);
    expect(container.textContent).toContain('Recovered after 2 retries');
    act(() => { vi.advanceTimersByTime(5000); });
    expect(container.textContent).toContain('Recovered after 2 retries');
    expect(interval).not.toHaveBeenCalled();
  });
});
