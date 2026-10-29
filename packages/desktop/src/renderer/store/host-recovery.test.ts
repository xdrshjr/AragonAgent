import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBridge, ok, removeBridge, type TestBridge } from '../settings/__tests__/test-bridge.js';
import { mountSession, unmountSession } from '../chat/__tests__/kit.js';
import { sessionStore } from './session-store.js';
import { watchHostRecovery } from './actions.js';

let bridge: TestBridge;
let stop: () => void;

beforeEach(() => {
  bridge = installBridge({ 'sessions:open': () => ok({ sessionId: 's1', channelToken: 'tok' }), 'sessions:list': () => ok([]) });
  stop = watchHostRecovery();
});
afterEach(() => { stop(); unmountSession(); removeBridge(); vi.restoreAllMocks(); });

const closePort = (): void => {
  // The real port reports a dead peer through onClose; the store marks the mirror closed.
  (sessionStore as unknown as { update(id: string, patch: object): void }).update('s1', { phase: 'closed' });
};

describe('watchHostRecovery', () => {
  it('re-opens a session whose port closed once the main process reports the host is back', async () => {
    mountSession({ meta: { cwd: '/work' } });
    closePort();
    bridge.emit('session:status', { id: 's1', status: 'ready' });
    await vi.waitFor(() => expect(bridge.calls('sessions:open')).toEqual([{ id: 's1', cwd: '/work' }]));
  });

  it('does nothing for a healthy session, for a host still starting, or for an unknown session', async () => {
    mountSession({ meta: { cwd: '/work' } });
    bridge.emit('session:status', { id: 's1', status: 'ready' }); // port is open
    closePort();
    bridge.emit('session:status', { id: 's1', status: 'starting' });
    bridge.emit('session:status', { id: 'ghost', status: 'ready' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bridge.calls('sessions:open')).toEqual([]);
  });

  it('does not stampede: a second "ready" while the first attempt is still running is ignored', async () => {
    let release!: () => void;
    bridge.set('sessions:open', () => new Promise((resolve) => { release = () => resolve(ok({ sessionId: 's1', channelToken: 'tok' })); }));
    mountSession({ meta: { cwd: '/work' } });
    closePort();
    bridge.emit('session:status', { id: 's1', status: 'ready' });
    bridge.emit('session:status', { id: 's1', status: 'running' });
    await vi.waitFor(() => expect(bridge.calls('sessions:open')).toHaveLength(1));
    release();
    expect(bridge.calls('sessions:open')).toHaveLength(1);
  });
});
