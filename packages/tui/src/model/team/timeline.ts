/**
 * The per-child event ring behind the Agents board's `timeline` section
 * (tui-subagent-panel §4.5).
 *
 * WHY A RING ON THE RUN rather than a second store: a `SubagentRun` already IS "one
 * child's projection", and every UI surface reads it through `publish()`. A separate
 * store would be a second authority for the same subject and would have to be
 * subscribed to separately - and the four collection points below are all single
 * funnels that already exist (§4.5.2).
 *
 * FIVE KINDS, NOT EVERY TURN (D-12). A turn marker per turn would fill twenty-four
 * slots in a long task and push out the tool calls, which are the part a reader cannot
 * reconstruct from the report. Phase changes are visible in the board's `state` field
 * in real time, so they do not need history.
 *
 * BOUNDED AND PURE. `appendTimeline` returns a NEW array (never mutates the old one),
 * drops the oldest entry past `TEAM_LIMITS.timelineEntries`, and clamps every line to
 * `TEAM_LIMITS.timelineTextChars`. Purity is what lets `publish()`'s shallow copy hold
 * a stable snapshot without knowing this module exists (AC-25).
 *
 * ASCII ONLY: `src/team/**` is inside `glyphs.test.ts`'s static scan.
 *
 * THE TEXT IS ALWAYS BUILT FROM `describeToolActivity` / `sanitizeActivity`, never
 * from raw tool arguments (D-11 / P1-4). That is the boundary that keeps a
 * `write_file` body, a `bash` transcript or a child's prompt out of a surface that is
 * one `JSON.stringify` from a log.
 */

import type { ActivityArgs } from './activity.js';
import { TEAM_LIMITS } from './limits.js';
import type { SubagentPhase, SubagentRun } from './types.js';

export type TimelineKind = 'tool' | 'retry' | 'compact' | 'overseer' | 'settle';

export interface TimelineEntry {
  kind: TimelineKind;
  /** Absolute epoch ms, the same units as `startedAt` / `endedAt` / `lastIntervention.at`. */
  at: number;
  /** Already sanitized + clamped: at most `TEAM_LIMITS.timelineTextChars` characters. */
  text: string;
  /** Whether the tool call succeeded (`tool` only). */
  ok?: boolean;
  /** How long the tool call took in ms (`tool` only). */
  ms?: number;
  /**
   * The raw tool id and its PICKED args (`tool` only). `text` above stays the plain
   * developer wording; these let the Agents board re-word the line in the friendly
   * voice at render time. Never persisted (`stripEphemeralRuns` drops `timeline`) and
   * `args` is the `pickActivityArgs` subset, so no file body can ride along.
   */
  tool?: string;
  args?: ActivityArgs;
}

/** The phases that end an attempt. Used by the settle-idempotence rule below. */
const TERMINAL_PHASES: ReadonlySet<SubagentPhase> = new Set(['done', 'failed', 'aborted']);

export function isTerminalPhase(phase: SubagentPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

/** Clamp one line to the display budget. Collapses whitespace for the same reason. */
function clampText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= TEAM_LIMITS.timelineTextChars) return flat;
  return `${flat.slice(0, TEAM_LIMITS.timelineTextChars - 3)}...`;
}

/**
 * Append one event, returning a NEW array. The oldest entry is dropped once the ring
 * is full, so the array's length is bounded by `max` for every possible input.
 */
export function appendTimeline(
  prev: readonly TimelineEntry[] | undefined,
  entry: TimelineEntry,
  max: number = TEAM_LIMITS.timelineEntries,
): TimelineEntry[] {
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : TEAM_LIMITS.timelineEntries;
  const next = [...(prev ?? []), { ...entry, text: clampText(entry.text) }];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** The first line of a multi-line answer, clamped - a timeline entry is one line. */
function head(text: string | undefined): string {
  if (text === undefined || text.length === 0) return '';
  return clampText(text);
}

/**
 * The terminal event for one ATTEMPT, or `null` when there is nothing to record yet.
 *
 * WHY THIS IS CALLED FROM `publish()` AND NOT FROM `settlePhase` (§4.5.2 / RV-P1-3):
 * `settlePhase` covers the retry loop's exit only, and two paths set a terminal phase
 * directly - the worker's "never started" abort and the cold-start backoff abort. Those
 * are exactly the children whose explanation a reader needs most, and hanging the
 * settle entry on `settlePhase` alone would leave them with no last event.
 *
 * IDEMPOTENCE IS KEYED ON THE ATTEMPT, not on "the last entry is a settle" (I-14): a
 * retry re-stamps `startedAt`, so a new attempt legitimately earns a second terminal
 * entry, while a repeated `publish()` of the same attempt adds nothing.
 */
export function settleTimelineEntry(run: SubagentRun, at: number): TimelineEntry | null {
  if (!isTerminalPhase(run.phase)) return null;
  const attemptStart = run.startedAt ?? 0;
  const last = run.timeline?.[run.timeline.length - 1];
  if (last?.kind === 'settle' && last.at >= attemptStart) return null;
  const text = run.phase === 'done'
    ? `done: ${head(run.summary)}`.trim()
    : run.phase === 'failed'
      ? `failed: ${head(run.error)}`.trim()
      : 'aborted';
  return { kind: 'settle', at, text };
}

/**
 * The run as a reader should see it: unchanged, or with its attempt's terminal event
 * appended once. Called from `publish()`, which is every state change's single exit
 * (§4.5.2) and therefore covers the two paths that set a terminal phase directly.
 *
 * ADDED TO THE EMITTED SNAPSHOT, NEVER TO THE LIVE RUN (this is the part `publish()`
 * makes subtle). `subagent.ts` calls `onUpdate` with a COPY of the run, so writing the
 * entry onto the object `publish()` receives would be lost - and because
 * `settleTimelineEntry` uses the live timeline as its idempotence key, a lost write
 * means every later publish of the same settled child appends another `settle` row to
 * the ring. Keeping the live run untouched makes the entry a property of the VIEW:
 * exactly one terminal event per attempt, however many frames are published.
 */
export function withSettleEntry(run: SubagentRun, at: number): SubagentRun {
  const settle = settleTimelineEntry(run, at);
  if (settle === null) return run;
  return { ...run, timeline: appendTimeline(run.timeline, settle) };
}
