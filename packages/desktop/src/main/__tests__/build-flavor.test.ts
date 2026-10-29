import { describe, expect, it, vi } from 'vitest';
import { allowsTestSwitches, resolveFlavor } from '../build-flavor.js';
import {
  E2E_HOOKS, E2E_HOST_HOOKS, E2E_OFF, NotificationQueue, installE2eHooks, parseE2eOptions, type E2eHooks,
} from '../e2e-support.js';
import { ConfigService } from '../config-service.js';

/** Every switch the harness knows, so "release ignores them all" is checked against all of them. */
const ALL_SWITCHES = ['--e2e', '--e2e-fault=enospc', '--e2e-feed=http://127.0.0.1:4010/latest.json', '--e2e-restore-window'];

describe('resolveFlavor', () => {
  it('derives the flavor from packaging when nothing was baked: packaged is release, never e2e', () => {
    expect(resolveFlavor(true, null)).toBe('release');
    expect(resolveFlavor(false, null)).toBe('dev');
  });
  it('honours a baked flavor over packaging', () => {
    expect(resolveFlavor(true, 'e2e')).toBe('e2e');
    expect(resolveFlavor(false, 'release')).toBe('release');
  });
  it('allows test switches in dev and e2e only', () => {
    expect(allowsTestSwitches('dev')).toBe(true);
    expect(allowsTestSwitches('e2e')).toBe(true);
    expect(allowsTestSwitches('release')).toBe(false);
  });
});

describe('parseE2eOptions', () => {
  it('reads the three switches in a non-release build', () => {
    expect(parseE2eOptions(ALL_SWITCHES, 'e2e')).toEqual({ enabled: true, fault: 'enospc', feedUrl: 'http://127.0.0.1:4010/latest.json', restoreWindow: true });
    expect(parseE2eOptions(['--e2e-fault=eacces'], 'dev')).toEqual({ enabled: false, fault: 'eacces', feedUrl: null, restoreWindow: false });
  });

  it('--e2e-restore-window is read in dev / e2e builds and is a no-op in release', () => {
    expect(parseE2eOptions(['--e2e', '--e2e-restore-window'], 'e2e').restoreWindow).toBe(true);
    expect(parseE2eOptions(['--e2e'], 'e2e').restoreWindow).toBe(false);
    expect(parseE2eOptions(['--e2e', '--e2e-restore-window'], 'release').restoreWindow).toBe(false);
  });

  it('ignores an unknown fault name rather than guessing', () => {
    expect(parseE2eOptions(['--e2e', '--e2e-fault=meteor'], 'e2e').fault).toBeNull();
  });

  it('RELEASE: every switch is a no-op - the result is identical with and without them', () => {
    expect(parseE2eOptions(ALL_SWITCHES, 'release')).toEqual(E2E_OFF);
    expect(parseE2eOptions([], 'release')).toEqual(E2E_OFF);
  });
});

describe('release flavor has no test hooks (spec R2)', () => {
  it('installs nothing, with or without the switches', () => {
    for (const argv of [[], ALL_SWITCHES]) {
      const target: Record<string, unknown> = {};
      const installed = installE2eHooks(target, parseE2eOptions(argv, 'release'), new NotificationQueue());
      expect(installed).toEqual([]);
      expect(Object.keys(target)).toEqual([]);
    }
  });

  it('installs exactly the documented hooks in an --e2e run, and they read and click the queue', () => {
    const target: { __aragonE2e?: E2eHooks } = {};
    const queue = new NotificationQueue();
    expect(installE2eHooks(target, parseE2eOptions(['--e2e'], 'e2e'), queue)).toEqual([...E2E_HOOKS]);
    expect(Object.keys(target.__aragonE2e!).sort()).toEqual([...E2E_HOOKS].sort());
    const click = vi.fn();
    queue.push({ title: 't', body: 'b' }, click);
    expect(target.__aragonE2e!.activateNotification(0)).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(target.__aragonE2e!.drainNotifications()).toEqual([{ title: 't', body: 'b' }]);
  });

  it('adds the host hooks only when they are supplied, and still only in a non-release run', () => {
    const host = {
      crashRenderer: vi.fn(), failLoad: vi.fn(), pendingMessageBoxes: vi.fn(() => []), answerMessageBox: vi.fn(() => true),
      getWindowGeometry: vi.fn(), setZoom: vi.fn(),
    };
    const target: { __aragonE2e?: E2eHooks } = {};
    const installed = installE2eHooks(target, parseE2eOptions(['--e2e'], 'e2e'), new NotificationQueue(), host as never);
    expect(installed).toEqual([...E2E_HOOKS, ...E2E_HOST_HOOKS]);
    expect(Object.keys(target.__aragonE2e!).sort()).toEqual([...E2E_HOOKS, ...E2E_HOST_HOOKS].sort());
    const none: Record<string, unknown> = {};
    expect(installE2eHooks(none, parseE2eOptions(ALL_SWITCHES, 'release'), new NotificationQueue(), host as never)).toEqual([]);
    expect(Object.keys(none)).toEqual([]);
  });

  it('does not inject a config write fault in release, and does in e2e', () => {
    const engine = { settings: { patchConfig: vi.fn(() => ({ ok: true, revision: 'r2', changedKeys: ['x'] })) } };
    const fault = (flavor: 'release' | 'e2e') =>
      new ConfigService(engine as never, { writeFault: parseE2eOptions(ALL_SWITCHES, flavor).fault });
    expect(fault('release').patch('r1', { x: 1 })).toEqual({ ok: true, revision: 'r2', changedKeys: ['x'] });
    expect(fault('e2e').patch('r1', { x: 1 })).toEqual({ ok: false, code: 'write_failed', revision: 'r1' });
    expect(engine.settings.patchConfig).toHaveBeenCalledTimes(1); // the injected one never reached the engine
  });
});

describe('NotificationQueue', () => {
  it('drains in order and empties itself, and keeps click handlers out of the drained data', () => {
    const queue = new NotificationQueue();
    queue.push({ title: 'a', body: '1', sessionId: 's1' }, () => undefined);
    queue.push({ title: 'b', body: '2' }, () => undefined);
    expect(queue.size).toBe(2);
    expect(queue.drain()).toEqual([{ title: 'a', body: '1', sessionId: 's1' }, { title: 'b', body: '2' }]);
    expect(queue.drain()).toEqual([]);
  });

  it('activates the n-th item and answers false for one that does not exist', () => {
    const queue = new NotificationQueue();
    const click = vi.fn();
    queue.push({ title: 'a', body: '' }, click);
    expect(queue.activate(0)).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(queue.activate(5)).toBe(false);
  });
});
