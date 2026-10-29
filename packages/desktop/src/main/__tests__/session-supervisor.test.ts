/**
 * The host pool's state machine, driven with scripted fake hosts and fake timers.
 *
 * What these protect: a crash is recovered from (a bounded number of times, from the last
 * checkpoint), a hung host is reported but never killed, the live-host cap parks an idle
 * session instead of killing a working one, and a dead host leaves NO orphan processes - while
 * a recycled pid is never mistaken for one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostControlMsg, HostInit, MainControlMsg } from '../../shared/port-protocol.js';
import {
  HEARTBEAT_MISSES,
  MAX_AUTO_RESTARTS,
  QUIT_GRACE_MS,
  RESTART_BACKOFF_MS,
  SessionSupervisor,
  type HostProcess,
  type ProcessReaper,
} from '../session-supervisor.js';

class FakeHost implements HostProcess {
  static all: FakeHost[] = [];
  readonly sent: (MainControlMsg | HostInit | { v: 1; kind: 'port' })[] = [];
  private messageListeners: ((message: HostControlMsg) => void)[] = [];
  private exitListeners: ((code: number | null) => void)[] = [];
  killed = false;
  exited = false;
  constructor(readonly pid: number) { FakeHost.all.push(this); }
  postMessage(message: MainControlMsg | HostInit | { v: 1; kind: 'port' }): void { this.sent.push(message); }
  on(event: 'message' | 'exit', listener: never): void {
    if (event === 'message') this.messageListeners.push(listener);
    else this.exitListeners.push(listener);
  }
  kill(): boolean { this.killed = true; this.crash(0); return true; }
  say(message: HostControlMsg): void { this.messageListeners.forEach((fn) => fn(message)); }
  crash(code: number | null = 1): void {
    if (this.exited) return;
    this.exited = true;
    this.exitListeners.forEach((fn) => fn(code));
  }
  get init(): HostInit | undefined { return this.sent.find((m): m is HostInit => (m as HostInit).kind === 'init'); }
}

function setup(options: { maxLive?: number; parkAfterMs?: number } = {}) {
  FakeHost.all = [];
  let nextPid = 1000;
  const killed: number[] = [];
  const alive = new Map<number, number>(); // pid -> startedAt of a still-running descendant
  const reaper: ProcessReaper = {
    killTree: async (pid) => { killed.push(pid); alive.delete(pid); },
    startedAt: (pid) => alive.get(pid) ?? null,
  };
  const statuses: string[] = [];
  const supervisor = new SessionSupervisor({
    launcher: { fork: () => new FakeHost(nextPid++) },
    reaper, homeRoot: '/home',
    maxLiveHosts: () => options.maxLive ?? 6,
    parkAfterIdleMs: () => options.parkAfterMs ?? 0,
    onStatus: (id, status) => statuses.push(`${id}:${status}`),
  });
  const ready = (host: FakeHost, id: string): void => host.say({ v: 1, kind: 'ready', sessionId: id, pid: host.pid });
  return { supervisor, killed, alive, statuses, ready };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('open', () => {
  it('forks a host, sends it init with the home root, and is ready when it says so', () => {
    const { supervisor, ready, statuses } = setup();
    expect(supervisor.open('s1', '/work', false)).toEqual({ ok: true, id: 's1' });
    const host = FakeHost.all[0]!;
    expect(host.init).toMatchObject({ kind: 'init', sessionId: 's1', cwd: '/work', homeRoot: '/home', resume: false });
    ready(host, 's1');
    expect(statuses).toEqual(['s1:starting', 's1:ready']);
    expect(supervisor.statusOf('s1')).toBe('ready');
  });

  it('reuses a live host instead of forking a second one for the same session', () => {
    const { supervisor } = setup();
    supervisor.open('s1', '/work', false);
    supervisor.open('s1', '/work', true);
    expect(FakeHost.all).toHaveLength(1);
  });
});

describe('live-host cap', () => {
  it('parks the least recently used idle host to make room', async () => {
    const { supervisor, ready } = setup({ maxLive: 2 });
    supervisor.open('a', '/w', false);
    ready(FakeHost.all[0]!, 'a');
    vi.setSystemTime(Date.now() + 1000);
    supervisor.open('b', '/w', false);
    ready(FakeHost.all[1]!, 'b');
    supervisor.open('c', '/w', false);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeHost.all[0]!.sent.some((m) => (m as { kind?: string }).kind === 'quit')).toBe(true);
    FakeHost.all[0]!.crash(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.statusOf('a')).toBe('parked');
  });

  it('refuses to open another when every host is busy, and kills nothing', () => {
    const { supervisor, ready } = setup({ maxLive: 1 });
    supervisor.open('a', '/w', false);
    ready(FakeHost.all[0]!, 'a');
    FakeHost.all[0]!.say({ v: 1, kind: 'status', status: 'running', services: 0 });
    const result = supervisor.open('b', '/w', false);
    expect(result).toMatchObject({ ok: false, code: 'all_busy' });
    expect(FakeHost.all).toHaveLength(1);
    expect(FakeHost.all[0]!.killed).toBe(false);
  });
});

describe('crash recovery', () => {
  it('restarts with backoff from the checkpoint and gives up after the ceiling', async () => {
    // A host that dies BEFORE saying `ready` is a boot loop: only then can the budget run out
    // (a host that comes up resets it - see the next case).
    const { supervisor, statuses } = setup();
    supervisor.open('s1', '/w', false);
    for (let attempt = 0; attempt < MAX_AUTO_RESTARTS; attempt += 1) {
      const host = FakeHost.all[attempt]!;
      host.crash(1);
      await vi.advanceTimersByTimeAsync(RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)]!);
      expect(FakeHost.all[attempt + 1]?.init?.resume, `restart ${attempt + 1} resumes from the checkpoint`).toBe(true);
    }
    FakeHost.all[MAX_AUTO_RESTARTS]!.crash(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeHost.all).toHaveLength(MAX_AUTO_RESTARTS + 1);
    expect(supervisor.statusOf('s1')).toBe('failed');
    expect(statuses.filter((entry) => entry.endsWith(':crashed'))).toHaveLength(MAX_AUTO_RESTARTS);
  });

  it('a successful start resets the restart budget', async () => {
    const { supervisor, ready } = setup();
    supervisor.open('s1', '/w', false);
    for (let round = 0; round < MAX_AUTO_RESTARTS + 2; round += 1) {
      const host = FakeHost.all[round]!;
      ready(host, 's1');
      host.crash(1);
      await vi.advanceTimersByTimeAsync(RESTART_BACKOFF_MS[0]!);
    }
    expect(FakeHost.all.length).toBeGreaterThan(MAX_AUTO_RESTARTS + 1);
  });

  it('does not restart a host that reported a fatal boot error', async () => {
    const { supervisor } = setup();
    supervisor.open('s1', '/w', false);
    const host = FakeHost.all[0]!;
    host.say({ v: 1, kind: 'fatal', code: 'home_mismatch', message: 'wrong home' });
    host.crash(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeHost.all).toHaveLength(1);
    expect(supervisor.statusOf('s1')).toBe('failed');
  });
});

describe('heartbeat', () => {
  it('marks a silent host unresponsive, never kills it, and recovers on the next pong', () => {
    const { supervisor, ready } = setup();
    supervisor.open('s1', '/w', false);
    const host = FakeHost.all[0]!;
    ready(host, 's1');
    for (let tick = 0; tick <= HEARTBEAT_MISSES + 1; tick += 1) supervisor.beat();
    expect(supervisor.statusOf('s1')).toBe('unresponsive');
    expect(host.killed).toBe(false);
    host.say({ v: 1, kind: 'pong', descendants: [] });
    expect(supervisor.statusOf('s1')).toBe('ready');
  });
});

describe('orphan reaping', () => {
  it('kills the descendants a dead host reported - but only if the pid is still the same process', async () => {
    const { supervisor, ready, killed, alive } = setup();
    supervisor.open('s1', '/w', false);
    const host = FakeHost.all[0]!;
    ready(host, 's1');
    alive.set(4001, 50_000); // still the shell the host started
    alive.set(4002, 99_000); // pid recycled by an unrelated program (different start time)
    host.say({ v: 1, kind: 'pong', descendants: [{ pid: 4001, startedAt: 50_000 }, { pid: 4002, startedAt: 50_000 }, { pid: 4003, startedAt: 1 }] });
    host.crash(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(killed).toContain(4001);
    expect(killed).not.toContain(4002); // recycled pid: leave it strictly alone
    expect(killed).not.toContain(4003); // already gone
  });
});

describe('shutdown', () => {
  it('asks hosts to flush and exit, then force-kills the tree of one that ignores it', async () => {
    const { supervisor, ready, killed } = setup();
    supervisor.open('s1', '/w', false);
    const host = FakeHost.all[0]!;
    ready(host, 's1');
    const done = supervisor.shutdown();
    expect(host.sent.some((m) => (m as { kind?: string; flush?: boolean }).kind === 'quit' && (m as { flush?: boolean }).flush === true)).toBe(true);
    await vi.advanceTimersByTimeAsync(QUIT_GRACE_MS + 10);
    await done;
    expect(killed).toContain(host.pid);
  });

  it('close() forgets the session and parks nothing', async () => {
    const { supervisor, ready } = setup();
    supervisor.open('s1', '/w', false);
    const host = FakeHost.all[0]!;
    ready(host, 's1');
    const closing = supervisor.close('s1');
    host.crash(0);
    await closing;
    expect(supervisor.statusOf('s1')).toBeNull();
  });
});

describe('services accounting', () => {
  it('sums background services across live hosts for the quit dialog', () => {
    const { supervisor, ready } = setup();
    supervisor.open('a', '/w', false);
    supervisor.open('b', '/w', false);
    ready(FakeHost.all[0]!, 'a');
    ready(FakeHost.all[1]!, 'b');
    FakeHost.all[0]!.say({ v: 1, kind: 'status', status: 'idle', services: 2 });
    FakeHost.all[1]!.say({ v: 1, kind: 'status', status: 'running', services: 1 });
    expect(supervisor.liveServiceCount()).toBe(3);
    expect(supervisor.runningIds()).toEqual(['b']);
  });
});

describe('sleep and wake (AC-76)', () => {
  const HOURS = 60 * 60 * 1000;
  const parkedAfter15Min = { parkAfterMs: 15 * 60_000 };
  const isParking = (host: FakeHost): boolean => host.sent.some((m) => (m as { kind?: string }).kind === 'quit');

  it('BASELINE: the idle clock is wall-clock, so a first tick after a long gap would park an idle session', () => {
    const { supervisor, ready } = setup(parkedAfter15Min);
    supervisor.open('s1', '/w', false);
    ready(FakeHost.all[0]!, 's1');
    vi.setSystemTime(Date.now() + 2 * HOURS);
    supervisor.beat(); // no tick history to tell this apart from "2 hours of genuine idleness"
    expect(isParking(FakeHost.all[0]!)).toBe(true);
  });

  it('a tick after a frozen timer (sleep) parks nothing and counts no miss, but probes the host', () => {
    const { supervisor, ready } = setup(parkedAfter15Min);
    supervisor.open('s1', '/w', false);
    const host = FakeHost.all[0]!;
    ready(host, 's1');
    supervisor.beat(); // normal tick: records the time
    const pingsBefore = host.sent.filter((m) => (m as { kind?: string }).kind === 'ping').length;
    vi.setSystemTime(Date.now() + 2 * HOURS); // the machine slept
    supervisor.beat();
    expect(isParking(host)).toBe(false);
    expect(host.sent.filter((m) => (m as { kind?: string }).kind === 'ping').length).toBe(pingsBefore + 1);
    expect(supervisor.statusOf('s1')).toBe('ready');
    // and the idle clock was restarted, so the NEXT normal tick does not park it either
    vi.setSystemTime(Date.now() + 2000);
    supervisor.beat();
    expect(isParking(host)).toBe(false);
  });

  it('single tick adds at most one miss: a host needs the normal number of silent ticks to go unresponsive', () => {
    const { supervisor, ready } = setup();
    supervisor.open('s1', '/w', false);
    ready(FakeHost.all[0]!, 's1');
    supervisor.beat();
    vi.setSystemTime(Date.now() + 2 * HOURS);
    supervisor.beat(); // frozen tick
    expect(supervisor.statusOf('s1')).toBe('ready');
    // one miss was counted by the first tick; the frozen tick added none, so HEARTBEAT_MISSES - 1 more are tolerated
    for (let tick = 0; tick < HEARTBEAT_MISSES - 1; tick += 1) {
      vi.setSystemTime(Date.now() + 2000);
      supervisor.beat();
    }
    expect(supervisor.statusOf('s1')).toBe('ready');
    vi.setSystemTime(Date.now() + 2000);
    supervisor.beat();
    expect(supervisor.statusOf('s1')).toBe('unresponsive');
  });

  it('does not hide a real failure: a host that never answers is still marked unresponsive after waking', () => {
    const { supervisor, ready } = setup();
    supervisor.open('s1', '/w', false);
    ready(FakeHost.all[0]!, 's1');
    supervisor.beat();
    vi.setSystemTime(Date.now() + 2 * HOURS);
    supervisor.noteResume();
    for (let tick = 0; tick <= HEARTBEAT_MISSES + 1; tick += 1) {
      vi.setSystemTime(Date.now() + 2000);
      supervisor.beat();
    }
    expect(supervisor.statusOf('s1')).toBe('unresponsive');
  });

  it('noteResume clears a heartbeat-set unresponsive state, restarts the idle clock and pings now', () => {
    const { supervisor, ready, statuses } = setup(parkedAfter15Min);
    supervisor.open('s1', '/w', false);
    const host = FakeHost.all[0]!;
    ready(host, 's1');
    for (let tick = 0; tick <= HEARTBEAT_MISSES + 1; tick += 1) supervisor.beat();
    expect(supervisor.statusOf('s1')).toBe('unresponsive');
    const pings = host.sent.filter((m) => (m as { kind?: string }).kind === 'ping').length;
    vi.setSystemTime(Date.now() + 2 * HOURS);
    supervisor.noteResume();
    expect(supervisor.statusOf('s1')).toBe('ready');
    expect(statuses.at(-1)).toBe('s1:ready');
    expect(host.sent.filter((m) => (m as { kind?: string }).kind === 'ping').length).toBe(pings + 1);
    supervisor.beat();
    expect(isParking(host)).toBe(false);
  });
});
