/**
 * Control-SEQUENCE removal for text that crosses a boundary where a terminal
 * escape must never become content (paste-control-sequence-residue, fix A'-1).
 *
 * WHY A DELETE-THE-WHOLE-SEQUENCE RULE EXISTS. Deleting only the introducer
 * byte turns an escape into visible text: `ESC [ 3 8 ; 2 m` loses its ESC and
 * leaves `[38;2m`, which is a run of digits and semicolons somebody then reads
 * on screen and sends to the model. The bytes were never content; the sequence
 * has to go as a unit.
 *
 * WHY IT IS NOT `tools/terminal-output.ts`'s REGEXES MOVED HERE. Those four
 * regexes answer "what does this look like" for a terminal row that is still
 * being written, and they are fed text whose unfinished tail has ALREADY been
 * cut off and parked in a carry by the caller (`sanitizeChunk`,
 * `toDisplayRow`). Pasted text is one-shot: there is no next chunk, so a
 * truncated sequence needs a rule of its own. Measured against the stream
 * version of the same input, `ESC [ 3 8 ; 2 ; 1 8 ; 5 2 ; 8 6` followed by
 * prose loses the first letter of the prose (`n`), and an unterminated OSC
 * leaves its whole body behind.
 *
 * THE FOUR DECISIONS THIS MODULE ENCODES:
 *
 * 1. A sequence introduced by a real introducer byte (`0x1B`, `0x9B`, `0x9D`,
 *    ...) is removed as a unit; bare text that merely LOOKS like the inside of
 *    one (`[38;2;18;52;86m` typed or pasted without an ESC) is left exactly as
 *    it is, character for character.
 * 2. A string-type sequence (OSC / DCS / SOS / PM / APC) runs to BEL or ST, and
 *    an unterminated one is removed UP TO THE END OF ITS LINE. It never crosses
 *    `\n` and never guesses at a terminator: a truncated sequence is the most
 *    common shape in a clipboard, and the only safe reading of it is "the rest
 *    of this line was never text".
 * 3. A truncated CSI loses its introducer and its parameter bytes and NOTHING
 *    ELSE. `ESC [ 3 1 m` split mid-parameter is parameters, not prose, but the
 *    byte after them is the user's own character and must survive.
 * 4. A C1 CSI (`0x9B`) with no parameter byte at all is treated as the stray
 *    control byte it is most likely to be rather than as a sequence, because a
 *    lone `0x9B` followed by one letter is otherwise indistinguishable from a
 *    non-UTF-8 file's stray byte followed by content -- and consuming that
 *    letter would be the very data loss this module exists to prevent.
 *
 * Pure, ASCII-only, React-free, Ink-free, and TOTAL: it never throws and it
 * never reorders or mangles the bytes it keeps. No new dependency.
 */

/** ESC -- the introducer every terminal shares. */
const ESC = 0x1b;
/** LF. No rule in this module may consume it (decision 2). */
const LF = 0x0a;
/** BEL terminates an OSC. */
const BEL = 0x07;
/** `[` after ESC is CSI, and `\` after ESC is the two-byte ST. */
const BRACKET = 0x5b;
const BACKSLASH = 0x5c;

/** The ASCII second byte of each string-type sequence (`ESC ]`, `ESC P`, ...). */
const ESC_DCS = 0x50;
const ESC_SOS = 0x58;
const ESC_OSC = 0x5d;
const ESC_PM = 0x5e;
const ESC_APC = 0x5f;

/** C1 introducers, as written by a source that is not UTF-8 clean. */
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_DCS = 0x90;
const C1_SOS = 0x98;
const C1_PM = 0x9e;
const C1_APC = 0x9f;

/** Every byte that can START a sequence this module removes. */
const ANY_INTRODUCER = /[\u001b\u0090\u0098\u009b\u009d\u009e\u009f]/;

/**
 * `CSI ... m` (SGR), in both encodings: `ESC [ digits ; m` and the single-byte
 * C1 form `0x9B digits ; m`. NO KEY PRESS PRODUCES ONE, which is what makes it
 * usable as the discriminator for an unframed paste in `stdin-filter.ts`.
 */
const SGR_SEQUENCE = /\u001b\[[0-9;]*m|\u009b[0-9;]*m/;

/**
 * A string-type introducer followed by at least one body byte. An `Alt`+key
 * press is exactly two bytes, so "introducer plus a body" is already outside
 * what a keyboard can emit.
 */
const STRING_SEQUENCE =
  /(?:\u001b[\u0050\u0058\u005d\u005e\u005f]|[\u0090\u0098\u009d\u009e\u009f])[\s\S]/;

/** CSI final byte: `@` through `~`. */
function isFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

/** CSI parameter byte: `0` through `?`. */
function isParamByte(code: number): boolean {
  return code >= 0x30 && code <= 0x3f;
}

/**
 * CSI intermediate byte: `!` through `/`.
 *
 * SPACE (`0x20`) IS DELIBERATELY EXCLUDED (decision 3). The standard allows it,
 * but a pasted sequence cut mid-parameter is followed by ` ` and then prose,
 * and the first letter of that prose is a legal final byte -- so honouring the
 * space would silently eat it. `CSI Ps SP q` (cursor style) is the only shape
 * that gets worse, and no child process writes that to its stdout.
 */
function isIntermediateByte(code: number): boolean {
  return code >= 0x21 && code <= 0x2f;
}

/** True for the C1 introducers that open a string, not a CSI. */
function isC1StringIntroducer(code: number): boolean {
  return code === C1_OSC || code === C1_DCS || code === C1_SOS || code === C1_PM || code === C1_APC;
}

/**
 * End of the string-type sequence whose body starts at `from`.
 *
 * Stops AT the line break rather than past it, and reports "consumed to here"
 * for a body that never terminates (decision 2).
 */
function stringEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === BEL || code === C1_ST) return i + 1;
    if (code === LF) return i;
    if (code === ESC && text.charCodeAt(i + 1) === BACKSLASH) return i + 2;
    i += 1;
  }
  return i;
}

/**
 * End of the CSI whose parameter run starts at `from`.
 *
 * `requireParams` implements decision 4: with no parameter byte at all, a C1
 * CSI is only the introducer byte, and its "final byte" is content.
 */
function csiEnd(text: string, from: number, requireParams: boolean): number {
  let i = from;
  let sawParams = false;
  while (i < text.length && isParamByte(text.charCodeAt(i))) {
    sawParams = true;
    i += 1;
  }
  if (requireParams && !sawParams) return from;
  while (i < text.length && isIntermediateByte(text.charCodeAt(i))) i += 1;
  if (i < text.length && isFinalByte(text.charCodeAt(i))) return i + 1;
  return i;
}

/** End of the sequence starting with ESC at `index` (decision 1 / 3). */
function escapeEnd(text: string, index: number): number {
  if (index + 1 >= text.length) return index + 1;
  const next = text.charCodeAt(index + 1);
  if (next === BRACKET) return csiEnd(text, index + 2, false);
  if (next === ESC_OSC || next === ESC_DCS || next === ESC_SOS || next === ESC_PM
    || next === ESC_APC) {
    return stringEnd(text, index + 2);
  }
  if (next === LF) return index + 1;
  return index + 2;
}

/**
 * End of the sequence starting at `index`, or `-1` when no sequence starts
 * there.
 */
function sequenceEnd(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code === ESC) return escapeEnd(text, index);
  if (code === C1_CSI) return csiEnd(text, index + 1, true);
  if (isC1StringIntroducer(code)) {
    return index + 1 >= text.length ? index + 1 : stringEnd(text, index + 1);
  }
  return -1;
}

/**
 * Remove every escape/control sequence, keeping all other bytes in order.
 *
 * KEEPS `\t`, `\n` AND `\r`: they are line structure, and `\t` inside pasted
 * indentation is content the model is supposed to receive. Stray C0/C1 bytes
 * (and DEL) are NOT this function's job -- they are removed by the caller that
 * wants them gone, so one rule has one owner.
 */
export function stripControlSequences(text: string): string {
  if (!ANY_INTRODUCER.test(text)) return text;
  let out = '';
  let kept = 0;
  let i = 0;
  while (i < text.length) {
    const end = sequenceEnd(text, i);
    if (end === -1) {
      i += 1;
      continue;
    }
    out += text.slice(kept, i);
    i = end;
    kept = end;
  }
  return kept === 0 ? text : out + text.slice(kept);
}

/**
 * True when `text` carries a sequence a KEYBOARD cannot physically produce.
 *
 * Used at the keystroke branch of the stdin filter: a single-line paste that
 * carries ESC fails `classifyChunk`'s two rules (no line break, and
 * `HAS_CONTROL_EXCEPT_TAB`) and would otherwise reach Ink as raw bytes --
 * either typing `[38;2;18;52;86m` with a live ESC into the draft, or throwing
 * an uncaught `TypeError` inside Ink's key parser.
 *
 * THREE THINGS MUST NOT MATCH, and the shapes below are why:
 * - SGR mouse reports (`ESC [ < 0 ; 1 ; 2 m`) are stripped by `splitMouseEvents`
 *   BEFORE this test, and `<` is not a parameter byte, so the SGR rule cannot
 *   see them anyway.
 * - Arrow / function / Home / End keys (`ESC [ A`, `ESC [ 1 ; 5 D`, `ESC [ 3 ~`,
 *   `ESC [ Z`) never end in `m`.
 * - `Alt`+letter (`ESC` followed by one character) has no introducer body, so
 *   the string-type rule does not fire.
 */
export function hasPasteOnlySequence(text: string): boolean {
  return SGR_SEQUENCE.test(text) || STRING_SEQUENCE.test(text);
}
