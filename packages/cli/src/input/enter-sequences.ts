/**
 * Enter-family sequence recognition (tui-shift-enter-copy-queue §3.3) -- pure,
 * stream-free, no node/React imports, callable from any test environment.
 *
 * WHY THIS LIVES BELOW INK. Ink 5's `parse-keypress.js` calls `parseKeypress`
 * ONCE per stdin chunk and hard-codes `shift: false` for the exact string
 * `'\r'`, so a component can never see `key.return && key.shift` -- the
 * `PromptInput` branch for it is dead code. Worse, terminals that DO encode a
 * distinct Shift+Enter send CSI-u (`\x1b[13;2u`), which Ink's `fnKeyRe` does
 * not match: the ESC is stripped by `use-input.js` and `'[13;2u'` falls through
 * to the PRINTABLE branch, typing garbage into the draft. The only layer that
 * sees the bytes before Ink mangles them is the stdin filter, which is where
 * the mouse-report and paste-marker dialects are already translated.
 *
 * THE CONTRACT: rewrite every recognized sequence to ONE normalized token --
 * `ENTER_NEWLINE_FRAME` for "this was a modified Enter, the user wants a
 * newline" and `'\r'` for the unmodified CSI-u Enter some other program left
 * behind. No state, no partial-output: `rewriteEnterSequences` is idempotent
 * because its output contains none of its inputs.
 */

import { ENTER_NEWLINE_FRAME } from './limits.js';

/** What one recognized sequence means, for tests and `/terminal-setup` copy. */
export interface EnterSequenceSpec {
  /** The exact byte sequence a terminal sends for this key. */
  readonly seq: string;
  /** The chord it names, e.g. `'shift+enter'`, `'ctrl+alt+enter'`, `'enter'`. */
  readonly meaning: string;
  /** What `rewriteEnterSequences` replaces it with. */
  readonly to: string;
}

/**
 * The recognition table (§3.3). CSI-u modifiers 2-8 cover Shift(2), Alt(3),
 * Shift+Alt(4), Ctrl(5), Ctrl+Shift(6), Ctrl+Alt(7), Ctrl+Alt+Shift(8) as
 * emitted by kitty/WezTerm keyboard-enhancement mode and by
 * `modifyOtherKeys=2`; every one of them means "Enter with a modifier", and a
 * modified Enter must NEVER submit the draft. `\x1b\r` / `\x1b\n` are the
 * classic Alt+Enter encodings. `\x1b[13u` (no modifier field) is what a
 * leftover kitty mode sends for a PLAIN Enter: it must submit, so it maps to
 * `'\r'` rather than to a newline.
 */
export const ENTER_SEQUENCES: readonly EnterSequenceSpec[] = [
  { seq: '\x1b[13;1u', meaning: 'enter', to: '\r' },
  {
    seq: '\x1b[13;2u',
    meaning: 'shift+enter',
    to: ENTER_NEWLINE_FRAME,
  },
  {
    seq: '\x1b[13;3u',
    meaning: 'alt+enter',
    to: ENTER_NEWLINE_FRAME,
  },
  {
    seq: '\x1b[13;4u',
    meaning: 'shift+alt+enter',
    to: ENTER_NEWLINE_FRAME,
  },
  {
    seq: '\x1b[13;5u',
    meaning: 'ctrl+enter',
    to: ENTER_NEWLINE_FRAME,
  },
  {
    seq: '\x1b[13;6u',
    meaning: 'ctrl+shift+enter',
    to: ENTER_NEWLINE_FRAME,
  },
  {
    seq: '\x1b[13;7u',
    meaning: 'ctrl+alt+enter',
    to: ENTER_NEWLINE_FRAME,
  },
  {
    seq: '\x1b[13;8u',
    meaning: 'ctrl+alt+shift+enter',
    to: ENTER_NEWLINE_FRAME,
  },
  {
    seq: '\x1b\r',
    meaning: 'alt+enter',
    to: ENTER_NEWLINE_FRAME,
  },
  {
    seq: '\x1b\n',
    meaning: 'alt+enter',
    to: ENTER_NEWLINE_FRAME,
  },
  {
    seq: '\x1b[13u',
    meaning: 'enter',
    to: '\r',
  },
];

/**
 * Longest strict prefix any recognized sequence can have. Derived from the
 * table rather than hard-coded so adding a sequence can never leave the hold
 * ceiling behind: the longest sequence is 7 bytes, so a torn sequence can hold
 * up to 6 of them.
 */
const MAX_ENTER_PREFIX = Math.max(...ENTER_SEQUENCES.map((s) => s.seq.length)) - 1;

export type EnterSequenceSegment =
  | { kind: 'text'; text: string }
  | { kind: 'newline' }
  | { kind: 'submit' };

/** Split explicit keys using the recognition table; bare CR/LF remain text. */
export function splitEnterSequences(text: string): EnterSequenceSegment[] {
  const segments: EnterSequenceSegment[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const match = text[index] === '\x1b'
      ? ENTER_SEQUENCES.find((spec) => text.startsWith(spec.seq, index)) : undefined;
    if (!match) { index += 1; continue; }
    if (index > start) segments.push({ kind: 'text', text: text.slice(start, index) });
    segments.push({ kind: match.to === '\r' ? 'submit' : 'newline' });
    index += match.seq.length;
    start = index;
  }
  if (start < text.length) segments.push({ kind: 'text', text: text.slice(start) });
  return segments;
}

/** Normalize explicit Enter keys without changing unknown sequences. */
export function rewriteEnterSequences(text: string): string {
  return splitEnterSequences(text).map((segment) => {
    if (segment.kind === 'text') return segment.text;
    return segment.kind === 'submit' ? '\r' : ENTER_NEWLINE_FRAME;
  }).join('');
}

/** True when `s` is a PROPER prefix of some recognized sequence (never whole). */
function isEnterPrefix(s: string): boolean {
  if (s.length === 0 || s.length > MAX_ENTER_PREFIX) return false;
  for (const spec of ENTER_SEQUENCES) {
    // `length >`, not `startsWith` alone: `startsWith` accepts the WHOLE
    // sequence too, and holding a complete sequence back would add 12 ms
    // of latency to a key that is ready to be rewritten right now.
    if (spec.seq.length > s.length && spec.seq.startsWith(s)) return true;
  }
  return false;
}

/**
 * Length of the trailing run of `text` that is a proper prefix of an
 * Enter-family sequence, or 0.
 *
 * LONGEST MATCH, not shortest: unlike the mouse and paste families, a torn
 * CSI-u sequence diverges from its siblings only at the LAST byte
 * (`\x1b[13;` + `2u`), so every byte before the divergence point must be held
 * back for the next chunk or the sequence is destroyed a byte early. Feeding
 * the result into the filter's `keep = max(...)` alongside the other two
 * families keeps every family's hold intact.
 */
export function trailingEnterPrefixLength(text: string): number {
  const max = Math.min(text.length, MAX_ENTER_PREFIX);
  for (let k = max; k >= 1; k -= 1) {
    if (isEnterPrefix(text.slice(text.length - k))) return k;
  }
  return 0;
}
