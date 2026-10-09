/**
 * CSI-u key translation (posix keyboard-enhancement section of the Shift+Enter
 * newline fix).
 *
 * WHY THIS EXISTS. On macOS/Linux the only lever that makes Shift+Enter
 * distinguishable from Enter is asking the terminal to report modified keys in
 * the CSI-u encoding: kitty's disambiguate mode (`CSI > 1 u`, pushed and popped
 * with `CSI < u`) and xterm's `modifyOtherKeys=2` (`CSI > 4 ; 2 m`, reset with
 * `CSI > 4 m`). iTerm2, kitty, ghostty, WezTerm, foot and Alacritty implement
 * at least one of the two; a terminal implementing neither ignores both bytes,
 * which the conhost probe confirmed is a harmless no-op.
 *
 * WHAT CHANGES IN THE STREAM -- AND WHAT NEVER DOES. Both modes re-encode only
 * keys whose legacy encoding is ambiguous: Ctrl/Ctrl+Shift/Ctrl+Alt+letters and
 * digits, the Enter family, the Escape key (kitty), and Backspace with
 * modifiers. `modifyOtherKeys` is named for the OTHER keys: arrows, Home/End,
 * PgUp/PgDn and F-keys keep their standard `\x1b[1;mA` / `\x1b[m~` encodings,
 * and Shift+printable still types text. So the translator below only ever sees
 * codepoints below 128 plus a few named control codes; anything else (a kitty
 * functional-key code from a mode this app never pushes) passes through
 * untouched, which is exactly the pre-enhancement behaviour.
 *
 * THE CONTRACT mirrors `win32-input-mode.ts`: split, translate back to the
 * legacy bytes, with the modified-Enter family becoming `ENTER_NEWLINE_FRAME`.
 * Pure: no node/React imports.
 */

import { ENTER_NEWLINE_FRAME } from './limits.js';

/** Enable / disable the two CSI-u report modes (posix side). */
export const CSI_U_ENABLE = '\x1b[>1u\x1b[>4;2m';
export const CSI_U_DISABLE = '\x1b[<u\x1b[>4m';

export interface CsiUKey {
  /** The full original sequence, for pass-through. */
  readonly seq: string;
  /** First parameter's primary number (the key's codepoint). */
  readonly code: number;
  /** Optional `:alternate` sub-parameters of the key field (kitty/mok). */
  readonly alternates: readonly number[];
  /** Modifier parameter minus one (bit 1 shift, 2 alt, 4 ctrl), or 0. */
  readonly mods: number;
}

export type CsiUSegment =
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: CsiUKey };

const isParamChar = (c: string): boolean =>
  (c >= '0' && c <= '9') || c === ';' || c === ':';

/**
 * Split a chunk into text spans and CSI-u sequences.
 *
 * Grammar accepted: `ESC [ <params> u` where params are digits, `;` and `:`
 * only, and at least one field exists. `\x1b[13;2u` is INCLUDED: with
 * enhancement on, this module owns every `u`-terminated sequence and applies
 * the same Enter semantics `enter-sequences.ts` defines.
 */
export function splitCsiUKeys(text: string): CsiUSegment[] {
  const segments: CsiUSegment[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '\x1b' || text[index + 1] !== '[') {
      index += 1;
      continue;
    }
    let end = index + 2;
    while (end < text.length && isParamChar(text[end])) end += 1;
    if (end >= text.length || text[end] !== 'u') { index += 1; continue; }
    const key = parseKey(text.slice(index + 2, end), text.slice(index, end + 1));
    if (!key) { index += 1; continue; }
    if (index > start) segments.push({ kind: 'text', text: text.slice(start, index) });
    segments.push({ kind: 'key', key });
    index = end + 1;
    start = index;
  }
  if (start < text.length) segments.push({ kind: 'text', text: text.slice(start) });
  return segments;
}

/** Parse the parameter body of a CSI-u sequence, or null when malformed. */
function parseKey(body: string, seq: string): CsiUKey | null {
  if (body.length === 0) return null;
  const fields = body.split(';');
  const keyParts = fields[0]?.split(':').map(Number) ?? [];
  if (keyParts.some((n) => !Number.isInteger(n) || n < 0 || n > 0x10ffff)) return null;
  const code = keyParts[0];
  if (code === undefined) return null;
  let mods = 0;
  if (fields.length > 1) {
    const modParts = fields[1]?.split(':').map(Number) ?? [];
    if (modParts.some((n) => !Number.isInteger(n) || n < 0 || n > 64)) return null;
    const m = modParts[0] ?? 0;
    mods = Math.max(0, m - 1);
  }
  return { seq, code, alternates: keyParts.slice(1), mods };
}

/** Control code for Ctrl+letter (a-z -> 1-26), or the char itself. */
function ctrlByte(char: number): number {
  if (char >= 97 && char <= 122) return char - 96;
  if (char >= 65 && char <= 90) return char - 64;
  return char;
}

/**
 * Translate one CSI-u sequence to the legacy bytes the same keypress would
 * have produced without the report modes (Enter family excepted: a modified
 * Enter becomes the newline frame). Unknown keys pass through unchanged.
 */
export function translateCsiUKey(key: CsiUKey): string {
  const m = key.mods;
  const ctrl = (m & 4) !== 0;
  const alt = (m & 2) !== 0;
  const shift = (m & 1) !== 0;

  if (key.code === 13) return m === 0 ? '\r' : ENTER_NEWLINE_FRAME;
  if (key.code === 27) return alt ? '\x1b\x1b' : '\x1b';
  if (key.code === 9) return shift ? '\x1b[Z' : '\t';
  if (key.code === 127) {
    // POST-normalisation bytes, same rationale as VK_BACK in win32-input-mode.
    if (alt) return '\x1b\x08';
    return '\x08';
  }
  if (key.code === 32) {
    // Ctrl+Space is 0x00 in legacy xterm; plain/alt space is the character.
    if (ctrl) return alt ? '\x1b\x00' : '\x00';
    return alt ? '\x1b ' : ' ';
  }
  if (key.code >= 32 && key.code <= 126) {
    const char = String.fromCharCode(key.code);
    if (ctrl) {
      const code = ctrlByte(key.code);
      const text = code === key.code ? char : String.fromCharCode(code);
      return alt ? `\x1b${text}` : text;
    }
    if (alt) return `\x1b${char}`;
    if (shift && key.alternates.length > 0) {
      const shifted = key.alternates[0];
      if (shifted !== undefined && shifted > 0) return String.fromCodePoint(shifted);
    }
    return char;
  }
  // Functional-key codes only appear under modes this app never pushes
  // (kitty flags 2+); pass them through so behaviour matches the un-enhanced
  // stream instead of inventing a translation.
  return key.seq;
}

/** True when `s` is a PROPER prefix of some CSI-u sequence. */
function isCsiUPrefix(s: string): boolean {
  if (s.length < 3 || s[0] !== '\x1b' || s[1] !== '[') return false;
  for (let i = 2; i < s.length; i += 1) {
    if (!isParamChar(s[i])) return false;
  }
  return true;
}

/**
 * Length of the trailing run of `text` that could still complete into a
 * CSI-u sequence, or 0. Longest match, mirroring the other families.
 */
export function trailingCsiUPrefixLength(text: string): number {
  const max = Math.min(text.length, 32);
  for (let k = max; k >= 1; k -= 1) {
    if (isCsiUPrefix(text.slice(text.length - k))) return k;
  }
  return 0;
}
