/**
 * ProcSupervisor — the owner of every child process this session spawned
 * (background-service-supervision §3.3 / §3.5 / §3.6).
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope.
 *
 * ONE REGISTRY, TWO LIFETIMES (I-4). Foreground `bash` children are tracked so
 * `forceStop()` can reach them; background services are tracked so `Ctrl+C`,
 * `bash_kill` and process exit can reach them. Splitting those into two
 * registries is how a force-stop ends up killing the user's dev server, or how a
 * quit leaves it running. They are two collections in ONE object, and the two
 * kill entry points are named for which one they own.
 *
 * CONSTRUCTED UNCONDITIONALLY (P1-6 / D-9). `cfg.bash.background` gates the
 * SERVICE half — the `background` tool param, `bash_output`/`bash_kill`, the
 * prompt block, the status chip — and never the foreground half, because G2
 * ("bash always settles") and G3 ("Esc, Esc always works") are promised
 * unconditionally. With the flag off this object holds foreground pids, nothing
 * else, and allocates no timers.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';
import type { ChildProcess } from 'node:child_process';
import { getLogger } from '../logging/logger.js';
import { extractPortHint } from './classify.js';
import { isAlive, killTree, killTreeSync } from './kill-tree.js';
import { PROC_LIMITS } from './limits.js';
import { LogRing } from './log-ring.js';
import { probePort, ReadinessWatcher } from './readiness.js';
import {
  isTerminalStatus,
  type ProcEvent,
  type ProcEventListener,
  type ProcSupervisorPort,
  type ServiceLogPage,
  type ServiceRecord,
  type ServiceSnapshot,
  type ServiceStartRequest,
  type ServiceStartResult,
} from './types.js';

export interface ProcSupervisorOptions {
  /** `cfg.bash.readyTimeoutMs`, read once per service at spawn. */
  readyTimeoutMs: () => number;
  /** Injected by the tests; production uses a real TCP connect. */
  probe?: (port: number) => Promise<boolean>;
}

interface ServiceEntry {
  record: ServiceRecord;
  child: ChildProcess | undefined;
  ring: LogRing;
  watcher: ReadinessWatcher | undefined;
  /** Coalescing timer for `output` events. */
  outputTimer: ReturnType<typeof setTimeout> | undefined;
  /** Resolvers waiting on `stop()`. */
  waiters: Array<() => void>;
  /** Escalation timer for the `SIGTERM` -> `SIGKILL` ladder. */
  escalation: ReturnType<typeof setTimeout> | undefined;
  /**
   * WE asked for this to end (`Ctrl+C`, `bash_kill`, `/bg stop`, the reaper).
   *
   * INTENT, RECORDED BEFORE THE KILL, because the terminal status cannot be
   * decided by WHICH `'exit'` listener happens to run first. `start()` registers
   * its handler before `stop()` can register anything, so a kill that works
   * promptly - every POSIX `SIGTERM`, and any Windows `taskkill` that lands
   * inside the settle window - would otherwise be reported as `exited` with
   * `[signal SIGTERM]` or `code 1`: a card in the ERROR colour, and a
   * `bash_kill` result telling the model the service crashed, for a stop the
   * user asked for.
   */
  stopRequested: boolean;
}

export class ProcSupervisor implements ProcSupervisorPort {
  private readonly services = new Map<string, ServiceEntry>();
  /**
   * Live FOREGROUND `bash` children, by pid.
   *
   * A `Set` of pids rather than of `ChildProcess` objects: the only thing
   * `killForeground` needs is the number, and holding the object would keep a
   * reference to a settled child's stdio for the life of the session.
   */
  private readonly foreground = new Set<number>();
  private readonly listeners = new Set<ProcEventListener>();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly opts: ProcSupervisorOptions) {}

  // -----------------------------------------------------------------------
  // Foreground children (unconditional; see the class comment)
  // -----------------------------------------------------------------------

  trackForeground(pid: number | undefined): () => void {
    if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return () => {};
    this.foreground.add(pid);
    return () => {
      this.foreground.delete(pid);
    };
  }

  /**
   * Hard-kill every tracked foreground child. Returns how many were signalled.
   *
   * THIS IS WHAT ACTUALLY UNBLOCKS A WEDGED `await tool.execute` on rung two of
   * the Esc ladder. It NEVER touches services: `Esc` interrupts the AGENT,
   * `Ctrl+C` stops the SERVICES, and that asymmetry is the user's own two
   * sentences (I-4). A later reader will want to "fix" this by making it kill
   * everything; that is the bug, not the fix.
   */
  killForeground(_reason: 'force'): number {
    let n = 0;
    for (const pid of [...this.foreground]) {
      killTree(pid, 'SIGKILL');
      this.foreground.delete(pid);
      n += 1;
    }
    return n;
  }

  // -----------------------------------------------------------------------
  // Services
  // -----------------------------------------------------------------------

  async start(req: ServiceStartRequest): Promise<ServiceStartResult> {
    if (this.disposed) return { ok: false, error: 'The process supervisor is shut down.' };

    this.evictTerminal();
    if (this.services.size >= PROC_LIMITS.maxServices) {
      // NO EVICTION AND NO SILENT FOREGROUNDING (P2-8). Every record is live, so
      // dropping the oldest would orphan a running server that nothing can any
      // longer name or stop. Naming the ids is what makes the error actionable.
      const live = [...this.services.values()]
        .filter((e) => !isTerminalStatus(e.record.status))
        .slice(0, 4)
        .map((e) => e.record.id)
        .join(', ');
      return {
        ok: false,
        error:
          `Too many background services (${PROC_LIMITS.maxServices}). ` +
          `Stop one first with bash_kill({ service: "<id>" }) - oldest live: ${live}.`,
      };
    }

    const id = `s${this.nextId}`;
    this.nextId += 1;

    // THE PRE-FLIGHT PROBE RUNS BEFORE THE SPAWN (R-3). An unrelated process
    // already answering on 3000 would otherwise make every launch instantly and
    // falsely ready; finding it there disables the probe detector for this
    // service and annotates the card, leaving the URL detector to do the work.
    const hint = extractPortHint(req.command);
    const preoccupied =
      hint === undefined ? false : await (this.opts.probe ?? probePort)(hint).catch(() => false);

    const ring = new LogRing();
    const record: ServiceRecord = {
      id,
      toolCallId: req.toolCallId,
      command: req.command,
      cwd: req.cwd,
      pid: undefined,
      status: 'starting',
      startedAt: Date.now(),
      exitCode: null,
      signal: null,
      rows: [],
      rowsSeen: 0,
      truncated: false,
      ...(hint !== undefined ? { port: hint } : {}),
      ...(preoccupied ? { portPreoccupied: true } : {}),
    };
    const entry: ServiceEntry = {
      record,
      child: undefined,
      ring,
      watcher: undefined,
      outputTimer: undefined,
      waiters: [],
      escalation: undefined,
      stopRequested: false,
    };
    this.services.set(id, entry);

    let child: ChildProcess;
    try {
      child = spawn(req.command, {
        shell: true,
        cwd: req.cwd,
        env: process.env,
        windowsHide: true,
        // W1.2, one level down: a service that prompts on stdin must fail rather
        // than block on a read nobody will ever satisfy.
        stdio: ['ignore', 'pipe', 'pipe'],
        // NOT `false`. On POSIX this makes the child a process-group leader, so
        // `process.kill(-pid, sig)` reaches the whole tree; with `detached:
        // false` the child shares THIS process's group and there is no group to
        // signal, which is why today's foreground killTree only ever kills the
        // shell and lets every `npm run dev` grandchild survive. On Windows the
        // flag is irrelevant to reaping - `taskkill /t` walks the parent-child
        // table - so it is off there to avoid detaching a console.
        //
        // IT DOES NOT MEAN "SURVIVES US": `child.unref()` is deliberately NEVER
        // called, and both reapers signal the group. It buys the group and
        // nothing else (D-13).
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      record.status = 'failed';
      record.endedAt = Date.now();
      this.emit({ type: 'exited', service: this.snapshot(entry) });
      return {
        ok: false,
        error: `Failed to start background service: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    entry.child = child;
    record.pid = child.pid;

    const onChunk = (chunk: Buffer | string): void => {
      const rows = ring.append(typeof chunk === 'string' ? chunk : chunk.toString());
      record.rowsSeen = ring.rowsSeen;
      record.truncated = ring.truncated;
      record.rows = ring.tail(PROC_LIMITS.cardTailRows);
      if (rows.length > 0) entry.watcher?.offerRows(rows);
      this.scheduleOutput(entry);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('error', (err) => {
      if (isTerminalStatus(record.status)) return;
      record.status = 'failed';
      record.endedAt = Date.now();
      ring.append(`\n${err.message}\n`);
      record.rows = ring.tail(PROC_LIMITS.cardTailRows);
      record.rowsSeen = ring.rowsSeen;
      this.finish(entry, 'exited');
    });

    // SETTLED ON `exit`, NOT ON `close`, for the reason defence 1 exists: a
    // detached grandchild holding the pipe open would otherwise keep a dead
    // service showing as `starting` for the rest of the session.
    child.on('exit', (code, signalName) => {
      if (isTerminalStatus(record.status)) return;
      record.exitCode = code;
      record.signal = signalName;
      // `stopped` VS `exited` IS DECIDED BY INTENT, NEVER BY ARRIVAL ORDER. The
      // exit code and signal are still recorded either way - they are evidence -
      // but a process that ended because we asked it to is `stopped`, which is
      // the status the card draws in muted rather than in the error colour.
      const asked = entry.stopRequested;
      record.status = asked ? 'stopped' : 'exited';
      record.endedAt = Date.now();
      this.finish(entry, asked ? 'stopped' : 'exited');
    });

    const watcher = new ReadinessWatcher({
      // The hint is dropped when the port was ALREADY answering: probing it
      // would report ready in the first 40 ms for somebody else's server.
      ...(hint !== undefined && !preoccupied ? { portHint: hint } : {}),
      readyTimeoutMs: this.opts.readyTimeoutMs(),
      ...(this.opts.probe ? { probe: this.opts.probe } : {}),
      onReady: (result) => {
        if (isTerminalStatus(record.status) || record.status === 'ready') return;
        record.status = 'ready';
        record.readyAt = Date.now();
        if (result.url) record.url = result.url;
        if (result.port !== undefined) record.port = result.port;
        record.detectedBy = result.detectedBy;
        this.emit({ type: 'ready', service: this.snapshot(entry) });
      },
      onTimeout: () => {
        if (isTerminalStatus(record.status) || record.status === 'ready') return;
        // AN HONEST THIRD STATE (D-4). It is alive and it listens on nothing.
        record.status = 'running';
        this.emit({ type: 'ready', service: this.snapshot(entry) });
      },
    });
    entry.watcher = watcher;
    watcher.start();

    this.emit({ type: 'started', service: this.snapshot(entry) });
    return { ok: true, service: this.snapshot(entry) };
  }

  get(id: string): ServiceSnapshot | undefined {
    const entry = this.services.get(id);
    return entry ? this.snapshot(entry) : undefined;
  }

  list(): ServiceSnapshot[] {
    return [...this.services.values()].map((e) => this.snapshot(e));
  }

  read(id: string, since?: number): ServiceLogPage | undefined {
    const entry = this.services.get(id);
    if (!entry) return undefined;
    return entry.ring.page(since);
  }

  liveCount(): number {
    let n = 0;
    for (const entry of this.services.values()) {
      if (!isTerminalStatus(entry.record.status)) n += 1;
    }
    return n;
  }

  /**
   * Stop one service, or every service.
   *
   * `SIGTERM` FIRST, `SIGKILL` AFTER `stopGraceMs` — the graceful ladder, which
   * belongs here rather than in `reapSync` because this path has a live event
   * loop to run it on. It then CHECKS `process.kill(pid, 0)` and records
   * `killIncomplete` when the pid is still there (P2-6): an honest warning beats
   * a silent leak, and `killTree` cannot know on its own whether it worked.
   */
  async stop(id: string): Promise<ServiceSnapshot[]> {
    const targets =
      id === 'all'
        ? [...this.services.values()].filter((e) => !isTerminalStatus(e.record.status))
        : (() => {
            const one = this.services.get(id);
            return one && !isTerminalStatus(one.record.status) ? [one] : [];
          })();
    if (targets.length === 0) {
      const one = this.services.get(id);
      return one ? [this.snapshot(one)] : [];
    }
    await Promise.all(targets.map((entry) => this.stopOne(entry)));
    return targets.map((entry) => this.snapshot(entry));
  }

  private stopOne(entry: ServiceEntry): Promise<void> {
    const { record } = entry;
    return new Promise<void>((resolve) => {
      if (isTerminalStatus(record.status)) {
        resolve();
        return;
      }
      entry.waiters.push(resolve);
      // BEFORE THE KILL, so the child's own `'exit'` handler - which was
      // registered first and therefore always wins - reports this as `stopped`.
      entry.stopRequested = true;
      killTree(record.pid, 'SIGTERM');
      entry.escalation = setTimeout(() => {
        if (isTerminalStatus(record.status)) return;
        killTree(record.pid, 'SIGKILL');
        // Give the SIGKILL one tick to land before declaring the outcome, then
        // settle whether or not `exit` fired: a promise that never resolves is
        // the failure this whole feature exists to remove.
        const settle = setTimeout(() => {
          if (isTerminalStatus(record.status)) return;
          record.status = 'stopped';
          record.endedAt = Date.now();
          if (isAlive(record.pid)) record.killIncomplete = true;
          this.finish(entry, 'stopped');
        }, 250);
        settle.unref?.();
      }, PROC_LIMITS.stopGraceMs);
      entry.escalation.unref?.();
      // NO SECOND `'exit'` LISTENER HERE. The one `start()` registered already
      // reads `stopRequested` and resolves every waiter through `finish`; a
      // second listener could only ever run after it and would be dead code that
      // reads as the thing deciding the status.
    });
  }

  // -----------------------------------------------------------------------
  // Exit reaping (G5 / I-9)
  // -----------------------------------------------------------------------

  /**
   * SYNCHRONOUS, TOTAL, IDEMPOTENT. The only entry point a signal hook,
   * `process.on('exit')` or `handleFatal` may call.
   *
   * No escalation ladder, no promises, no logging: a reaper that can block or
   * throw is worse than one that misses a child. It reaps FOREGROUND children
   * too, because a `bash` call in flight at quit time is a process nobody else
   * will ever kill.
   */
  reapSync(): void {
    for (const pid of [...this.foreground]) {
      killTreeSync(pid);
      this.foreground.delete(pid);
    }
    for (const entry of this.services.values()) {
      if (isTerminalStatus(entry.record.status)) continue;
      killTreeSync(entry.record.pid);
      entry.record.status = 'stopped';
      entry.record.endedAt = Date.now();
      entry.watcher?.stop();
      if (entry.outputTimer) clearTimeout(entry.outputTimer);
      if (entry.escalation) clearTimeout(entry.escalation);
      entry.outputTimer = undefined;
      entry.escalation = undefined;
      for (const wake of entry.waiters.splice(0)) wake();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.services.values()) {
      entry.watcher?.stop();
      if (entry.outputTimer) clearTimeout(entry.outputTimer);
      if (entry.escalation) clearTimeout(entry.escalation);
      entry.outputTimer = undefined;
      entry.escalation = undefined;
    }
    this.listeners.clear();
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  subscribe(listener: ProcEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * EVERY LISTENER IS WRAPPED, and that is not defensive noise (I-5). This runs
   * inside `child.stdout.on('data')`, so a throw here would kill a ten-minute
   * build because of a render bug. `debug` rather than `warn` because a listener
   * that throws once throws on every chunk — the same rule, the same reason, as
   * `AgentController.emitToolOutput`.
   */
  private emit(event: ProcEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        getLogger().debug('tool', 'proc_listener_threw', {
          type: event.type,
          service: event.service.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Coalesce `output` at the SOURCE — `/bg` and `bash_output` read it too. */
  private scheduleOutput(entry: ServiceEntry): void {
    if (entry.outputTimer) return;
    entry.outputTimer = setTimeout(() => {
      entry.outputTimer = undefined;
      this.emit({ type: 'output', service: this.snapshot(entry) });
    }, PROC_LIMITS.outputCoalesceMs);
    entry.outputTimer.unref?.();
  }

  /** Release every timer, wake every waiter, and announce the terminal state. */
  private finish(entry: ServiceEntry, type: 'exited' | 'stopped'): void {
    entry.watcher?.stop();
    if (entry.outputTimer) {
      clearTimeout(entry.outputTimer);
      entry.outputTimer = undefined;
    }
    if (entry.escalation) {
      clearTimeout(entry.escalation);
      entry.escalation = undefined;
    }
    entry.record.rows = entry.ring.tail(PROC_LIMITS.cardTailRows);
    entry.record.rowsSeen = entry.ring.rowsSeen;
    entry.record.truncated = entry.ring.truncated;
    this.emit({ type, service: this.snapshot(entry) });
    for (const wake of entry.waiters.splice(0)) wake();
  }

  /**
   * Evict TERMINAL records only, oldest first, to make room.
   *
   * IDS ARE NEVER REUSED (I-6): `nextId` only ever increases, so a stale
   * `bash_kill({ service: 's1' })` can only be a no-op and never a kill of
   * something else.
   */
  private evictTerminal(): void {
    if (this.services.size < PROC_LIMITS.maxServices) return;
    for (const [id, entry] of this.services) {
      if (this.services.size < PROC_LIMITS.maxServices) break;
      if (isTerminalStatus(entry.record.status)) this.services.delete(id);
    }
  }

  private snapshot(entry: ServiceEntry): ServiceSnapshot {
    const r = entry.record;
    return Object.freeze({
      id: r.id,
      toolCallId: r.toolCallId,
      command: r.command,
      cwd: r.cwd,
      pid: r.pid,
      status: r.status,
      startedAt: r.startedAt,
      ...(r.readyAt !== undefined ? { readyAt: r.readyAt } : {}),
      ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
      exitCode: r.exitCode,
      signal: r.signal,
      ...(r.url !== undefined ? { url: r.url } : {}),
      ...(r.port !== undefined ? { port: r.port } : {}),
      ...(r.detectedBy !== undefined ? { detectedBy: r.detectedBy } : {}),
      ...(r.portPreoccupied ? { portPreoccupied: true } : {}),
      rows: r.rows,
      rowsSeen: r.rowsSeen,
      truncated: r.truncated,
      ...(r.killIncomplete ? { killIncomplete: true } : {}),
    });
  }
}
