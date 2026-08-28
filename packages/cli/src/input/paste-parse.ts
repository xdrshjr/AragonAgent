/**
 * Paste recognition primitives (tui-paste-handling section 5.1) -- pure,
 * stream-free, no timers.
 *
 * WHY THIS LIVES BELOW INK. `ink/build/components/App.js:131-138` reads stdin on
 * `'readable'` and emits each chunk as one `'input'` event;
 * `parse-keypress.js:145-148` maps the exact string `'\r'` to `name: 'return'`,
 * which `PromptInput` reads as "send the message". A 15-line paste on a Windows
 * console routinely arrives as a dozen chunks that are exactly `"\r"`, and each
 * one SUBMITS THE DRAFT AS IT STOOD. No component-level heuristic can undo a
 * `key.return` that has already fired, so recognition has to happen on the byte
 * stream, in front of Ink -- the same lesson `mouse-events.ts` records.
 *
 * Two tiers feed one framing (D-4). Tier 1 is bracketed paste and is exact;
 * Tier 2 is a heuristic on chunk SHAPE for the terminals that ignore
 * `DECSET 2004`. Both are about what a keyboard can physically emit.
 */

import { PASTE_MIN_BURST_CHARS } from './limits.js';

/** `DECSET 2004` wraps a paste in these two markers. */
export const PASTE_BEGIN_MARK = '\x1b[200~';
export const PASTE_END_MARK = '\x1b[201~';

/** The longest tail worth holding back while a marker might still complete. */
export const PASTE_MARK_LENGTH = PASTE_BEGIN_MARK.length;

/**
 * True when `s` is a PROPER prefix of either paste marker (never a whole one).
 *
 * Both markers are held, in every mode, whether or not THIS process enabled DEC
 * 2004 (I-16): the user's shell, `tmux` or a wrapper script may have left it on,
 * and an unconsumed marker is a literal `[200~` typed into the draft -- the
 * exact failure the feature exists to prevent.
 */
export function isPastePrefix(s: string): boolean {
  if (s.length === 0 || s.length >= PASTE_MARK_LENGTH) return false;
  return PASTE_BEGIN_MARK.startsWith(s) || PASTE_END_MARK.startsWith(s);
}

/**
 * Length of the trailing run of `text` that is a proper prefix of a paste
 * marker, or 0. Shortest match wins, so only the bytes that could still become a
 * marker are held back.
 */
export function trailingPastePrefixLength(text: string): number {
  const max = Math.min(text.length, PASTE_MARK_LENGTH - 1);
  for (let k = 1; k <= max; k += 1) {
    if (isPastePrefix(text.slice(text.length - k))) return k;
  }
  return 0;
}

/** Any C0 control byte other than TAB -- ESC, BEL, NUL, CR, LF included. */
const HAS_CONTROL_EXCEPT_TAB = /[\u0000-\u0008\u000A-\u001F]/;

/**
 * Tier 2: is this chunk a paste, or keystrokes?
 *
 * The PRIMARY rule -- "longer than one character AND contains a line break" --
 * is exactly the shape defect A needs, so the two coincide: any chunk that could
 * submit the draft by accident is classified as a paste. A lone `\r` is the
 * Enter key and stays `'keys'`.
 *
 * The SECONDARY rule needs `PASTE_MIN_BURST_CHARS` printable characters in one
 * chunk. It excludes chunks carrying any C0 byte but TAB, which is what keeps an
 * arrow-key burst (`\x1b[B\x1b[B...`, and every wheel notch translated by
 * alternate scroll) out of the paste path.
 */
export function classifyChunk(text: string, minBurstChars = PASTE_MIN_BURST_CHARS): 'paste' | 'keys' {
  if (text.length > 1 && /[\r\n]/.test(text)) return 'paste';
  if (text.length >= minBurstChars && !HAS_CONTROL_EXCEPT_TAB.test(text)) return 'paste';
  return 'keys';
}

/**
 * Make a payload safe to put in a buffer and draw through `<Text>` (G2).
 *
 * 1. CRLF and lone CR both become exactly ONE `\n` -- terminals send CR for a
 *    newline in pasted text, and a lone LF is dropped by Ink's key parser
 *    entirely, so both have to be normalised here or a pasted line break either
 *    submits the message or silently vanishes.
 * 2. Every C0 byte except `\n` and `\t` is removed. Ink writes `<Text>` children
 *    to the terminal without escaping anything, so a surviving `\r` overwrites
 *    the row it is drawn on and a surviving `\x1b` repaints the frame's colours.
 * 3. DEL and every C1 byte (U+0080..U+009F) go too, and that is NOT padding:
 *    U+009B is the single-byte CSI and U+0085 is NEL, and a terminal that decodes
 *    them acts on them exactly as it acts on `\x1b[`. A file pasted out of a
 *    non-UTF-8 editor walks straight through a "strip C0" rule.
 * 4. TAB is KEPT. Indentation is content, and it is what the model receives.
 *
 * Applied to PAYLOAD ONLY, never to keystrokes, so `Ctrl+A` and Escape keep
 * working. Non-ASCII text (CJK, emoji) is untouched.
 */
export function sanitisePaste(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}
