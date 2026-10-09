/**
 * CSI-u key translation -- the posix half of the Shift+Enter newline fix.
 *
 * Fixtures follow the kitty keyboard protocol and xterm modifyOtherKeys=2
 * encodings for the keys this app consumes. The invariants: translated output
 * equals the legacy bytes the same key produced before the mode existed,
 * modified Enter never submits, and anything outside the translated set
 * passes through untouched (pre-enhancement behaviour).
 */

import { describe, expect, it } from 'vitest';
import { ENTER_NEWLINE_FRAME } from '../input/limits.js';
import {
  CSI_U_DISABLE,
  CSI_U_ENABLE,
  splitCsiUKeys,
  translateCsiUKey,
  trailingCsiUPrefixLength,
} from '../input/csiu-keys.js';

const ESC = '\u001b';

describe('CSI_U mode bytes', () => {
  it('pushes kitty disambiguate + modifyOtherKeys=2, pops both', () => {
    expect(CSI_U_ENABLE).toBe(`${ESC}[>1u${ESC}[>4;2m`);
    expect(CSI_U_DISABLE).toBe(`${ESC}[<u${ESC}[>4m`);
  });
});

describe('splitCsiUKeys', () => {
  it('splits text and CSI-u sequences, preserving order', () => {
    const segments = splitCsiUKeys(`x${ESC}[97;5uy`);
    expect(segments).toEqual([
      { kind: 'text', text: 'x' },
      { kind: 'key', key: { seq: `${ESC}[97;5u`, code: 97, alternates: [], mods: 4 } },
      { kind: 'text', text: 'y' },
    ]);
  });

  it('parses kitty alternate-key sub-parameters (shifted and base)', () => {
    const segments = splitCsiUKeys(`${ESC}[97:65;2u`);
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(segments[0].key.alternates).toEqual([65]);
    expect(segments[0].key.mods).toBe(1);
  });

  it('ignores modifier sub-parameter digits beyond the first', () => {
    const segments = splitCsiUKeys(`${ESC}[97;5:1u`);
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(segments[0].key.mods).toBe(4);
  });

  it('passes malformed bodies through as text: empty, huge, over-range mods', () => {
    for (const bad of [`${ESC}[u`, `${ESC}[99999999999999999999u`, `${ESC}[97;99999u`]) {
      expect(splitCsiUKeys(bad)).toEqual([{ kind: 'text', text: bad }]);
    }
  });

  it('treats empty parameter fields as defaults, never NaN', () => {
    // empty modifier field defaults to unmodified; third field is text-as-codepoints
    expect(splitCsiUKeys(`${ESC}[97;;2u`)).toEqual([
      { kind: 'key', key: { seq: `${ESC}[97;;2u`, code: 97, alternates: [], mods: 0 } },
    ]);
  });

  it('does not eat legacy sequences that merely share the ESC head', () => {
    for (const other of [`${ESC}[1;5A`, `${ESC}[200~`, `${ESC}[<0;12;5M`, `${ESC}\r`]) {
      expect(splitCsiUKeys(other)).toEqual([{ kind: 'text', text: other }]);
    }
  });
});

describe('translateCsiUKey (translated === legacy bytes)', () => {
  it.each([
    ['plain CSI-u Enter', `${ESC}[13u`, '\r'],
    ['CSI-u Enter with ;1', `${ESC}[13;1u`, '\r'],
    ['Ctrl+C', `${ESC}[99;5u`, '\x03'],
    ['Ctrl+P', `${ESC}[112;5u`, '\x10'],
    ['Ctrl+A', `${ESC}[97;5u`, '\x01'],
    ['Ctrl+J', `${ESC}[106;5u`, '\n'],
    ['Ctrl+Space', `${ESC}[32;5u`, '\x00'],
    ['Alt+B', `${ESC}[98;3u`, `${ESC}b`],
    ['Ctrl+Alt+B', `${ESC}[98;7u`, `${ESC}\x02`],
    ['lone Esc (kitty)', `${ESC}[27u`, ESC],
    ['Alt+Esc', `${ESC}[27;3u`, `${ESC}${ESC}`],
    ['plain Tab', `${ESC}[9u`, '\t'],
    ['Shift+Tab', `${ESC}[9;2u`, `${ESC}[Z`],
    ['Ctrl+Backspace', `${ESC}[127;5u`, '\x08'],
    ['Alt+Backspace', `${ESC}[127;3u`, `${ESC}\x08`],
    ['plain space', `${ESC}[32u`, ' '],
  ])('%s: %s -> %j', (_name, seq, expected) => {
    const segments = splitCsiUKeys(seq);
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(translateCsiUKey(segments[0].key)).toBe(expected);
  });

  it.each([2, 3, 4, 5, 6, 7, 8].map((m) => [`mods ${m}`, `${ESC}[13;${m}u`] as const))(
    'THE FIX: modified Enter (%s) becomes the newline frame',
    (_name, seq) => {
      const segments = splitCsiUKeys(seq);
      expect(segments[0]?.kind).toBe('key');
      if (segments[0]?.kind !== 'key') return;
      expect(translateCsiUKey(segments[0].key)).toBe(ENTER_NEWLINE_FRAME);
    },
  );

  it('uses the shifted alternate for Shift+letter under modifyOtherKeys=2', () => {
    const segments = splitCsiUKeys(`${ESC}[97:65;2u`);
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(translateCsiUKey(segments[0].key)).toBe('A');
  });

  it('keeps Ctrl on unmapped keys as legacy: Ctrl+digit types the digit', () => {
    const segments = splitCsiUKeys(`${ESC}[49;5u`);
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(translateCsiUKey(segments[0].key)).toBe('1');
  });

  it('falls back to the base char when Shift arrives without an alternate', () => {
    const segments = splitCsiUKeys(`${ESC}[97;2u`);
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(translateCsiUKey(segments[0].key)).toBe('a');
  });

  it('passes unknown functional-key codes through untouched', () => {
    const seq = `${ESC}[57414;5u`; // a kitty PUA code only flags 2+ ever send
    const segments = splitCsiUKeys(seq);
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(translateCsiUKey(segments[0].key)).toBe(seq);
  });
});

describe('trailingCsiUPrefixLength', () => {
  it.each([
    ['', 0],
    ['a', 0],
    [ESC, 0],
    [`${ESC}[`, 0],
    [`${ESC}[9`, 3],
    [`${ESC}[13;`, 5],
    [`${ESC}[57414;`, 8],
    [`x${ESC}[1`, 3],
  ])('%j -> %d', (text, expected) => {
    expect(trailingCsiUPrefixLength(text)).toBe(expected);
  });

  it('never holds a completed sequence', () => {
    expect(trailingCsiUPrefixLength(`${ESC}[13;2u`)).toBe(0);
  });
});
