import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_SEND_GRACE_MS, sessionStore } from '../../store/session-store.js';
import { Transcript } from '../Transcript.js';
import { mountSession, unmountSession, type FakeHost } from './kit.js';

let host: FakeHost;
beforeEach(() => { host = mountSession(); });
afterEach(() => { cleanup(); unmountSession(); vi.useRealTimers(); });

const pending = () => sessionStore.get('s1')!.pendingSends;
const settle = (): Promise<void> => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('optimistic sends (pendingSends)', () => {
  it('shows the message at once, and removes it when the host has accepted it and its entry has arrived', async () => {
    let answer!: () => void;
    host.respond = (command) => (command.c === 'submit'
      ? new Promise((resolve) => { answer = () => resolve({ ok: true }); })
      : { ok: true });
    const done = sessionStore.sendMessage('s1', 'hello');
    expect(pending()).toMatchObject([{ text: 'hello', state: 'sending' }]);
    render(<Transcript sessionId="s1" />);
    expect(screen.getByText('Sending…')).toBeTruthy();

    // The ack can arrive BEFORE the entry (actions are batched per frame): the bubble must stay.
    answer();
    await done;
    expect(pending()).toHaveLength(1);

    host.dispatch({ type: 'submit', text: 'hello' });
    await settle();
    expect(pending()).toHaveLength(0);
    // Exactly one bubble for the message: the real entry, not the grey one as well.
    expect(screen.getAllByText('hello')).toHaveLength(1);
  });

  it('removes the bubble when the entry arrives before the ack', async () => {
    let answer!: () => void;
    host.respond = (command) => (command.c === 'submit'
      ? new Promise((resolve) => { answer = () => resolve({ ok: true }); })
      : { ok: true });
    const done = sessionStore.sendMessage('s1', 'fast');
    host.dispatch({ type: 'submit', text: 'fast' });
    expect(pending()).toHaveLength(1); // not accepted yet
    answer();
    await done;
    expect(pending()).toHaveLength(0);
  });

  it('drops an accepted bubble whose entry never comes, instead of leaving a grey ghost', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await sessionStore.sendMessage('s1', 'no entry');
    expect(pending()).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(PENDING_SEND_GRACE_MS + 1); });
    expect(pending()).toHaveLength(0);
  });

  it('turns into a failed bubble that keeps the text when the port is closed, and Retry resends it', async () => {
    host.respond = () => ({ ok: false, code: 'port_closed', message: 'The session is not connected.' });
    render(<Transcript sessionId="s1" />);
    await act(async () => { await sessionStore.sendMessage('s1', 'try me'); });
    expect(pending()).toMatchObject([{ text: 'try me', state: 'failed', error: { code: 'port_closed' } }]);
    expect(screen.getByRole('alert').textContent).toContain('Not sent.');

    host.respond = () => ({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(host.commandsOf('submit')).toHaveLength(2));
    host.dispatch({ type: 'submit', text: 'try me' });
    await settle();
    expect(pending()).toHaveLength(0);
    expect(screen.getAllByText('try me')).toHaveLength(1);
  });

  it('does not touch the host-owned view: a pending send is not an entry and never advances seq', async () => {
    host.respond = () => new Promise(() => undefined);
    const before = sessionStore.get('s1')!;
    void sessionStore.sendMessage('s1', 'x');
    const after = sessionStore.get('s1')!;
    expect(after.view).toBe(before.view);
    expect(after.lastSeq).toBe(before.lastSeq);
  });

  it('forgets bubbles when the session is closed', async () => {
    host.respond = () => new Promise(() => undefined);
    void sessionStore.sendMessage('s1', 'x');
    sessionStore.end('s1');
    expect(sessionStore.get('s1')).toBeUndefined();
  });

  it('returns not_found for a retry of something that is not a failed bubble', async () => {
    expect(await sessionStore.retrySend('s1', 'nope')).toMatchObject({ ok: false, code: 'not_found' });
  });
});
