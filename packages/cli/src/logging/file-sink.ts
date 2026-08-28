/**
 * The file sink — a memory queue in front of ONE synchronous append fd.
 *
 * WHY NOT `createWriteStream` (design P1-4). Three reasons, each fatal on its
 * own:
 *   - a stream's internal buffer is DISCARDED by `process.exit()`, and the
 *     records still sitting in it during a crash are the ones worth having;
 *   - an exit-path `appendFileSync` plus a steady-state stream are two writers
 *     on one file with no defined ordering between them;
 *   - a stream reports write failures through an async `'error'` event, which
 *     THROWS when nobody is listening — so "make the log directory read-only"
 *     would take the whole CLI down instead of degrading.
 *
 * With `openSync` + `writeSync` every failure is a synchronous throw one
 * `try/catch` away, and `flushSync()` and the steady-state flush are literally
 * the same code path. `O_APPEND` keeps concurrent `aragon` processes from
 * truncating each other, and one batched `writeSync` stays far below any size
 * that could tear a line.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

export interface FileSinkOptions {
  dir: string;
  maxFileBytes: number;
  maxFiles: number;
  /**
   * Renders the "records were dropped" warning line. Not a persisted setting —
   * the sink handles LINES and has no session id or clock of its own, so the
   * logger supplies the rendering and the sink decides when it is needed.
   */
  formatDropNotice?: (count: number) => string;
  /** Called once, when the sink gives up on writing. */
  onFailure?: (reason: string) => void;
}

/** Flush triggers: whichever of the two comes first. */
const FLUSH_AT_RECORDS = 64;
const FLUSH_INTERVAL_MS = 200;

/**
 * Hard queue ceiling. On overflow the NEWEST records are dropped and the head
 * is kept: in a flood, the oldest lines are the ones that explain how it
 * started, so discarding them first would throw away the log's whole value at
 * the moment it finally has some.
 *
 * A backstop rather than a working limit — `write()` flushes at
 * `FLUSH_AT_RECORDS` and the flush is synchronous, so the queue does not
 * normally grow past that. It stays because the batching threshold is a tuning
 * knob and an unbounded array behind one is not something to rediscover later.
 * The drop COUNTER, by contrast, is reached routinely: see `flushSync`, where a
 * failed write would otherwise discard its batch without a word.
 */
const MAX_QUEUED_RECORDS = 5000;

/** Consecutive write failures after which the sink stops trying (§4.4.6). */
const MAX_CONSECUTIVE_FAILURES = 3;

const FILE_PREFIX = 'aragon-';
const FILE_SUFFIX = '.log';

/**
 * `YYYY-MM-DD` in LOCAL time.
 *
 * Local, not UTC, and the record timestamps use the same clock deliberately: a
 * user west of UTC would otherwise find an evening's records filed under the
 * previous local day and stamped with the next one, which makes "open today's
 * log" a lie twice over.
 */
export function localDateStamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Delete the oldest files until at most `maxFiles` remain.
 *
 * A STANDALONE STEP, called on three occasions — first write of the process,
 * midnight roll-over, and size rotation — because retention that only ran
 * during size rotation would never fire for the many users who never reach
 * `maxFileBytes`: one file per day, forever, under a setting that says 10.
 *
 * Never throws. On Windows another `aragon` process may hold a handle on a file
 * we would like to remove; that is a reason to skip it, not to fail a write.
 */
export function enforceRetention(dir: string, maxFiles: number): void {
  try {
    const files = readdirSync(dir)
      .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
      .map((name) => {
        const full = join(dir, name);
        try {
          return { full, mtime: statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { full: string; mtime: number } => entry !== null)
      .sort((a, b) => a.mtime - b.mtime);

    for (const entry of files.slice(0, Math.max(0, files.length - maxFiles))) {
      try {
        rmSync(entry.full, { force: true });
      } catch {
        // Locked by another instance. Retention is best-effort by design.
      }
    }
  } catch {
    // Directory does not exist yet, or is unreadable. Nothing to retain.
  }
}

export class FileSink {
  private options: FileSinkOptions;
  private queue: string[] = [];
  private dropped = 0;
  private fd: number | null = null;
  private currentFile: string | null = null;
  private currentDay = '';
  private currentSize = 0;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private failed = false;
  private failureReason: string | undefined;
  private retentionRun = false;

  constructor(options: FileSinkOptions) {
    this.options = { ...options };
  }

  get disabled(): boolean {
    return this.failed;
  }

  get lastError(): string | undefined {
    return this.failureReason;
  }

  /** The file records are going to right now (may not exist until first write). */
  get currentPath(): string {
    if (this.currentFile) return this.currentFile;
    return join(this.options.dir, `${FILE_PREFIX}${localDateStamp()}${FILE_SUFFIX}`);
  }

  /** Enqueue one already-serialised line (including its trailing newline). */
  write(line: string): void {
    if (this.failed) return;

    if (this.queue.length >= MAX_QUEUED_RECORDS) {
      this.dropped += 1;
      return;
    }
    this.queue.push(line);

    if (this.queue.length >= FLUSH_AT_RECORDS) {
      this.flushSync();
      return;
    }
    this.startTimer();
  }

  /** Threshold/timer flush. Identical to `flushSync` — see the module header. */
  flush(): void {
    this.flushSync();
  }

  /** Idempotent: safe to call from `exit`, a signal handler and a crash handler. */
  flushSync(): void {
    if (this.queue.length === 0 && this.dropped === 0) return;
    if (this.failed) {
      this.queue = [];
      return;
    }

    const pending = this.queue.length;
    const droppedBefore = this.dropped;
    const batch = this.takeBatch();
    try {
      this.prepareTarget(Buffer.byteLength(batch));
      writeSync(this.fd as number, batch);
      this.currentSize += Buffer.byteLength(batch);
      this.failures = 0;
    } catch (err) {
      // The batch is gone — retrying it would need the queue to grow unbounded
      // behind a directory that may never become writable. But it is ACCOUNTED
      // FOR: the count (including the notice this batch was carrying) rides
      // along to the next flush that succeeds. Silently losing records is the
      // one thing a logger must not do.
      this.dropped = droppedBefore + pending;
      this.recordFailure(err);
    }
  }

  close(): void {
    this.flushSync();
    this.stopTimer();
    this.closeFd();
  }

  /**
   * Apply new settings. Changing the directory closes the current fd so the next
   * write lazily opens the new one; the sink never eagerly creates a directory
   * the user may never write a record into.
   */
  reconfigure(options: FileSinkOptions): void {
    const dirChanged = options.dir !== this.options.dir;
    if (dirChanged) {
      this.flushSync();
      this.closeFd();
      this.retentionRun = false;
    }
    this.options = { ...this.options, ...options };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private takeBatch(): string {
    const lines = this.queue;
    this.queue = [];

    if (this.dropped > 0) {
      const notice = this.options.formatDropNotice?.(this.dropped);
      this.dropped = 0;
      // Appended, not prepended: it describes what happened to the records that
      // would have followed these, and silence about a drop is unacceptable.
      if (notice) lines.push(notice);
    }
    return lines.join('');
  }

  /** Open (or roll) the target file so `incomingBytes` can be appended to it. */
  private prepareTarget(incomingBytes: number): void {
    const day = localDateStamp();
    if (this.fd !== null && day !== this.currentDay) {
      // Midnight: yesterday's file keeps its own name, so there is nothing to
      // rename — just close it and open today's. Retention runs here because
      // this is the path a user who never hits `maxFileBytes` takes every day.
      this.closeFd();
      this.openTarget(day);
      enforceRetention(this.options.dir, this.options.maxFiles);
    }
    if (this.fd === null) {
      this.openTarget(day);
      if (!this.retentionRun) {
        this.retentionRun = true;
        enforceRetention(this.options.dir, this.options.maxFiles);
      }
    }
    if (this.currentSize + incomingBytes > this.options.maxFileBytes) {
      this.rotateBySize(day);
    }
  }

  private openTarget(day: string): void {
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    const file = join(this.options.dir, `${FILE_PREFIX}${day}${FILE_SUFFIX}`);
    this.fd = openSync(file, 'a', 0o600);
    this.currentFile = file;
    this.currentDay = day;
    this.currentSize = existsSync(file) ? statSync(file).size : 0;
  }

  /**
   * flush → close → rename → open → retention, in that order.
   *
   * `closeSync` MUST precede `renameSync`: on Windows renaming a file the
   * process still holds a handle on fails with EPERM. A failed rename is
   * swallowed and writing continues into the original file — two instances
   * rotating at once should cost an extra small file, not the log itself.
   */
  private rotateBySize(day: string): void {
    const previous = this.currentFile;
    const index = this.nextRotationIndex(day);
    const target = join(this.options.dir, `${FILE_PREFIX}${day}.${index}${FILE_SUFFIX}`);

    this.closeFd();
    if (previous) {
      try {
        renameSync(previous, target);
      } catch {
        // Another instance won the race, or holds a handle. Keep writing.
      }
    }
    this.openTarget(day);
    enforceRetention(this.options.dir, this.options.maxFiles);
  }

  /** Highest existing `aragon-<day>.<n>.log` index, plus one. */
  private nextRotationIndex(day: string): number {
    const prefix = `${FILE_PREFIX}${day}.`;
    let max = 0;
    try {
      for (const name of readdirSync(this.options.dir)) {
        if (!name.startsWith(prefix) || !name.endsWith(FILE_SUFFIX)) continue;
        const n = Number.parseInt(name.slice(prefix.length, name.length - FILE_SUFFIX.length), 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    } catch {
      // Unreadable directory: index 1 is as good a guess as any.
    }
    return max + 1;
  }

  private closeFd(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // Already closed by a racing handler; nothing to do.
    }
    this.fd = null;
    this.currentFile = null;
    this.currentSize = 0;
  }

  /**
   * Logging failure must never become CLI failure, and must never write to the
   * terminal itself (invariant I-4 — a stray line permanently misaligns the
   * full-screen frame). The owner is told once through `onFailure`, which routes
   * to a toast when the TUI is mounted and to stderr when it is not.
   */
  private recordFailure(err: unknown): void {
    this.failures += 1;
    this.failureReason = err instanceof Error ? err.message : String(err);
    this.closeFd();
    if (this.failures < MAX_CONSECUTIVE_FAILURES) return;
    this.failed = true;
    this.stopTimer();
    this.options.onFailure?.(this.failureReason);
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flushSync(), FLUSH_INTERVAL_MS);
    // Without `unref`, an `aragon --version` that logs one line would be held
    // open by this timer for 200ms after it had nothing left to do.
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** Exposed for the CLI's `logs` commands, which list the same file family. */
export function isLogFileName(name: string): boolean {
  return name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX);
}

/** The log file the CURRENT day would use inside a log directory. */
export function currentLogFileName(date = new Date()): string {
  return `${FILE_PREFIX}${localDateStamp(date)}${FILE_SUFFIX}`;
}
