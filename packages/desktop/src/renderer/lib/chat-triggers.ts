/**
 * Detecting the `/command` and `@file` triggers in the composer text, and applying a pick.
 * Pure: the composer passes the text and the caret, and gets back where the trigger starts.
 */

export interface TriggerMatch {
  /** Index of the trigger character (`/` or `@`). */
  start: number;
  /** Text typed after the trigger, up to the caret. */
  query: string;
}

/** A slash menu only opens when `/` is the very first character and no space has been typed yet. */
export function detectSlash(text: string, caret: number): TriggerMatch | null {
  if (!text.startsWith('/')) return null;
  const typed = text.slice(1, caret);
  if (/\s/.test(typed)) return null;
  return { start: 0, query: typed };
}

/** `@` opens the mention menu at a word start; the query is the unbroken run after it. */
export function detectMention(text: string, caret: number): TriggerMatch | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

export interface Edit {
  text: string;
  caret: number;
}

/** Replace the trigger and its query with `path` (relative path inserted as plain text + a space). */
export function applyMention(text: string, match: TriggerMatch, caret: number, path: string): Edit {
  const insert = `${path} `;
  const next = text.slice(0, match.start) + insert + text.slice(caret);
  return { text: next, caret: match.start + insert.length };
}

/** Insert text at the caret (used by the prompt picker and dropped paths). */
export function insertAt(text: string, caret: number, insert: string): Edit {
  const next = text.slice(0, caret) + insert + text.slice(caret);
  return { text: next, caret: caret + insert.length };
}

/** Wrap-around index step for arrow-key navigation in a menu. */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (current + delta + length) % length;
}
