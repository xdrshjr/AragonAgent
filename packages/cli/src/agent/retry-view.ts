/**
 * Retry presentation — pure, React-free, unit-tested (llm-api-retry-backoff
 * §6.5 / §6.6).
 *
 * ASCII ONLY: `src/agent/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts`). Every non-ASCII character in the rendered line comes from
 * the `Glyphs` set the caller passes in, never from a literal here.
 *
 * The COUNTDOWN is derived from `resumeAt`, an absolute instant, and never from
 * `delayMs`. Core deliberately sends the instant rather than a tick stream, so
 * the clock belongs to whoever renders — and a card that recomputed from
 * `delayMs` would freeze at the announced number the moment a frame was skipped.
 */

import { formatDuration } from './usage.js';
import type { Glyphs } from '../ui/glyphs.js';

/**
 * Presentation bounds. NAMED `RETRY_UI`, NOT `RETRY_LIMITS_UI`: core's
 * `RETRY_LIMITS` bounds what the mechanism can physically do, this is a column
 * breakpoint, and a name that read as its sibling would invite the next reader to
 * look here for the missing keys.
 */
export const RETRY_UI = {
  /** Below this many columns the status-bar chip degrades to `[r3]`. */
  statusCompactCols: 100,
} as const;

/** The five phases of the one card a turn gets. */
export type RetryPhase = 'waiting' | 'retrying' | 'recovered' | 'exhausted' | 'interrupted';

/** The shape `formatRetryLine` reads — the `kind: 'retry'` entry, structurally. */
export interface RetryLineInput {
  attempt: number;
  maxRetries: number;
  errorType: string;
  phase: RetryPhase;
  resumeAt?: number;
  totalRetries?: number;
  elapsedMs?: number;
}

/**
 * Whole seconds until `resumeAt`, floored at 0.
 *
 * `Math.ceil` rather than `round`: a countdown that shows `0s` for half a second
 * before firing reads as a stall, and showing `1s` for slightly too long does
 * not.
 */
export function secondsLeft(resumeAt: number | undefined, now: number): number {
  if (resumeAt === undefined) return 0;
  return Math.max(0, Math.ceil((resumeAt - now) / 1000));
}

/**
 * A short headline for a provider failure.
 *
 * Deliberately shorter than `formatStreamError`'s: that one is a standalone
 * notice and has to explain what to do, while this shares one line with a
 * counter and a countdown. Derived from `errorType` ONLY — nothing here parses
 * the provider's message, because a human-facing sentence must never become a
 * machine-readable contract (the rule `SubagentRun.retryable` records).
 */
export function retryHeadline(errorType: string): string {
  switch (errorType) {
    case 'rate_limit':
      return 'Rate limited by the provider';
    case 'overloaded':
      return 'Provider overloaded';
    case 'server_error':
      return 'Provider error';
    case 'network_error':
      return 'Network error reaching the provider';
    case 'timeout':
      return 'The request timed out';
    default:
      return 'Provider call failed';
  }
}

function plural(n: number): string {
  return n === 1 ? 'retry' : 'retries';
}

/**
 * The card's single line, WITHOUT the rail glyph — `EntryView` supplies that, the
 * same way it does for every other entry kind.
 *
 * `now` is a parameter rather than a `Date.now()` call so the function stays pure
 * and the render can be asserted without a clock.
 */
export function formatRetryLine(entry: RetryLineInput, glyphs: Glyphs, now: number): string {
  const dot = ` ${glyphs.midDot} `;
  const counter = `retry ${entry.attempt}/${entry.maxRetries}`;
  const settled = entry.totalRetries ?? entry.attempt;

  switch (entry.phase) {
    case 'waiting':
      return `${retryHeadline(entry.errorType)}${dot}${counter} in ${secondsLeft(
        entry.resumeAt,
        now,
      )}s`;
    case 'retrying':
      return `${retryHeadline(entry.errorType)}${dot}${counter} ${glyphs.ellipsis}`;
    case 'recovered':
      return `recovered after ${settled} ${plural(settled)}${
        entry.elapsedMs === undefined ? '' : `${dot}${formatDuration(entry.elapsedMs)}`
      }`;
    case 'exhausted':
      return `${retryHeadline(entry.errorType)}${dot}gave up after ${settled} ${plural(
        settled,
      )}${entry.elapsedMs === undefined ? '' : `${dot}${formatDuration(entry.elapsedMs)}`}`;
    case 'interrupted':
      return `interrupted after ${settled} ${plural(settled)}`;
  }
}

/** The status-bar chip text: full at width, `[r3]` when the row is tight. */
export function formatRetryChip(
  active: { attempt: number; max: number; secondsLeft: number },
  cols: number,
): string {
  if (cols >= RETRY_UI.statusCompactCols) {
    return `retry ${active.attempt}/${active.max} ${active.secondsLeft}s`;
  }
  return `[r${active.attempt}]`;
}
