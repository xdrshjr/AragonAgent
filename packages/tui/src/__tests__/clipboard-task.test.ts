import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClipboardCoordinator } from '../ui/clipboard-task.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
function childProcess() {
  const stdin = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  return Object.assign(new EventEmitter(), { stdin, kill: vi.fn(() => true) });
}
beforeEach(() => { vi.useFakeTimers(); spawn.mockReset(); });
afterEach(() => vi.useRealTimers());

describe('shared clipboard coordinator', () => {
  it('claims the lock synchronously across command and selection requests', async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const onResult = vi.fn();
    const onRequest = vi.fn();
    const onBusy = vi.fn();
    const coordinator = createClipboardCoordinator({
      clipboard: { remote: false }, onResult, onRequest, onBusy,
    });
    const first = coordinator.requestCopy({ text: 'command', lines: 1 });
    expect(coordinator.isBusy()).toBe(true);
    expect(await coordinator.requestCopy({ text: 'selection', lines: 1 }))
      .toEqual({ status: 'busy' });
    expect(spawn).toHaveBeenCalledOnce();
    expect(onRequest).toHaveBeenCalledTimes(2);
    expect(onBusy).toHaveBeenCalledOnce();
    child.emit('close', 0);
    expect(await first).toEqual({ status: 'confirmed', via: 'native' });
    await Promise.resolve();
    expect(coordinator.isBusy()).toBe(false);
    expect(onResult).toHaveBeenCalledExactlyOnceWith(
      { status: 'confirmed', via: 'native' }, { text: 'command', lines: 1 },
    );
  });

  it('retains the global lock after failed result until the old writer closes', async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const onResult = vi.fn();
    const onStateChange = vi.fn();
    const write = vi.fn();
    const coordinator = createClipboardCoordinator({
      clipboard: { remote: false, write, timeoutMs: 10 }, onResult, onStateChange,
    });
    const first = coordinator.requestCopy({ text: 'old', lines: 1 });
    await vi.advanceTimersByTimeAsync(510);
    expect(await first).toEqual({ status: 'failed', reason: 'timeout' });
    expect(coordinator.isBusy()).toBe(true);
    expect(coordinator.isCleanupPending()).toBe(true);
    expect(onStateChange).toHaveBeenLastCalledWith({ busy: true, cleanupPending: true });
    expect(await coordinator.requestCopy({ text: 'new', lines: 1 })).toEqual({ status: 'busy' });
    expect(write).not.toHaveBeenCalled();
    child.emit('close', 0);
    await Promise.resolve();
    expect(coordinator.isBusy()).toBe(false);
    expect(coordinator.isCleanupPending()).toBe(false);
    expect(onResult).toHaveBeenCalledOnce();
    const next = childProcess();
    spawn.mockReturnValue(next);
    const second = coordinator.requestCopy({ text: 'new', lines: 1 });
    next.emit('close', 0);
    expect(await second).toEqual({ status: 'confirmed', via: 'native' });
  });

  it('disposes permanently, cancels the writer and suppresses late UI callbacks', async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const onResult = vi.fn();
    const onStateChange = vi.fn();
    const write = vi.fn();
    const coordinator = createClipboardCoordinator({
      clipboard: { remote: false, write }, onResult, onStateChange,
    });
    const first = coordinator.requestCopy({ text: 'old', lines: 1 });
    onStateChange.mockClear();
    coordinator.dispose();
    coordinator.dispose();
    expect(await first).toEqual({ status: 'failed', reason: 'cancelled' });
    expect(await coordinator.requestCopy({ text: 'new', lines: 1 }))
      .toEqual({ status: 'failed', reason: 'cancelled' });
    child.emit('error', Error('late'));
    child.emit('close', 0);
    await Promise.resolve();
    expect(onResult).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases OSC requests and only emits one unconfirmed feedback', async () => {
    const onResult = vi.fn();
    const coordinator = createClipboardCoordinator({
      clipboard: { remote: true, write: vi.fn() }, onResult,
    });
    expect(await coordinator.requestCopy({ text: 'remote', lines: 1 }))
      .toEqual({ status: 'sent', via: 'osc52' });
    await Promise.resolve();
    expect(coordinator.isBusy()).toBe(false);
    expect(onResult).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
  });
});
