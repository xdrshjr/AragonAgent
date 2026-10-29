/**
 * The pool of session hosts: one `utilityProcess` per live session (spec 3.6).
 *
 * WHAT IS HERE: lifecycle (`starting -> ready -> running -> parked`), the live-host cap with
 * idle parking, a 2 s heartbeat that marks a silent host `unresponsive` (never kills it - it
 * might be mid-compaction), automatic restart after a crash with backoff and a retry ceiling,
 * and process-tree cleanup so a quit or a crash leaves no orphan shell behind.
 *
 * WHAT IS NOT: Electron. A `HostLauncher` is injected, so every transition below is exercised
 * in unit tests with a scripted fake host. The Electron launcher is `electron-launcher.ts`.
 *
 * ORPHANS ON WINDOWS. `child.kill()` ends only the host itself; a `bash`, a background
 * service or a team sub-agent it started keeps running, and once the host is dead its
 * descendants' parent links are gone, so a tree kill has nothing to walk. The host therefore
 * puts its descendant pids (with creation times) in every `pong`; this class remembers the
 * latest list and, when a host dies, kills each entry - but only after the creation time still
 * matches, so a recycled pid can never take out an unrelated program.
 */

import type { HostControlMsg, HostInit, MainControlMsg, SessionRunStatus } from '../shared/port-protocol.js';
import type { SessionHostStatus } from '../shared/ipc-contract.js';

export interface HostProcess {
  readonly pid: number | undefined;
  postMessage(message: MainControlMsg | HostInit | { v: 1; kind: 'port' }, transfer?: unknown[]): void;
  on(event: 'message', listener: (message: HostControlMsg) => void): void;
  on(event: 'exit', listener: (code: number | null) => void): void;
  kill(): boolean;
}

export interface HostLauncher {
  fork(): HostProcess;
}

export interface ProcessReaper {
  /** Kill a pid and everything under it. Resolves when done; never throws. */
  killTree(pid: number): Promise<void>;
  /** Creation time (epoch ms) of a live pid, or null when it is gone. */
  startedAt(pid: number): number | null;
}

export interface SessionSupervisorOptions {
  launcher: HostLauncher;
  reaper: ProcessReaper;
  homeRoot: string;
  maxLiveHosts: () => number;
  parkAfterIdleMs: () => number;
  onStatus(id: string, status: SessionHostStatus, detail?: string): void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  setIntervalFn?: typeof setInterval;
  clearTimer?: typeof clearTimeout;
  clearIntervalFn?: typeof clearInterval;
}

export const HEARTBEAT_MS = 2000;
/** A tick later than this many heartbeat periods means the timer was frozen, not that hosts hung. */
export const FROZEN_TICK_FACTOR = 3;
export const HEARTBEAT_MISSES = 3;
export const RESTART_BACKOFF_MS = [500, 2000, 8000] as const;
export const MAX_AUTO_RESTARTS = 3;
export const QUIT_GRACE_MS = 3000;

interface Descendant { pid: number; startedAt: number }

interface Entry {
  id: string;
  cwd: string;
  proc: HostProcess | null;
  status: SessionHostStatus;
  runStatus: SessionRunStatus;
  services: number;
  restarts: number;
  lastActiveAt: number;
  misses: number;
  descendants: Descendant[];
  epoch: number;
  resume: boolean;
  intentionalStop: boolean;
  restartTimer: ReturnType<typeof setTimeout> | null;
  attached: boolean;
}

export type OpenResult =
  | { ok: true; id: string }
  | { ok: false; code: 'all_busy' | 'spawn_failed'; message: string };

export class SessionSupervisor {
  private readonly entries = new Map<string, Entry>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private epochCounter = 0;
  private readonly now: () => number;

  constructor(private readonly options: SessionSupervisorOptions) {
    this.now = options.now ?? Date.now;
  }

  /** pids of every host we own, so the lock probe can tell "ours" from "the terminal's". */
  ownPids(): number[] {
    return [...this.entries.values()].flatMap((entry) => (entry.proc?.pid ? [entry.proc.pid] : []));
  }

  /** Send a control message to every running host (config changed, ...). */
  broadcast(message: MainControlMsg): void {
    for (const entry of this.entries.values()) entry.proc?.postMessage(message);
  }

  /** Background services alive across all hosts (the quit dialog asks about them). */
  liveServiceCount(): number {
    return [...this.entries.values()].reduce((sum, entry) => sum + (entry.proc ? entry.services : 0), 0);
  }

  statusOf(id: string): SessionHostStatus | null {
    return this.entries.get(id)?.status ?? null;
  }

  runningIds(): string[] {
    return [...this.entries.values()].filter((entry) => entry.runStatus === 'running' || entry.runStatus === 'waiting-approval').map((entry) => entry.id);
  }

  /** Start (or reuse) the host for a session. May park the least recently used idle one. */
  open(id: string, cwd: string, resume: boolean): OpenResult {
    const existing = this.entries.get(id);
    if (existing?.proc) {
      existing.lastActiveAt = this.now();
      return { ok: true, id };
    }
    const room = this.makeRoom(id);
    if (!room.ok) return room;
    const entry: Entry = existing ?? {
      id, cwd, proc: null, status: 'starting', runStatus: 'starting', services: 0, restarts: 0, lastActiveAt: this.now(),
      misses: 0, descendants: [], epoch: 0, resume, intentionalStop: false, restartTimer: null, attached: false,
    };
    entry.cwd = cwd;
    entry.resume = resume;
    this.entries.set(id, entry);
    return this.spawn(entry);
  }

  private makeRoom(incoming: string): { ok: true } | { ok: false; code: 'all_busy'; message: string } {
    const live = [...this.entries.values()].filter((entry) => entry.proc && entry.id !== incoming);
    if (live.length < this.options.maxLiveHosts()) return { ok: true };
    const idle = live
      .filter((entry) => entry.runStatus === 'idle' || entry.runStatus === 'ready')
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
    if (!idle) {
      return { ok: false, code: 'all_busy', message: 'Every open session is busy; stop one before opening another.' };
    }
    void this.park(idle.id);
    return { ok: true };
  }

  private spawn(entry: Entry): OpenResult {
    let proc: HostProcess;
    try {
      proc = this.options.launcher.fork();
    } catch (error) {
      this.setStatus(entry, 'failed', error instanceof Error ? error.message : String(error));
      return { ok: false, code: 'spawn_failed', message: 'The session host could not be started.' };
    }
    entry.proc = proc;
    entry.intentionalStop = false;
    entry.misses = 0;
    entry.epoch = ++this.epochCounter;
    this.setStatus(entry, 'starting');
    proc.on('message', (message) => this.onMessage(entry, proc, message));
    proc.on('exit', (code) => this.onExit(entry, proc, code));
    proc.postMessage({
      v: 1, kind: 'init', sessionId: entry.id, cwd: entry.cwd, homeRoot: this.options.homeRoot,
      epoch: entry.epoch, resume: entry.resume,
    });
    this.ensureHeartbeat();
    return { ok: true, id: entry.id };
  }

  /** The host process for a session, for the channel factory. */
  processOf(id: string): HostProcess | null {
    return this.entries.get(id)?.proc ?? null;
  }

  epochOf(id: string): number {
    return this.entries.get(id)?.epoch ?? 0;
  }

  setAttached(id: string, attached: boolean): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.attached = attached;
    entry.proc?.postMessage({ v: 1, kind: 'attached', attached });
  }

  touch(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.lastActiveAt = this.now();
  }

  private onMessage(entry: Entry, proc: HostProcess, message: HostControlMsg): void {
    if (entry.proc !== proc) return; // a message from a host we already replaced
    switch (message.kind) {
      case 'ready':
        this.setStatus(entry, 'ready');
        entry.runStatus = 'ready';
        entry.restarts = 0;
        break;
      case 'status': {
        entry.runStatus = message.status;
        entry.services = message.services;
        entry.lastActiveAt = this.now();
        const next: SessionHostStatus =
          message.status === 'running' ? 'running'
            : message.status === 'waiting-approval' ? 'waiting-approval' : 'ready';
        this.setStatus(entry, next);
        break;
      }
      case 'pong':
        entry.misses = 0;
        entry.descendants = message.descendants;
        if (entry.status === 'unresponsive') this.setStatus(entry, entry.runStatus === 'running' ? 'running' : 'ready');
        break;
      case 'fatal':
        entry.intentionalStop = true; // a host that reports fatal must not be restarted into the same failure
        this.setStatus(entry, 'failed', message.message);
        void this.reapAndKill(entry, proc);
        break;
    }
  }

  private onExit(entry: Entry, proc: HostProcess, _code: number | null): void {
    if (entry.proc !== proc) return;
    const wasIntentional = entry.intentionalStop;
    const descendants = entry.descendants;
    entry.proc = null;
    entry.descendants = [];
    void this.reapDescendants(descendants);
    if (wasIntentional) return;
    if (entry.restarts >= MAX_AUTO_RESTARTS) {
      this.setStatus(entry, 'failed', 'The session host kept crashing.');
      return;
    }
    const delay = RESTART_BACKOFF_MS[Math.min(entry.restarts, RESTART_BACKOFF_MS.length - 1)]!;
    entry.restarts += 1;
    entry.resume = true; // a crashed session is restored from its last checkpoint
    this.setStatus(entry, 'crashed', `Restarting (attempt ${entry.restarts} of ${MAX_AUTO_RESTARTS})`);
    entry.restartTimer = (this.options.setTimer ?? setTimeout)(() => {
      entry.restartTimer = null;
      if (this.entries.get(entry.id) === entry && !entry.proc) this.spawn(entry);
    }, delay);
  }

  /** Stop a host, flushing its checkpoint first, and keep the entry as "parked". */
  async park(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry?.proc) return false;
    entry.resume = true;
    await this.stopProcess(entry, true);
    this.setStatus(entry, 'parked');
    return true;
  }

  /** Stop a host and forget the session. */
  async close(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.restartTimer) (this.options.clearTimer ?? clearTimeout)(entry.restartTimer);
    await this.stopProcess(entry, true);
    this.entries.delete(id);
    return true;
  }

  /** Manual restart (the "Force restart" button on an unresponsive session). */
  async restart(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.restarts = 0;
    entry.resume = true;
    if (entry.proc) await this.stopProcess(entry, false);
    return this.spawn(entry).ok;
  }

  private async stopProcess(entry: Entry, flush: boolean): Promise<void> {
    const proc = entry.proc;
    if (!proc) return;
    entry.intentionalStop = true;
    const descendants = entry.descendants;
    const exited = new Promise<void>((resolve) => {
      proc.on('exit', () => resolve());
    });
    proc.postMessage({ v: 1, kind: 'quit', flush });
    const timeout = new Promise<void>((resolve) => {
      (this.options.setTimer ?? setTimeout)(resolve, QUIT_GRACE_MS);
    });
    await Promise.race([exited, timeout]);
    if (entry.proc === proc) {
      await this.reapAndKill(entry, proc);
    }
    await this.reapDescendants(descendants);
  }

  private async reapAndKill(entry: Entry, proc: HostProcess): Promise<void> {
    const pid = proc.pid;
    if (pid !== undefined) await this.options.reaper.killTree(pid);
    try { proc.kill(); } catch { /* already gone */ }
    if (entry.proc === proc) {
      entry.descendants = [];
      entry.proc = null;
    }
  }

  private async reapDescendants(list: Descendant[]): Promise<void> {
    for (const { pid, startedAt } of list) {
      const actual = this.options.reaper.startedAt(pid);
      // Gone, or the pid now belongs to a different process: leave it strictly alone.
      if (actual === null || Math.abs(actual - startedAt) > 2000) continue;
      await this.options.reaper.killTree(pid);
    }
  }

  /** Quit sequence: ask every host to flush and exit, then reap what is left. */
  async shutdown(): Promise<void> {
    if (this.heartbeat) (this.options.clearIntervalFn ?? clearInterval)(this.heartbeat);
    this.heartbeat = null;
    await Promise.all([...this.entries.values()].map((entry) => this.stopProcess(entry, true)));
    this.entries.clear();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = (this.options.setIntervalFn ?? setInterval)(() => this.beat(), HEARTBEAT_MS);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }

  private lastTickAt: number | null = null;

  /**
   * The machine woke from sleep (or the timer was frozen). The idle clock is wall-clock, so without
   * this the first tick after a long sleep would park EVERY idle session at once. Reset the clocks and
   * ping now: a host that really died still goes `unresponsive` after the normal number of ticks,
   * so a wake-up neither invents a failure nor hides a real one.
   */
  noteResume(): void {
    const at = this.now();
    this.lastTickAt = at;
    for (const entry of this.entries.values()) {
      if (!entry.proc) continue;
      entry.misses = 0;
      entry.lastActiveAt = at;
      if (entry.status === 'unresponsive') {
        this.setStatus(entry, entry.runStatus === 'running' ? 'running' : 'ready');
      }
      entry.proc.postMessage({ v: 1, kind: 'ping' });
    }
  }

  /** One heartbeat tick; public so tests drive it without real timers. */
  beat(): void {
    const idleLimit = this.options.parkAfterIdleMs();
    const at = this.now();
    // A tick that arrives much later than scheduled means the timer was frozen (sleep, debugger). That
    // is not evidence about the hosts: probe once, count nothing, park nothing.
    const frozen = this.lastTickAt !== null && at - this.lastTickAt > FROZEN_TICK_FACTOR * HEARTBEAT_MS;
    this.lastTickAt = at;
    if (frozen) {
      for (const entry of this.entries.values()) {
        if (!entry.proc) continue;
        entry.lastActiveAt = at;
        entry.proc.postMessage({ v: 1, kind: 'ping' });
      }
      return;
    }
    for (const entry of this.entries.values()) {
      if (!entry.proc) continue;
      entry.misses += 1;
      if (entry.misses > HEARTBEAT_MISSES && entry.status !== 'unresponsive' && entry.status !== 'starting') {
        this.setStatus(entry, 'unresponsive');
      }
      entry.proc.postMessage({ v: 1, kind: 'ping' });
      const idle = entry.runStatus === 'idle' || entry.runStatus === 'ready';
      if (idleLimit > 0 && idle && !entry.attached && at - entry.lastActiveAt > idleLimit) {
        void this.park(entry.id);
      }
    }
  }

  private setStatus(entry: Entry, status: SessionHostStatus, detail?: string): void {
    entry.status = status;
    this.options.onStatus(entry.id, status, detail);
  }
}
