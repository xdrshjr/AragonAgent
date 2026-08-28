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
  /** `s1`, `s2`, ... Short because the model has to quote it back. */
  id: string;
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
}

/**
 * The frozen, JSON-serialisable projection listeners receive.
 *
 * LISTENERS GET SNAPSHOTS, NEVER THE RECORD, so a render-side bug cannot mutate
 * supervisor state. `rows` carries only the last `PROC_LIMITS.cardTailRows`.
 */
export interface ServiceSnapshot {
  id: string;
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
