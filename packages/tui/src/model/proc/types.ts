/**
 * Runtime shapes for the process supervisor (background-service-supervision §6).
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope.
 *
 * `ProcEvent` is CLI-LOCAL and is deliberately NOT a member of core's
 * `AgentEvent` union, exactly as `TeamEvent` and `TodoEvent` are not: core
 * freezes its runtime export list (`public-api.test.ts`) and forbids host
 * coupling (`no-host-coupling.test.ts`), so a new event member would break the
 * first and teach core about a host shape it has no business defining.
 */

import type { JobProgress, ProgressKind } from './progress.js';

/**
 * WHICH KIND OF JOB A RECORD DESCRIBES (long-task-jobs §4.2, D-1).
 *
 *  - `service` never exits on its own and owes the caller a readiness signal;
 *  - `task` always exits and is `running` from the spawn.
 *
 * The distinction is not cosmetic. Before it existed, an explicitly backgrounded
 * `python train.py` sat in `starting` for `readyTimeoutMs` (60s) and `bash` told
 * the model "not ready yet - still coming up" about a job that was already
 * working - which is what pushed it into starting a second copy or giving up.
 */
export type JobKind = 'service' | 'task';

/**
 * The progress subset a SNAPSHOT carries: the rendered line and its shape.
 *
 * `source` and `rowIndex` stay on the record. They exist for tests and debugging
 * (which row won, and did it come from a `\r` carry), and a card or a tool result
 * that started depending on them would be depending on an implementation detail
 * of the extraction table.
 */
export interface ServiceSnapshotProgress {
  text: string;
  kind: ProgressKind;
  /**
   * 0..1 completion for the wait card's bar, or `null`. REQUIRED, not optional:
   * `snapshot()` hand-copies this literal, and a required field turns a forgotten
   * copy into a compile error instead of a silently missing bar.
   */
  fraction: number | null;
}

export type ServiceStatus =
  /** Spawned, not yet ready, still alive. */
  | 'starting'
  /** A loopback URL was printed, or the hinted port answered. */
  | 'ready'
  /**
   * Alive past `readyTimeoutMs` with nothing to detect.
   *
   * A REAL STATUS, NOT A FALLBACK (D-4). `tsc --watch` and `nodemon` listen on
   * nothing; calling them `ready` would be a lie and leaving them `starting`
   * forever would be worse — and worse in a way that costs, because `starting`
   * is the one status that blocks the transcript's settled boundary.
   */
  | 'running'
  /** The process ended on its own. */
  | 'exited'
  /** Spawn itself failed. */
  | 'failed'
  /** We killed it (Ctrl+C, `bash_kill`, `/bg stop`, exit). */
  | 'stopped';

/** A status from which nothing further will happen. */
export function isTerminalStatus(status: ServiceStatus): boolean {
  return status === 'exited' || status === 'failed' || status === 'stopped';
}

export interface ServiceRecord {
  /** `s1` (a service), `t3` (a task). Short because the model has to quote it back. */
  id: string;
  /**
   * WHICH KIND OF JOB THIS IS (long-task-jobs §4.2, D-1).
   *
   * A `service` never exits on its own and owes the caller a readiness signal; a
   * `task` always exits and is `running` from the spawn. The distinction is not
   * cosmetic: before it existed, an explicitly backgrounded `python train.py` sat
   * in `starting` for `readyTimeoutMs` (60s) and `bash` told the model "not ready
   * yet - still coming up" about a job that was already working.
   */
  kind: JobKind;
  /** The `bash` call that started it. */
  toolCallId: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  status: ServiceStatus;
  startedAt: number;
  readyAt?: number;
  endedAt?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  url?: string;
  port?: number;
  detectedBy?: 'url' | 'probe';
  /** The pre-flight probe already answered, so the port detector is disabled. */
  portPreoccupied?: boolean;
  /** Bounded, sanitised ring. */
  rows: readonly string[];
  /**
   * MONOTONIC row cursor, for `bash_output({ since })` AND for the transcript's
   * `entryRevision` term.
   *
   * NEVER `rows.length`: the ring evicts its oldest row while appending a new
   * one, so the joined length can be identical across two different tails. That
   * is verbatim the non-append mutation `virtual-window.ts::entryRevision`'s
   * I-L3-1 comment forbids leaving out — a length term would go on matching
   * while the card changed underneath it.
   */
  rowsSeen: number;
  /** The ring has dropped at least one row. */
  truncated: boolean;
  /** A stop reported the pid still alive afterwards (R-2 / P2-6). */
  killIncomplete?: boolean;
  /**
   * When output last arrived, updated on EVERY CHUNK rather than per completed
   * row (long-task-jobs §4.5).
   *
   * THE DISTINCTION IS LOAD-BEARING: a `\r`-rewritten progress bar (every
   * download tool there is) moves continuously while completing no row at all,
   * so a "last completed row" clock would declare a healthy download stalled
   * after `jobs.stallSeconds`.
   */
  lastOutputAt: number;
  /** Latest extracted progress line, recomputed on the coalesced output tick. */
  progress?: JobProgress;
  /** Where the optional on-disk mirror is writing this job's full log. */
  logPath?: string;
}

/**
 * The frozen, JSON-serialisable projection listeners receive.
 *
 * LISTENERS GET SNAPSHOTS, NEVER THE RECORD, so a render-side bug cannot mutate
 * supervisor state. `rows` carries only the last `PROC_LIMITS.cardTailRows`.
 *
 * `kind` AND `lastOutputAt` ARE REQUIRED ON PURPOSE (long-task-jobs RV-P1-8).
 * `snapshot()` is a hand-copied object literal, so a new optional field that is
 * forgotten there fails silently in five consumers at once. Required fields turn
 * that omission into a compile error instead.
 */
export interface ServiceSnapshot {
  id: string;
  kind: JobKind;
  toolCallId: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  status: ServiceStatus;
  startedAt: number;
  readyAt?: number;
  endedAt?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  url?: string;
  port?: number;
  detectedBy?: 'url' | 'probe';
  portPreoccupied?: boolean;
  rows: readonly string[];
  rowsSeen: number;
  truncated: boolean;
  killIncomplete?: boolean;
  lastOutputAt: number;
  progress?: ServiceSnapshotProgress;
  /**
   * DERIVED, NOT STORED: `now - lastOutputAt > jobs.stallSeconds * 1000` on a
   * job that has not ended.
   *
   * A stored flag would need a timer to flip it, and the whole point is that any
   * render refreshes the judgement for free.
   */
  stalled?: boolean;
  logPath?: string;
}

export type ProcEvent =
  | { type: 'started'; service: ServiceSnapshot }
  /** Coalesced at `PROC_LIMITS.outputCoalesceMs` inside the supervisor. */
  | { type: 'output'; service: ServiceSnapshot }
  | { type: 'ready'; service: ServiceSnapshot }
  | { type: 'exited'; service: ServiceSnapshot }
  | { type: 'stopped'; service: ServiceSnapshot };

export type ProcEventListener = (event: ProcEvent) => void;

export interface ServiceStartRequest {
  command: string;
  cwd: string;
  toolCallId: string;
  /**
   * Absent means `'service'`, which is what every pre-existing caller means and
   * what keeps `start()` backward compatible without a second method.
   */
  kind?: JobKind;
}

export interface ServiceStartResult {
  ok: boolean;
  /** Present when `ok`. */
  service?: ServiceSnapshot;
  /** Present when not `ok` — already model-facing prose. */
  error?: string;
}

/** What `bash_output({ service, since })` reads back. */
export interface ServiceLogPage {
  rows: readonly string[];
  /** Cursor to pass as the next `since`. */
  cursor: number;
  /** Rows were evicted between `since` and what is returned. */
  truncated: boolean;
  /**
   * The not-yet-terminated line among `rows` (empty when the last chunk ended
   * with a newline).
   *
   * THE ONLY WAY TO TELL A REDRAWING PROGRESS BAR FROM A FINISHED ROW: `rows`
   * always ends with the carry line when one exists, so `job_wait` uses this to
   * keep an unchanged carriage-return-rewritten bar out of its incremental row
   * budget (RV-P1-5). Optional so a test double - and `bash_output`, which does
   * not care - can leave it out.
   */
  carryRow?: string;
}

/** What `job_wait` and the supervisor need from a log mirror; no filesystem here. */
export interface JobLogMirrorPort {
  open(jobId: string): void;
  write(jobId: string, chunk: string): void;
  pathOf(jobId: string): string | undefined;
}

/**
 * The port `bash`, the tools, the controller and `/bg` see.
 *
 * A PORT RATHER THAN THE CLASS so `tools/` keeps no import edge into `proc/`'s
 * implementation, which is the same discipline `ToolDeps` already follows for
 * the diff and live-output side channels.
 */
export interface ProcSupervisorPort {
  start(req: ServiceStartRequest): Promise<ServiceStartResult>;
  get(id: string): ServiceSnapshot | undefined;
  list(): ServiceSnapshot[];
  /** `id`, or `'all'`. Resolves once every target is terminal or the grace ran out. */
  stop(id: string): Promise<ServiceSnapshot[]>;
  read(id: string, since?: number): ServiceLogPage | undefined;
  subscribe(listener: ProcEventListener): () => void;
  /**
   * Track a FOREGROUND `bash` child so `forceStop()` can reach it.
   *
   * Returns a release function the tool calls from its own `settle`. One
   * registry, two lifetimes: splitting foreground children and services into two
   * registries is how a force-stop ends up killing the user's dev server, or how
   * a quit leaves it running (I-4).
   */
  trackForeground(pid: number | undefined): () => void;
  /** Hard-kill every tracked FOREGROUND child. Never touches services (I-4). */
  killForeground(reason: 'force'): number;
  /** Live services: `starting | ready | running`. */
  liveCount(): number;
  /**
   * SYNCHRONOUS, TOTAL reaper — the only thing a signal hook,
   * `process.on('exit')` or `handleFatal` may call (I-9).
   *
   * It neither awaits, spawns asynchronously, nor throws, and it is idempotent:
   * a normal quit calls it twice.
   */
  reapSync(): void;
  /** Release every timer/socket. Idempotent. */
  dispose(): void;
}
