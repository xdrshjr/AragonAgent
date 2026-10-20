/**
 * The bounded wait primitive (long-task-jobs §4.4.1).
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope.
 *
 * A FREE FUNCTION OVER THREE PORT METHODS, NOT A METHOD ON THE PORT (D-9).
 * `Pick<ProcSupervisorPort, 'get' | 'read' | 'subscribe'>` is enough to answer
 * "has it finished yet, and what did it print since my cursor", so no test double
 * has to grow a `wait()` and the registry keeps owning exactly what it owns.
 *
 * FOUR RULES, and each one closes a way this turns into a hang:
 *
 *  1. TERMINAL FIRST, SUBSCRIBE SECOND. A job that already ended resolves
 *     synchronously with `waitedMs: 0` and registers nothing - no listener, no
 *     timer. `runBackground` carries the same defence for the same reason: a
 *     1 ms crash is not hypothetical.
 *  2. EVERY TIMER IS `unref`ed AND EVERY LISTENER IS REMOVED at every exit. A
 *     wait that leaks a timer is a process that will not exit, which is the
 *     failure mode this feature exists to remove.
 *  3. ONE IDEMPOTENT `finish` FUNNEL. Terminal event, timeout and abort race, and
 *     exactly one of them may win.
 *  4. IT DOES NOT DEPEND ON A SINGLE WAKE SOURCE. `reapSync()` used to emit
 *     nothing at all (the supervisor now emits `stopped` from it), and
 *     `dispose()` clears its listener set without emitting; the self-timeout is
 *     therefore a real second path, not belt-and-braces.
 */

import type {
  ProcSupervisorPort,
  ServiceLogPage,
  ServiceSnapshot,
} from './types.js';
import { isTerminalStatus } from './types.js';

/** The port surface this module needs. Deliberately narrower than the full port. */
export type WaitPort = Pick<ProcSupervisorPort, 'get' | 'read' | 'subscribe'>;

export interface WaitForJobsRequest {
  /** Ids already resolved by the caller. An empty list returns immediately. */
  targets: readonly string[];
  /** Already clamped by the caller (`jobs.waitSeconds`, I-4 and `WAIT_SECONDS_RANGE`). */
  timeoutMs: number;
  /** The tool call's `ctx.signal`. Aborting resolves the wait with `aborted: true`. */
  signal?: AbortSignal;
  /** Cursor from a previous `job_wait` / `bash_output`; omit for the whole tail. */
  since?: number;
}

export interface JobWaitOutcome {
  /** One snapshot per target that still exists, in the requested order. */
  jobs: ServiceSnapshot[];
  /** Every target reached a terminal status. */
  terminal: boolean;
  waitedMs: number;
  timedOut: boolean;
  aborted: boolean;
  /** Incremental page per target, read at settle time. */
  pages: ReadonlyMap<string, ServiceLogPage>;
}

/** Read one bounded page per target; `read()` returns `undefined` for a vanished id. */
function readPages(
  port: WaitPort,
  targets: readonly string[],
  since: number | undefined,
): ReadonlyMap<string, ServiceLogPage> {
  const pages = new Map<string, ServiceLogPage>();
  for (const id of targets) {
    const page = port.read(id, since);
    if (page) pages.set(id, page);
  }
  return pages;
}

/**
 * Does every target exist and sit in a terminal state?
 *
 * AN UNKNOWN ID COUNTS AS SETTLED. The supervisor evicts terminal records, so a
 * job whose outcome the caller is asking about may have been reclaimed; waiting
 * for it would burn the whole timeout to learn nothing. The caller distinguishes
 * the two cases from `jobs.length` and the supervisor's own ledger.
 */
function allSettled(port: WaitPort, targets: readonly string[]): boolean {
  return targets.every((id) => {
    const snapshot = port.get(id);
    return snapshot === undefined || isTerminalStatus(snapshot.status);
  });
}

/**
 * Wait up to `timeoutMs` for every target to reach a terminal status.
 *
 * Resolves - never rejects - and always after at most `timeoutMs`. `now` is
 * injectable so a test can assert `waitedMs` without depending on wall clock.
 */
export async function waitForJob(
  port: WaitPort,
  req: WaitForJobsRequest,
  now: () => number = Date.now,
): Promise<JobWaitOutcome> {
  const { targets, signal } = req;
  const startedAt = now();

  // RULE 1. Nothing to wait for at all, or everything already ended: no
  // subscription, no timer, `waitedMs: 0`.
  if (targets.length === 0 || allSettled(port, targets)) {
    return {
      jobs: collect(port, targets),
      terminal: true,
      waitedMs: 0,
      timedOut: false,
      aborted: false,
      pages: readPages(port, targets, req.since),
    };
  }

  return new Promise<JobWaitOutcome>((resolve) => {
    let done = false;
    // DECLARED BEFORE `finish` SO THE FUNNEL CANNOT READ A HALF-INITIALISED BINDING.
    // `port.subscribe()` is free to call its listener synchronously (a test double
    // is the obvious case), and a `finish` that closed over a `const` assigned
    // later in the same block would then throw a temporal-dead-zone ReferenceError
    // from inside the listener instead of resolving the wait.
    let unsubscribe: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Assigned below; declared here so `finish` never reads an uninitialised binding. */
    let onAbort: () => void = () => {};
    // RULE 3: the one funnel. Idempotent, and it releases every reference before
    // resolving so a finished wait cannot hold the event loop open.
    const finish = (reason: 'terminal' | 'timeout' | 'abort'): void => {
      if (done) return;
      done = true;
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        jobs: collect(port, targets),
        terminal: reason === 'terminal' || allSettled(port, targets),
        waitedMs: now() - startedAt,
        timedOut: reason === 'timeout',
        aborted: reason === 'abort',
        pages: readPages(port, targets, req.since),
      });
    };

    unsubscribe = port.subscribe((event) => {
      if (!isTerminalStatus(event.service.status)) return;
      if (!targets.includes(event.service.id)) return;
      if (allSettled(port, targets)) finish('terminal');
    });

    // RULE 2: `unref`, so a pending wait never keeps a quitting process alive.
    timer = setTimeout(() => finish('timeout'), Math.max(0, req.timeoutMs));
    timer.unref?.();

    onAbort = (): void => finish('abort');
    // `{ once: true }` AND the explicit removal in `finish`: the option alone
    // leaves the listener registered on a signal that outlives this wait.
    if (signal?.aborted === true) {
      finish('abort');
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Snapshots for the targets that still exist, in the requested order. */
function collect(port: WaitPort, targets: readonly string[]): ServiceSnapshot[] {
  const jobs: ServiceSnapshot[] = [];
  for (const id of targets) {
    const snapshot = port.get(id);
    if (snapshot) jobs.push(snapshot);
  }
  return jobs;
}
