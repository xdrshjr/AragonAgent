/**
 * The optional on-disk log mirror — the escape hatch (long-task-jobs §4.8).
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope.
 *
 * WHY IT EXISTS: the ring holds 200 rows, so the `ModuleNotFoundError` from eight
 * minutes ago is gone exactly when the model needs it. The answer is not a bigger
 * ring (that is a bigger context) and not a new tool (the model already has
 * `read_file` and `grep`): it is the full log on disk plus the PATH in the
 * truncation note.
 *
 * THREE RULES, each of which is about not becoming a new failure mode:
 *
 *  - ASYNC AND COALESCED. `appendFile` with a <=4 writes/second buffer, so a
 *    webpack build emitting thousands of lines cannot turn logging into the
 *    bottleneck of the build it is logging.
 *  - BOUNDED. `PROC_LIMITS.logMirrorMaxBytes` (2 MB) per job, then one
 *    `[mirror truncated]` line and silence.
 *  - FAILURES ARE DEBUG LOGS, NEVER THROWS. A full disk must not kill a training
 *    run; the ring, the tools and the job state machine do not depend on this
 *    module at all.
 */

import { appendFile, appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getLogger } from '../logging/logger.js';
import { PROC_LIMITS } from './limits.js';

export interface JobLogMirrorOptions {
  /** `${aragonHome}/jobs/${sessionTag}`. A closure so a test can hand in a temp dir. */
  root: () => string;
  maxBytes?: number;
  flushMs?: number;
}

interface MirrorFile {
  path: string;
  bytes: number;
  /** The `[mirror truncated]` marker has already been written. */
  capped: boolean;
}

/**
 * Delete all but the newest `PROC_LIMITS.mirrorRetainDirs` session directories.
 *
 * BEST EFFORT AND SILENT. This runs once per process at first use, and its whole
 * job is to stop `~/.aragon-agent/jobs/` from growing without bound; a directory
 * that cannot be read is not a reason to refuse to start.
 */
export function pruneJobLogSessions(jobsRoot: string): void {
  try {
    if (!existsSync(jobsRoot)) return;
    const dirs = readdirSync(jobsRoot, { withFileTypes: true })
      .filter((entry: { isDirectory(): boolean }) => entry.isDirectory())
      .map((entry: { name: string }) => {
        const path = join(jobsRoot, entry.name);
        try {
          return { path, mtime: statSync(path).mtimeMs };
        } catch {
          return { path, mtime: 0 };
        }
      })
      .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
    for (const stale of dirs.slice(PROC_LIMITS.mirrorRetainDirs)) {
      try {
        rmSync(stale.path, { recursive: true, force: true });
      } catch (err) {
        getLogger().debug('tool', 'job_mirror_prune_failed', {
          path: stale.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    getLogger().debug('tool', 'job_mirror_prune_failed', {
      root: jobsRoot,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * The longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`.
 *
 * THE CAP IS IN BYTES AND THE BUFFER IS IN CHARACTERS, so slicing by character
 * count silently overshoots for any non-ASCII output - a log that writes more than
 * its documented ceiling while claiming to enforce it. A partial trailing sequence
 * is dropped rather than written as a replacement character, so `grep` sees a short
 * final line instead of a corrupted one. The ASCII fast path costs one length check.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const decoded = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  // A cut inside a multi-byte sequence decodes to U+FFFD, which must not be
  // written: strip the tail of replacement characters the cut produced.
  return decoded.replace(/\uFFFD+$/u, '');
}

export class JobLogMirror {
  private readonly files = new Map<string, MirrorFile>();
  private readonly buffers = new Map<string, string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private pruned = false;
  private disposed = false;

  constructor(private readonly opts: JobLogMirrorOptions) {}

  /** Lazy creation: the directory appears only when a job actually prints. */
  open(jobId: string): void {
    if (this.disposed || this.files.has(jobId)) return;
    const path = join(this.opts.root(), `${jobId}.log`);
    try {
      mkdirSync(dirname(path), { recursive: true });
      // SEEDED FROM DISK, because a resumed session reuses nothing but the
      // directory name: without this the byte cap restarts at zero every launch.
      const bytes = existsSync(path) ? statSync(path).size : 0;
      this.files.set(jobId, { path, bytes, capped: bytes >= this.maxBytes() });
      if (!this.pruned) {
        this.pruned = true;
        pruneJobLogSessions(dirname(this.opts.root()));
      }
    } catch (err) {
      getLogger().debug('tool', 'job_mirror_open_failed', {
        job: jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Buffer one chunk. Never throws, never awaits, never blocks the child. */
  write(jobId: string, chunk: string): void {
    if (this.disposed) return;
    if (!this.files.has(jobId)) this.open(jobId);
    const file = this.files.get(jobId);
    if (!file || file.capped) return;
    this.buffers.set(jobId, (this.buffers.get(jobId) ?? '') + chunk);
    this.scheduleFlush();
  }

  pathOf(jobId: string): string | undefined {
    return this.files.get(jobId)?.path;
  }

  /** Flush what is buffered and release the timer. Idempotent. */
  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    // SYNCHRONOUS AT TEARDOWN. The async path is right during a run (it must never
    // block the child's stdout callback), but a dispose that returns before the
    // last chunk has landed is a log with a hole in the one place it matters -
    // the end of the job.
    this.flushAll(true);
  }

  private maxBytes(): number {
    return this.opts.maxBytes ?? PROC_LIMITS.logMirrorMaxBytes;
  }

  private flushMs(): number {
    return this.opts.flushMs ?? PROC_LIMITS.mirrorFlushMs;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushAll();
    }, this.flushMs());
    this.flushTimer.unref?.();
  }

  private flushAll(sync = false): void {
    for (const [jobId, chunk] of [...this.buffers]) {
      this.buffers.delete(jobId);
      this.flushOne(jobId, chunk, sync);
    }
  }

  private flushOne(jobId: string, chunk: string, sync: boolean): void {
    const file = this.files.get(jobId);
    if (!file || chunk.length === 0) return;
    const room = this.maxBytes() - file.bytes;
    const accepted = room <= 0 ? '' : truncateToBytes(chunk, room);
    if (accepted.length > 0) {
      file.bytes += Buffer.byteLength(accepted, 'utf8');
      this.writeOut(file.path, accepted, jobId, sync);
    }
    if (file.bytes >= this.maxBytes() && !file.capped) {
      file.capped = true;
      this.writeOut(file.path, '\n[mirror truncated]\n', jobId, sync);
    }
  }

  /** One place that writes, so the sync and async paths cannot drift. */
  private writeOut(path: string, text: string, jobId: string, sync: boolean): void {
    if (sync) {
      try {
        appendFileSync(path, text, 'utf8');
      } catch (err) {
        getLogger().debug('tool', 'job_mirror_write_failed', {
          job: jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    appendFile(path, text, 'utf8', (err) => {
      if (err) {
        getLogger().debug('tool', 'job_mirror_write_failed', { job: jobId, error: err.message });
      }
    });
  }
}
