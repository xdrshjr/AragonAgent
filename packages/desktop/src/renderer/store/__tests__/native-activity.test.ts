import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSession, unmountSession } from '../../chat/__tests__/kit.js';
import { ACTIVITY_THROTTLE_MS, summarizeActivity, watchActivity } from '../native-activity.js';

describe('summarizeActivity', () => {
  it('counts running and waiting sessions, and nothing else', () => {
    const statuses = ['running', 'running', 'waiting-approval', 'idle', 'starting'] as const;
    expect(summarizeActivity(statuses.map((runStatus) => ({ runStatus })) as never)).toEqual({ running: 2, waiting: 1 });
    expect(summarizeActivity([])).toEqual({ running: 0, waiting: 0 });
  });
});

describe('watchActivity (AC-83, renderer half)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); unmountSession(); unmountSession('s2'); });

  it('reports a change once per window, not once per store update, and stays quiet when nothing changed', () => {
    const send = vi.fn();
    const host = mountSession();
    const stop = watchActivity(send);
    const status = (value: string): void => host.deliver({ v: 1, t: 'evt', evt: { e: 'status', status: value as never } });
    status('running');
    for (let index = 0; index < 20; index += 1) host.dispatch({ type: 'runStart' }); // many store updates inside one window
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(ACTIVITY_THROTTLE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ running: 1, waiting: 0 });

    host.dispatch({ type: 'runStart' }); // a store update that changes nothing the taskbar cares about
    vi.advanceTimersByTime(ACTIVITY_THROTTLE_MS * 2);
    expect(send).toHaveBeenCalledTimes(1);

    status('waiting-approval');
    vi.advanceTimersByTime(ACTIVITY_THROTTLE_MS);
    expect(send).toHaveBeenLastCalledWith({ running: 0, waiting: 1 });
    stop();
  });

  it('stops reporting after unsubscribe', () => {
    const send = vi.fn();
    const host = mountSession();
    const stop = watchActivity(send);
    stop();
    host.deliver({ v: 1, t: 'evt', evt: { e: 'status', status: 'running' } });
    vi.advanceTimersByTime(ACTIVITY_THROTTLE_MS * 4);
    expect(send).not.toHaveBeenCalled();
  });
});
