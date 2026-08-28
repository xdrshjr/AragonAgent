/**
 * The paste token vocabulary (tui-paste-handling section 5.3) -- pure. No Ink,
 * no React, no I/O.
 *
 * A large paste is replaced IN THE BUFFER by a display token,
 * `[Pasted text #1 +15 lines]`, and its payload is held beside the buffer in the
 * editor's `pastes` map until the message is sent (D-7). An inline token rather
 * than an out-of-band attachment is what lets the user place a paste relative to
 * their own words -- "explain this: [Pasted text #1 +218 lines] -- why does it
 * retry?" -- which is also the shape the requirement's example asks for.
 *
 * The token is ATOMIC FOR EDITING and NOT for cursor movement (D-8). Delete and
 * kill ranges snap outward to cover a whole token and the caret snaps out before
 * an insert, which removes every realistic way to corrupt one; arrows still step
 * by character, because re-deriving `moveVertical`, `home`/`end` and word jumps
 * around a synthetic unit buys a correctness the user cannot notice.
 */

import { PASTE_INLINE_MAX_CHARS, PASTE_INLINE_MAX_LINES } from './composer-limits.js';

export interface PasteRecord {
  readonly id: number;
  /** The sanitised payload, byte-for-byte what `expandPastes` sends. */
  readonly text: string;
  readonly lines: number;
  readonly chars: number;
}

/**
 * A FACTORY, NOT A SHARED CONSTANT (P2-2).
 *
 * A module-level `/g` RegExp carries `lastIndex` between calls, so `re.test(x)`
 * returns false on every second call with the same input -- a bug that presents
 * as "token detection works, then randomly does not". Callers must use
 * `matchAll` or `replace` (both safe) on a FRESH instance; nothing in this module
 * may call `.test()` or `.exec()` on a `/g` regex it did not just create.
 *
 * Strict, anchored to its own literal shape, ASCII-only. Group 1 is the id.
 */
export function pasteTokenRe(): RegExp {
  return /\[Pasted text #(\d+) \+\d+ (?:lines|chars)\]/g;
}

/**
 * The process-monotonic id counter (D-14).
 *
 * CALLED FROM THE COMPONENT, NEVER FROM THE REDUCER (P1-5). React is explicitly
 * allowed to run a reducer more than once for one action -- eager evaluation in
 * `dispatchSetState`, base-queue replay after a bailout, StrictMode double
 * invocation -- and a counter mutated inside one would skip ids and produce two
 * states that differ in the token TEXT, not merely in identity. Allocating in the
 * handler also makes the rendered token deterministic for a unit test.
 *
 * Monotonic for the PROCESS rather than per draft, so two drafts never show `#1`
 * for different content in one session.
 */
let nextPasteId = 1;

export function allocatePasteId(): number {
  const id = nextPasteId;
  nextPasteId += 1;
  return id;
}

/** Test-only reset. Never called from application code. */
export function resetPasteIdsForTest(): void {
  nextPasteId = 1;
}

export function makePasteRecord(id: number, text: string): PasteRecord {
  return { id, text, lines: text.split('\n').length, chars: [...text].length };
}

/**
 * `[Pasted text #3 +218 lines]`, or `[Pasted text #4 +1204 chars]` for a paste
 * that is one very long line.
 *
 * "+1 lines" is not a sentence, and for a one-liner the number the user cares
 * about is its length rather than its line count.
 */
export function formatPasteToken(record: PasteRecord): string {
  return record.lines > 1
    ? `[Pasted text #${record.id} +${record.lines} lines]`
    : `[Pasted text #${record.id} +${record.chars} chars]`;
}

/** Above EITHER inline bound the paste is collapsed into a token (G3 / G4). */
export function shouldCollapse(text: string): boolean {
  return text.split('\n').length > PASTE_INLINE_MAX_LINES || [...text].length > PASTE_INLINE_MAX_CHARS;
}

interface TokenSpan {
  readonly start: number;
  readonly end: number;
  readonly id: number;
}

/** Every token in the buffer, in order. */
export function tokenSpans(buffer: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  for (const m of buffer.matchAll(pasteTokenRe())) {
    const start = m.index ?? 0;
    spans.push({ start, end: start + m[0].length, id: Number(m[1]) });
  }
  return spans;
}

/** The token containing or touching `index`, or `null`. */
export function tokenAt(buffer: string, index: number): TokenSpan | null {
  for (const span of tokenSpans(buffer)) {
    if (index >= span.start && index <= span.end) return span;
  }
  return null;
}

/**
 * Move a caret that landed STRICTLY INSIDE a token to its nearer edge (D-8).
 *
 * An index at either edge, or outside every token, is returned unchanged -- so
 * this is a no-op on a buffer with no tokens, which is every buffer today.
 */
export function snapOutOfToken(buffer: string, cursor: number): number {
  for (const span of tokenSpans(buffer)) {
    if (cursor <= span.start || cursor >= span.end) continue;
    return cursor - span.start <= span.end - cursor ? span.start : span.end;
  }
  return cursor;
}

/**
 * Grow `[from, to)` so it covers every token it partially overlaps (G5).
 *
 * This is what makes `Backspace` immediately after `...lines]` remove the whole
 * token in ONE keystroke, and what stops `Ctrl+W` / `Ctrl+U` / `Ctrl+K` leaving
 * half a token -- and therefore an unparseable label -- behind.
 */
export function expandRangeOverTokens(
  buffer: string,
  from: number,
  to: number,
): { from: number; to: number } {
  let lo = Math.min(from, to);
  let hi = Math.max(from, to);
  for (const span of tokenSpans(buffer)) {
    if (span.start < hi && lo < span.end) {
      lo = Math.min(lo, span.start);
      hi = Math.max(hi, span.end);
    }
  }
  return { from: lo, to: hi };
}

/**
 * Replace every token whose id is present in `pastes`; leave the rest verbatim.
 *
 * A user who literally TYPES `[Pasted text #3 +9 lines]` while paste #3 exists in
 * the same draft will have it expanded. That is bounded (ids are per process, the
 * map is per draft) and harmless (they get text that is already in their own
 * draft), and the alternative -- an unguessable nonce in the label -- would trade
 * a case nobody hits for a label nobody can read.
 */
export function expandPastes(buffer: string, pastes: ReadonlyMap<number, PasteRecord>): string {
  if (pastes.size === 0) return buffer;
  return buffer.replace(pasteTokenRe(), (match, idText: string) => {
    const record = pastes.get(Number(idText));
    return record ? record.text : match;
  });
}

/** Ids still referenced by the buffer -- the input to I-7's prune. */
export function referencedIds(buffer: string): Set<number> {
  const ids = new Set<number>();
  for (const m of buffer.matchAll(pasteTokenRe())) ids.add(Number(m[1]));
  return ids;
}
