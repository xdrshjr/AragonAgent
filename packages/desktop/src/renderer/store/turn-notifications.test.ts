import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSession, unmountSession } from '../chat/__tests__/kit.js';
import { SETTLE_MS, turnEndBody, watchTurnEnd } from './turn-notifications.js';
import { sessionStore } from './session-store.js';

const invoke = vi.fn(async () => ({ ok: true, value: { shown: true } }));
let stop: () => void;

beforeEach(() => {
  invoke.mockClear();
  window.aragon = { platform: 'win32', on: () => () => undefined, invoke } as unknown as Window['aragon'];
});
afterEach(() => { stop?.(); unmountSession(); });

const events = (host: ReturnType<typeof mountSession>, ...statuses: string[]) => {
  for (const status of statuses) host.deliver({ v: 1, t: 'evt', evt: { e: 'status', status: status as never } });
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 30));
const notices = () => invoke.mock.calls.filter((call) => (call as unknown[])[0] === 'native:notify').map((call) => (call as unknown[])[1]);

describe('watchTurnEnd', () => {
  it('asks for one notification when a running session goes idle, with the first line of the reply', async () => {
    const host = mountSession({ meta: { cwd: 'C:\\work\\my-repo' } });
    stop = watchTurnEnd();
    host.dispatch({ type: 'submit', text: 'q' }, { type: 'runStart' }, { type: 'turnStart' }, { type: 'textDelta', delta: 'All green.\nDetails follow.' });
    events(host, 'running', 'idle');
    await settle();
    expect(notices()).toEqual([{ title: 'my-repo', body: 'All green.', sessionId: 's1' }]);
  });

  it('stays quiet when nothing was running (a status repeat, or the first status of a session)', async () => {
    const host = mountSession();
    stop = watchTurnEnd();
    events(host, 'idle', 'ready', 'idle');
    await settle();
    expect(notices()).toEqual([]);
  });

  it('counts a turn that ended while an approval was pending, and does not repeat on later idle events', async () => {
    const host = mountSession();
    stop = watchTurnEnd();
    events(host, 'running', 'waiting-approval', 'idle', 'idle');
    await settle();
    expect(notices()).toHaveLength(1);
  });

  it('sends a second notification for the next turn, not a merged one', async () => {
    const host = mountSession();
    stop = watchTurnEnd();
    events(host, 'running', 'idle', 'running', 'idle');
    await settle();
    expect(notices()).toHaveLength(2);
  });
});

describe('turnEndBody', () => {
  it('does not quote an answer that belongs to an earlier question', () => {
    const host = mountSession();
    host.dispatch({ type: 'submit', text: 'first' }, { type: 'runStart' }, { type: 'turnStart' }, { type: 'textDelta', delta: 'old answer' }, { type: 'runEnd' }, { type: 'submit', text: 'second' });
    expect(turnEndBody(sessionStore.get('s1')!)).toBe('Finished.');
  });

  it('clips a very long first line', () => {
    const host = mountSession();
    host.dispatch({ type: 'submit', text: 'q' }, { type: 'runStart' }, { type: 'turnStart' }, { type: 'textDelta', delta: 'x'.repeat(500) });
    expect(turnEndBody(sessionStore.get('s1')!).length).toBeLessThanOrEqual(120);
  });
});
