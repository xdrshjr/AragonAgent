/**
 * The view model behind the wait card (extended-job-wait §3.8.1).
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope.
 *
 * PURE: `buildWaitView` reads nothing but its arguments. The card and the status
 * bar are projections of the object it returns, which is why every clock in the
 * UI can be a subtraction between an epoch stamped here and the one `nowSec` the
 * renderer already has (no second timer, no second spinner).
 */

import type { ProgressKind } from './progress.js';
import type { ServiceSnapshot, ServiceStatus } from './types.js';
import { isTerminalStatus } from './types.js';

const COMMAND_CHARS = 80;
const LAST_ROW_CHARS = 200;

export interface WaitView {
  toolCallId: string;
  /** `t3` for one job, `3 jobs` for several. */
  jobLabel: string;
  /** The single job's command, clipped; empty when several jobs are awaited. */
  command: string;
  /** Epoch ms the wait began. */
  waitStartedAt: number;
  /** The clamped budget of this wait, in ms. */
  upToMs: number;
  /** Epoch ms of the beat that produced this view; lets a pure consumer tell "how long" without a clock. */
  beatAt: number;
  mode: 'all' | 'any';
  liveJobs: number;
  /** Earliest `startedAt` among the targets (epoch ms). */
  jobStartedAt: number;
  /** The single job's status; `running` when several are awaited. */
  status: ServiceStatus;
  progress?: { text: string; kind: ProgressKind; fraction: number | null };
  /** Newest non-empty output row, sanitised and clipped. */
  lastRow?: string;
  /** Latest `lastOutputAt` among the targets (epoch ms). */
  lastOutputAt: number;
  stalled: boolean;
  stallSeconds: number;
}

export type WaitEndReason = 'terminal' | 'timeout' | 'abort' | 'wake';

export type WaitEvent =
  | { type: 'begin' | 'update'; toolCallId: string; view: WaitView }
  | { type: 'end'; toolCallId: string; reason: WaitEndReason };

export type WaitListener = (event: WaitEvent) => void;

export interface BuildWaitViewInput {
  toolCallId: string;
  /** The awaited jobs' current snapshots. Empty yields `undefined`. */
  snapshots: readonly ServiceSnapshot[];
  mode: 'all' | 'any';
  waitStartedAt: number;
  upToMs: number;
  nowMs: number;
  stallSeconds: number;
}

function clip(text: string, limit: number): string {
  // Control characters become spaces so a stray escape can never reach the card.
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function newestRow(rows: readonly string[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = clip(rows[i] ?? '', LAST_ROW_CHARS);
    if (row.length > 0) return row;
  }
  return undefined;
}

/** Project the awaited jobs into one card-sized view; `undefined` when none remain. */
export function buildWaitView(input: BuildWaitViewInput): WaitView | undefined {
  const { snapshots } = input;
  const first = snapshots[0];
  if (first === undefined) return undefined;

  const single = snapshots.length === 1;
  // The job that spoke last supplies the "latest output" row of a multi-job wait.
  const freshest = snapshots.reduce((a, b) => (b.lastOutputAt > a.lastOutputAt ? b : a), first);
  const lastOutputAt = freshest.lastOutputAt;
  const lastRow = newestRow(freshest.rows);
  const live = snapshots.filter((job) => !isTerminalStatus(job.status));
  const progress = single ? first.progress : undefined;
  const quietMs = Math.max(0, input.nowMs - lastOutputAt);

  return {
    toolCallId: input.toolCallId,
    jobLabel: single ? first.id : `${snapshots.length} jobs`,
    command: single ? clip(first.command, COMMAND_CHARS) : '',
    waitStartedAt: input.waitStartedAt,
    upToMs: input.upToMs,
    beatAt: input.nowMs,
    mode: input.mode,
    liveJobs: live.length,
    jobStartedAt: Math.min(...snapshots.map((job) => job.startedAt)),
    status: single ? first.status : 'running',
    ...(progress
      ? {
          progress: {
            text: progress.text,
            kind: progress.kind,
            fraction: progress.fraction,
          },
        }
      : {}),
    ...(lastRow !== undefined ? { lastRow } : {}),
    lastOutputAt,
    stalled: live.length > 0 && quietMs > input.stallSeconds * 1000,
    stallSeconds: input.stallSeconds,
  };
}
