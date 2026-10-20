/**
 * The completion-notice queue and its one renderer (long-task-jobs §4.6).
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope.
 *
 * A NOTICE IS NOT A MESSAGE. It is a bounded, factual sentence about a job that
 * ended while the model was busy, and it reaches the model through three
 * mutually exclusive paths that all take from THIS queue - the tail of the next
 * tool result (pull), a `steer()` at the one safe point (push), and a
 * `steer()` before the next user turn (fill). One `drain()` behind all three is
 * what makes "at most once" a property of the data structure rather than a
 * promise in three call sites (I-6).
 *
 * THE QUEUE IS BOUNDED AND DEDUPLICATED BY ID. A job can only end once, so a
 * second notice for the same id is always the same fact restated - which is what
 * makes the relay's re-queueing after a queue wipe idempotent (I-11).
 */

import { formatDuration } from '../agent/usage.js';
import { PROC_LIMITS } from './limits.js';
import type { JobKind, ServiceStatus } from './types.js';

export interface JobNotice {
  /** The job: `t3` / `s1`. */
  id: string;
  kind: JobKind;
  /** Always terminal - a notice is never queued for a running job. */
  status: Extract<ServiceStatus, 'exited' | 'failed' | 'stopped'>;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  /** The last extracted progress line, when there was one. */
  progressText?: string;
  /** At most `PROC_LIMITS.noticeTailRows`, and only for a failure. */
  tailRows: readonly string[];
  at: number;
}

/**
 * Insertion-ordered, deduplicated by id, bounded by `PROC_LIMITS.maxNotices`.
 *
 * INSERTION ORDER IS KEPT because "the oldest thing I have not told you about"
 * is the one that has been waiting longest; the RENDERER then puts failures
 * first, which is a display decision rather than a queue decision.
 */
export class JobNoticeQueue {
  private readonly entries = new Map<string, JobNotice>();

  /** Same id twice keeps ONE entry: a job's terminal fact does not change. */
  push(notice: JobNotice): void {
    if (this.entries.has(notice.id)) return;
    this.entries.set(notice.id, notice);
    // Oldest first out when the bound is exceeded. Dropping the newest instead
    // would bias the block towards facts the model already knows.
    while (this.entries.size > PROC_LIMITS.maxNotices) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Take everything and reset. The one way a notice leaves this object. */
  drain(): JobNotice[] {
    if (this.entries.size === 0) return [];
    const out = [...this.entries.values()];
    this.entries.clear();
    return out;
  }

  pending(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** `exited code 0` / `exited signal SIGKILL` / `stopped` - the same grammar as a card. */
function outcomeOf(notice: JobNotice): string {
  if (notice.status === 'stopped') return 'stopped';
  if (notice.exitCode === null) {
    return notice.signal === null ? notice.status : `${notice.status} on ${notice.signal}`;
  }
  return `${notice.status} code ${notice.exitCode}`;
}

/** Failures first, then non-zero exits, then the rest - in queue order within a group. */
function rank(notice: JobNotice): number {
  if (notice.status === 'failed') return 0;
  if (notice.status === 'exited' && notice.exitCode !== 0) return 1;
  return 2;
}

/**
 * Render the `<job_notices>` block, or `''` when there is nothing to say.
 *
 * EMPTY IN, EMPTY OUT, and the wrapper that appends this to a tool result relies
 * on it: an unconditional block would add two lines to every tool call in every
 * session, which is the context growth this feature exists to avoid.
 */
export function renderJobNotices(notices: readonly JobNotice[]): string {
  if (notices.length === 0) return '';
  const sorted = [...notices].sort((a, b) => rank(a) - rank(b));
  const lines: string[] = ['<job_notices>'];
  for (const notice of sorted.slice(0, PROC_LIMITS.maxNotices)) {
    const progress = notice.progressText ? ` (${notice.progressText} at last check)` : '';
    lines.push(
      `${notice.kind} ${notice.id} ${outcomeOf(notice)} after ` +
        `${formatDuration(notice.elapsedMs)}${progress}`,
    );
    // ONLY A FAILURE EARNS A TAIL: a successful job's last rows are noise, and
    // two lines per success is the difference between a bounded block and a log.
    if (rank(notice) < 2) {
      for (const row of notice.tailRows.slice(0, PROC_LIMITS.noticeTailRows)) {
        lines.push(`  last: ${row}`);
      }
    }
  }
  lines.push('</job_notices>');
  return lines.join('\n');
}
