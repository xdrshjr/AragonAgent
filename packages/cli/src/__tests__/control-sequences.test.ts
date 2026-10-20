/**
 * Control-SEQUENCE removal (fix A'-1 of paste-control-sequence-residue).
 *
 * EVERY ROW BELOW IS A MEASURED CASE, not a shape somebody imagined. The table
 * is the boundary specification: whole sequences go, content stays, a truncated
 * sequence never eats the character after it, and a string-type sequence never
 * crosses a line break. Both consumers of this module -- the paste path
 * (`sanitisePaste`) and the tool-output path (`stripAnsi`) -- are asserted to
 * agree on the syntax in the cross-check at the end.
 */

import { describe, expect, it } from 'vitest';
import {
  hasPasteOnlySequence,
  stripControlSequences,
} from '../input/control-sequences.js';
import { stripAnsi } from '../tools/terminal-output.js';

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`;
const CSI_C1 = '\u009b';
const OSC_C1 = '\u009d';
const ST_C1 = '\u009c';

describe('stripControlSequences (R-3 boundary table, row by row)', () => {
  it.each([
    ['a complete SGR', `${ESC}[38;2;18;52;86mconst x = 1;${ESC}[0m`, 'const x = 1;'],
    ['a private mode pair', `${ESC}[?25lafter private mode${ESC}[?25h`, 'after private mode'],
    ['a bold-red SGR', `code ${ESC}[1;31mbold red${ESC}[0m end`, 'code bold red end'],
    ['OSC terminated by BEL', `${ESC}]0;window title${BEL}after OSC`, 'after OSC'],
    ['OSC terminated by ST', `${ESC}]0;st form${ST}after ST`, 'after ST'],
    ['a two-byte ESC form', 'a\u001bMb', 'ab'],
    // RULE 2: an unterminated string is deleted to the END OF ITS LINE, and the
    // body is never left behind as visible text. A clipboard truncates these
    // constantly, which is exactly why they cannot be left to a regex that
    // requires a terminator.
    ['an unterminated OSC', `${ESC}]0;window title truncated by the clipboard`, ''],
    ['an unterminated DCS', `${ESC}P1;2q payload of a DCS string`, ''],
    ['an unterminated APC', `${ESC}_ payload of an APC string`, ''],
    // RULE 3: parameters are not content, but the byte after them is.
    ['a torn CSI keeps the prose', `${ESC}[38;2;18;52;86 no final byte (torn CSI)`,
      ' no final byte (torn CSI)'],
    // RULE 4: C1 introducers are the same hole as C0 -- and a C1 CSI with real
    // parameters is a whole sequence, deleted whole.
    ['a C1 CSI', `${CSI_C1}38;2;18;52;86mconst x = 1;`, 'const x = 1;'],
    ['a C1 OSC', `${OSC_C1}0;title${ST_C1}after`, 'after'],
    // RULE 1's other half: text that merely LOOKS like a sequence body is data.
    ['bare parameter text', '[38;2;18;52;86mconst x = 1;', '[38;2;18;52;86mconst x = 1;'],
    ['a bracketed-paste marker body', '[200~pasted[201~', '[200~pasted[201~'],
    // Line structure and indentation are content.
    ['TAB and LF survive', `a\tb\nc`, `a\tb\nc`],
    ['a torn ESC at the very end', `abc${ESC}`, 'abc'],
    ['a lone C1 CSI byte', `a${CSI_C1}b`, 'ab'],
  ])('removes %s', (_name, input, expected) => {
    expect(stripControlSequences(input as string)).toBe(expected);
  });

  it('never lets an unterminated string cross a line break', () => {
    // The rule that keeps a truncated OSC from eating the rest of a pasted log.
    expect(stripControlSequences(`${ESC}]0;title\nnext line`)).toBe('\nnext line');
  });

  it('is idempotent', () => {
    const once = stripControlSequences(`x${ESC}[38;2;18;52;86m\ty${ESC}]0;t`);
    expect(stripControlSequences(once)).toBe(once);
  });

  it('leaves a huge input alone in one linear pass', () => {
    // 2 MB is the paste ceiling; the scan must not degrade on it.
    const body = `${'a'.repeat(2 * 1024 * 1024)}${ESC}[0m`;
    expect(stripControlSequences(body)).toHaveLength(2 * 1024 * 1024);
  });
});

describe('the cross-check with `tools/terminal-output.ts` (one syntax, two callers)', () => {
  it('agrees byte for byte on every TERMINATED sequence', () => {
    // `stripAnsi` is the display-row sweep on top of the same syntax; where the
    // sequence is complete the two must be indistinguishable, which is what
    // makes the shared module a move rather than a second opinion.
    for (const input of [
      `${ESC}[31mred${ESC}[0m`,
      `${ESC}[2K${ESC}[1;32Hmoved`,
      `${ESC}]0;a window title${BEL}after`,
      `${ESC}]0;st form${ST}after`,
      'a\u001bMb',
    ]) {
      expect(stripAnsi(input), input).toBe(stripControlSequences(input));
    }
  });
});

describe('hasPasteOnlySequence (R-2: what a KEYBOARD cannot emit)', () => {
  it('fires on an SGR a paste brought in', () => {
    expect(hasPasteOnlySequence(`${ESC}[38;2;18;52;86mconst x = 1;${ESC}[0m`)).toBe(true);
    expect(hasPasteOnlySequence(`${ESC}[32mINFO${ESC}[0m build ok`)).toBe(true);
    expect(hasPasteOnlySequence(`${CSI_C1}32mINFO`)).toBe(true);
  });

  it('fires on a string-type introducer carrying a body', () => {
    expect(hasPasteOnlySequence(`${ESC}]0;a window title${BEL}`)).toBe(true);
    expect(hasPasteOnlySequence(`${ESC}P1;2q dcs`)).toBe(true);
  });

  it('does NOT fire on an arrow / Home / End / Delete key', () => {
    // Boundary 2 of R-2: none of these ends in `m`.
    for (const key of [`${ESC}[A`, `${ESC}[1;5D`, `${ESC}[3~`, `${ESC}[Z`, `${ESC}[H`]) {
      expect(hasPasteOnlySequence(key), key).toBe(false);
    }
  });

  it('does NOT fire on a bare Alt+letter, which is exactly two bytes', () => {
    // Boundary 3 of R-2.
    expect(hasPasteOnlySequence(`${ESC}b`)).toBe(false);
    expect(hasPasteOnlySequence(`${ESC}]`)).toBe(false);
  });

  it('does NOT fire on an SGR MOUSE report (boundary 1)', () => {
    // `<` is not a parameter byte, so the SGR rule cannot see a mouse release --
    // and in the mouse-enabled session `splitMouseEvents` has already consumed
    // it before this test runs.
    expect(hasPasteOnlySequence(`${ESC}[<0;12;5M`)).toBe(false);
    expect(hasPasteOnlySequence(`${ESC}[<0;12;5m`)).toBe(false);
  });

  it('does not fire on ordinary text, TAB indent or CJK', () => {
    expect(hasPasteOnlySequence('plain text with [38;2m inside')).toBe(false);
    expect(hasPasteOnlySequence('\tindented\tcode')).toBe(false);
  });
});
