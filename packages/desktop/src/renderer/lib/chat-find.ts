/**
 * Find in the conversation (pure). Works on the ENTRIES, not the DOM: the transcript is virtualised,
 * so the browser's own find only ever sees the rows near the viewport and would answer "no results"
 * for a phrase sitting 3,000 messages up.
 *
 * Substring match, case-insensitive, no regular expressions: a typed query is a literal to the user,
 * and a regex would add both a surprise and a ReDoS surface for no benefit.
 */

import type { Entry } from '@aragon-agent/tui/model/agent/reducer';

export interface Match {
  entryIndex: number;
  start: number;
  end: number;
}

export interface FindResult {
  matches: Match[];
  /** More hits exist than `max`; the count shown is a floor. */
  truncated: boolean;
}

export const DEFAULT_MAX_MATCHES = 1000;

/** Searchable text per kind. `streaming` entries grow, which `stampOf` accounts for. */
function textOf(entry: Entry): string {
  switch (entry.kind) {
    case 'user':
    case 'queued':
    case 'assistant':
      return entry.text;
    case 'tool':
      return [entry.name, entry.label, entry.argsRaw, entry.preview ?? entry.live?.join('\n') ?? ''].join('\n');
    case 'notice':
      return entry.text;
    case 'retry':
      return entry.message;
    case 'fast':
      return entry.text ?? '';
    default:
      return '';
  }
}

function stampOf(entry: Entry, text: string): string {
  const streaming = entry.kind === 'assistant' && entry.streaming ? 's' : '';
  const output = entry.kind === 'tool' ? (entry.preview?.length ?? 0) + (entry.liveSeq ?? 0) : 0;
  return `${entry.kind}:${text.length}:${output}:${streaming}`;
}

const cache = new WeakMap<Entry, { stamp: string; text: string }>();

/**
 * Lower-cased searchable text. Cached per entry, but the cache is only trusted when the stamp still
 * matches - nothing guarantees the reducer never mutates an entry in place (a streaming assistant
 * entry's text keeps growing), so a stale hit is checked, not assumed.
 */
export function entrySearchText(entry: Entry): string {
  const text = textOf(entry);
  const stamp = stampOf(entry, text);
  const hit = cache.get(entry);
  if (hit && hit.stamp === stamp) return hit.text;
  const lowered = text.toLocaleLowerCase();
  cache.set(entry, { stamp, text: lowered });
  return lowered;
}

export function findMatches(
  entries: readonly Entry[], query: string, options: { max?: number } = {},
): FindResult {
  const needle = query.toLocaleLowerCase();
  const max = options.max ?? DEFAULT_MAX_MATCHES;
  const matches: Match[] = [];
  if (needle === '') return { matches, truncated: false };
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    if (!entry) continue;
    const haystack = entrySearchText(entry);
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      if (matches.length >= max) return { matches, truncated: true };
      matches.push({ entryIndex, start: at, end: at + needle.length });
      from = at + Math.max(1, needle.length);
    }
  }
  return { matches, truncated: false };
}

/** Step through matches, wrapping at both ends. Returns -1 when there are none. */
export function stepMatch(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}
