/**
 * Settled boundary — which transcript entries may be PRINTED
 * (tui-native-terminal-scroll §4.4).
 *
 * Printed rows live in the host terminal's scrollback and can never be rewritten
 * ("printed is forever"). So the only entries that may be printed are the ones the
 * reducer will NEVER write to again. This module derives that from the reducer's
 * real write set, one exhaustive `switch` per entry kind. Adding an `Entry` kind is
 * a compile error here (`never`), which is the whole point; widening the write set
 * of an EXISTING kind is not caught by the compiler, so `agent/reducer.ts` carries
 * a pointer comment beside the `Entry` union and the unit tests pin each row.
 *
 * Three rules that are easy to "simplify" wrongly:
 *  - A tool is stable only when `done` or `error`. `pending` is NOT stable: the
 *    card is created at `pending` and `toolCallDelta` keeps rewriting `argsRaw`
 *    while the model streams its arguments (RV-1).
 *  - A trailing `Context length exceeded` error notice is NOT stable while a run is
 *    active: `compactionStart` rewrites it in place into an info notice (RV-4).
 *  - A non-terminal `service` card is neither printed nor a wall (RV-3). It is
 *    rewritten for the whole session; the one-row `terminal: true` record the
 *    reducer appends at the end is an ordinary stable entry and carries the news.
 */

import type { Entry } from '../../model/agent/reducer.js';
import { CONTEXT_OVERFLOW_NOTICE_PREFIX } from '../../model/agent/reducer.js';

/** Kinds the reducer may still rewrite while a run is active, so a tail one is held. */
const MUTABLE_TAIL_KINDS: ReadonlySet<Entry['kind']> = new Set([
  'assistant', 'tool', 'compaction', 'todo', 'team', 'fast', 'retry', 'queued',
]);

/** Never printed and never a wall: rewritten for the whole session (RV-3). */
export function isExcluded(entry: Entry): boolean {
  return entry.kind === 'service' && entry.terminal !== true;
}

/** True when the reducer will never write to `entry` again. */
export function isEntryStable(entry: Entry, runActive: boolean, isTail: boolean): boolean {
  switch (entry.kind) {
    // `attachments` (desktop-attachments-and-tool-voice) is immutable once the entry exists;
    // the one rewrite, `queued -> user`, moves it whole and never touches a promoted row.
    case 'user':
      return true;
    case 'notice':
      return !(
        runActive &&
        isTail &&
        entry.level === 'error' &&
        entry.text.startsWith(CONTEXT_OVERFLOW_NOTICE_PREFIX)
      );
    case 'assistant':
      return !entry.streaming;
    case 'tool':
      return entry.status === 'done' || entry.status === 'error';
    case 'compaction':
      return entry.live !== true;
    case 'todo':
      return entry.live === false;
    case 'team':
      return entry.active === false;
    case 'fast':
      return entry.live === false;
    case 'retry':
      return (
        entry.phase === 'recovered' ||
        entry.phase === 'exhausted' ||
        entry.phase === 'interrupted'
      );
    case 'queued':
      // Rewritten in place into a `user` entry by the matching receipt.
      return false;
    case 'service':
      // Only the terminal record is ever a candidate; `isExcluded` filters the rest.
      return entry.terminal === true;
    case 'governance':
      // A settlement card is appended once, already complete.
      return true;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

/**
 * Length of the printable PREFIX of `entries`.
 *
 * The first unstable (non-excluded) entry is a wall: everything before it may
 * print, nothing after it may, which keeps scrollback order equal to conversation
 * order (I-S3). Excluded entries are skipped, so a long-lived service card never
 * blocks the conversation behind it.
 */
export function settledCount(entries: readonly Entry[], runActive: boolean): number {
  const last = entries.length - 1;
  let count = entries.length;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (isExcluded(entry)) continue;
    if (!isEntryStable(entry, runActive, i === last)) {
      count = i;
      break;
    }
  }
  // Hold a mutable TAIL while a run is active, but only a mutable one: a `user` or
  // `notice` at the tail prints immediately (a submitted message must appear at once).
  if (runActive && count === entries.length && count > 0) {
    const tail = entries[last]!;
    if (!isExcluded(tail) && MUTABLE_TAIL_KINDS.has(tail.kind)) return last;
  }
  return count;
}

/**
 * Everything printable at shutdown: all entries except those that never settle
 * (`queued`, non-terminal services). The last answer must not be lost to a
 * boundary that was waiting for a frame that will never come.
 */
export function settleAllEntries(entries: readonly Entry[]): Entry[] {
  return entries.filter((entry) => entry.kind !== 'queued' && !isExcluded(entry));
}
