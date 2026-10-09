/**
 * Win32-input-mode translation (win32 keyboard-enhancement section of the
 * Shift+Enter newline fix).
 *
 * WHY THIS EXISTS. With `CSI ? 9001 h` the Windows console (conhost inside
 * ConPTY included -- verified byte-level on both conhost and Windows Terminal
 * 1.24, see docs/diagnoses/shift-enter-newline-dead-by-default) reports EVERY
 * key as `ESC [ vk ; scan ; char ; keyDown ; mods ; repeat _`. That is the
 * only Windows-side encoding in which Shift+Enter is distinguishable from
 * Enter: mods carries SHIFT_PRESSED (0x10) on the record. Nothing else
 * survives ConPTY: kitty `CSI > 1 u` is swallowed (a `CSI ? u` query never
 * answers) and modifyOtherKeys is a no-op.
 *
 * THE CONTRACT. `splitWin32KeySequences` recognises the records in a chunk;
 * `translateWin32Key` rewrites each one to the LEGACY bytes the same keypress
 * would have produced with the mode off -- except the modified-Enter family,
 * which becomes `ENTER_NEWLINE_FRAME` exactly like `enter-sequences.ts` maps
 * its CSI-u cousins. Ink therefore sees the stream it has always seen. Key-up
 * records are dropped (every press arrives as a down/up pair in one chunk).
 *
 * Pure: no node/React imports, callable from any test environment.
 */

import { ENTER_NEWLINE_FRAME } from './limits.js';

/** Enable / disable win32-input-mode (private mode 9001). */
export const WIN32_INPUT_ENABLE = '\x1b[?9001h';
export const WIN32_INPUT_DISABLE = '\x1b[?9001l';

/** One decoded `ESC [ vk ; sc ; char ; down ; mods ; rep _` record. */
export interface Win32KeyRecord {
  readonly vk: number;
  readonly scan: number;
  readonly char: number;
  readonly down: boolean;
  readonly mods: number;
  readonly repeat: number;
}

export type Win32Segment =
  | { kind: 'text'; text: string }
  | { kind: 'key'; record: Win32KeyRecord };

/** Windows console `dwControlKeyState` modifier bits this module cares about. */
const RIGHT_ALT = 0x1;
const LEFT_ALT = 0x2;
const RIGHT_CTRL = 0x4;
const LEFT_CTRL = 0x8;
const SHIFT = 0x10;
/** Lock states, ENHANCED_KEY and friends must never look like modifiers. */
const MODIFIER_MASK = SHIFT | LEFT_CTRL | RIGHT_CTRL | LEFT_ALT | RIGHT_ALT;

/** Virtual-key codes the translator names explicitly. */
const VK_BACK = 0x08;
const VK_TAB = 0x09;
const VK_ENTER = 0x0d;
const VK_ESCAPE = 0x1b;
const VK_PACKET = 0xe7;

/**
 * Parse one candidate body (`digits and semicolons`, the `_` excluded).
 * Returns null when the field count is impossible for a real record -- that
 * is what keeps a random `ESC [ 1 ; 2 3 _`-shaped paste from being eaten.
 */
function parseRecord(body: string): Win32KeyRecord | null {
  const fields = body.split(';');
  if (fields.length !== 6) return null;
  const nums = fields.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0x10ffff)) return null;
  const [vk, , char, down, mods, repeat] = nums;
  if (vk === undefined || char === undefined || down === undefined) return null;
  if (mods === undefined || repeat === undefined) return null;
  if (vk > 0xff) return null;
  return { vk, scan: nums[1] ?? 0, char, down: down === 1, mods, repeat };
}

/**
 * Split a chunk into text spans and win32-input-mode records.
 *
 * MATCHES ONLY `ESC [ <digits/semicolons> _`: mouse reports need `<`, paste
 * markers end in `~`, CSI-u ends in `u`, DECRPM replies start with `?`. A
 * `_`-terminated all-numeric-parameter sequence is therefore unambiguous in
 * the stream this filter ever sees.
 */
export function splitWin32KeySequences(text: string): Win32Segment[] {
  const segments: Win32Segment[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '\x1b' || text[index + 1] !== '[') {
      index += 1;
      continue;
    }
    let end = index + 2;
    while (end < text.length && text[end] !== '_') {
      const c = text[end];
      if (c < '0' || c > '9') {
        if (c !== ';') { end = -1; break; }
      }
      end += 1;
    }
    if (end === -1 || end >= text.length) { index += 1; continue; }
    const record = parseRecord(text.slice(index + 2, end));
    if (!record) { index += 1; continue; }
    if (index > start) segments.push({ kind: 'text', text: text.slice(start, index) });
    segments.push({ kind: 'key', record });
    index = end + 1;
    start = index;
  }
  if (start < text.length) segments.push({ kind: 'text', text: text.slice(start) });
  return segments;
}

/** Legacy modifier parameter (xterm): 1 + shift + 2*alt + 4*ctrl. */
function legacyModifierParam(m: number): number {
  let p = 1;
  if (m & SHIFT) p += 1;
  if (m & (LEFT_ALT | RIGHT_ALT)) p += 2;
  if (m & (LEFT_CTRL | RIGHT_CTRL)) p += 4;
  return p;
}

/** Functional keys named by vk, as (letter | tilde-code) legacy shapes. */
const FUNCTIONAL_KEYS: ReadonlyMap<number, { letter: string } | { code: number }> = new Map([
  [0x21, { code: 5 }], // PgUp
  [0x22, { code: 6 }], // PgDn
  [0x23, { letter: 'F' }], // End
  [0x24, { letter: 'H' }], // Home
  [0x25, { letter: 'D' }], // Left
  [0x26, { letter: 'A' }], // Up
  [0x27, { letter: 'C' }], // Right
  [0x28, { letter: 'B' }], // Down
  [0x2d, { code: 2 }], // Insert
  [0x2e, { code: 3 }], // Delete
  [0x70, { letter: 'P' }], // F1
  [0x71, { letter: 'Q' }], // F2
  [0x72, { letter: 'R' }], // F3
  [0x73, { letter: 'S' }], // F4
  [0x74, { code: 15 }], // F5
  [0x75, { code: 17 }], // F6
  [0x76, { code: 18 }], // F7
  [0x77, { code: 19 }], // F8
  [0x78, { code: 20 }], // F9
  [0x79, { code: 21 }], // F10
  [0x7a, { code: 23 }], // F11
  [0x7b, { code: 24 }], // F12
]);

/** Emit the legacy form of a functional key under `m` modifiers. */
function functionalLegacy(vk: number, m: number): string {
  const key = FUNCTIONAL_KEYS.get(vk);
  if (!key) return '';
  if (m === 0) {
    return 'letter' in key
      ? (key.letter === 'P' || key.letter === 'Q' || key.letter === 'R' || key.letter === 'S'
        ? `\x1bO${key.letter}`
        : `\x1b[${key.letter}`)
      : `\x1b[${key.code}~`;
  }
  const p = legacyModifierParam(m);
  return 'letter' in key ? `\x1b[1;${p}${key.letter}` : `\x1b[${key.code};${p}~`;
}

/** Control code for Ctrl+letter, or the char itself when not a letter. */
function ctrlByte(char: number): number {
  if (char >= 97 && char <= 122) return char - 96; // a-z -> 1-26
  if (char >= 65 && char <= 90) return char - 64; // A-Z -> 1-26
  return char;
}

const isPrintable = (char: number): boolean => char >= 0x20 && char !== 0x7f;

/**
 * Translate one record to the legacy bytes the same keypress would have
 * produced with win32-input-mode off (Enter family excepted: a modified Enter
 * becomes the newline frame, mirroring `ENTER_SEQUENCES`).
 */
export function translateWin32Key(record: Win32KeyRecord): string {
  if (!record.down) return '';
  const m = record.mods & MODIFIER_MASK;
  const ctrl = (m & (LEFT_CTRL | RIGHT_CTRL)) !== 0;
  const alt = (m & (LEFT_ALT | RIGHT_ALT)) !== 0;
  const shift = (m & SHIFT) !== 0;
  const char = record.char === 0 ? '' : String.fromCodePoint(record.char);

  // AltGr arrives as RightCtrl|RightAlt (or lone RightAlt) WITH the composed
  // character already in `char`; prefixing ESC or control-translating it would
  // break every non-US layout. Plain typing first, exotic combos never.
  if (isPrintable(record.char) && (m === RIGHT_CTRL + RIGHT_ALT || m === RIGHT_ALT)) {
    return char;
  }

  switch (record.vk) {
    case VK_ENTER:
      // A modified Enter NEVER submits -- same rule as `ENTER_SEQUENCES`.
      return m === 0 ? '\r' : ENTER_NEWLINE_FRAME;
    case VK_TAB:
      return shift ? '\x1b[Z' : '\t';
    case VK_ESCAPE:
      return alt ? '\x1b\x1b' : '\x1b';
    case VK_BACK:
      // POST-normalisation bytes: `handleText` rewrites DEL (0x7f) to BS
      // (0x08) for Ink, and translated records bypass that walk -- emitting
      // the final form keeps the stream byte-identical to the baseline.
      if (alt) return '\x1b\x08';
      return '\x08';
    default:
      break;
  }

  if (record.char !== 0 && record.char < 0x20 && record.vk !== VK_PACKET) {
    // Ctrl combos: Windows already resolves the control character (Ctrl+C is
    // 0x03). Alt keeps the ESC prefix; Ctrl+Alt prefixes ESC over the code.
    if (!ctrl && !alt && !shift) return char;
    if (!ctrl && alt) return `\x1b${char}`;
    return ctrl ? `${alt ? '\x1b' : ''}${char}` : char;
  }

  if (isPrintable(record.char)) {
    if (ctrl) {
      const code = ctrlByte(record.char);
      return `${alt ? '\x1b' : ''}${code === record.char ? char : String.fromCharCode(code)}`;
    }
    if (alt) return `\x1b${char}`;
    return char;
  }

  return functionalLegacy(record.vk, m);
}

/** True when `s` is a PROPER prefix of some win32-input-mode record. */
function isWin32Prefix(s: string): boolean {
  // A bare ESC (or ESC + anything else) belongs to the Enter/mouse/paste
  // families' hold; this family only ever extends `\x1b[` with digits and
  // semicolons, up to but never including the `_`.
  if (s.length < 3 || s[0] !== '\x1b' || s[1] !== '[') return false;
  for (let i = 2; i < s.length; i += 1) {
    const c = s[i];
    if ((c < '0' || c > '9') && c !== ';') return false;
  }
  return true;
}

/**
 * Length of the trailing run of `text` that could still complete into a
 * win32-input-mode record, or 0. Longest match, mirroring the other families.
 */
export function trailingWin32PrefixLength(text: string): number {
  const max = Math.min(text.length, 32);
  for (let k = max; k >= 1; k -= 1) {
    if (isWin32Prefix(text.slice(text.length - k))) return k;
  }
  return 0;
}
