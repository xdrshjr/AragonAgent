/**
 * win32-input-mode translation -- byte-level contract against the probe.
 *
 * Every `ESC[..._` fixture below was captured from a REAL conhost and a REAL
 * Windows Terminal 1.24 session with `?9001h` on (Node v22.18.0, injection
 * probe in docs/diagnoses/shift-enter-newline-dead-by-default/repro). The
 * expected legacy bytes are the BASELINE probe captures for the same keys
 * with the mode off, so "translated == baseline" is the invariant under test.
 */

import { describe, expect, it } from 'vitest';
import { ENTER_NEWLINE_FRAME, INDEX_KEY_FRAME } from '../input/limits.js';
import {
  splitWin32KeySequences,
  translateWin32Key,
  trailingWin32PrefixLength,
  WIN32_INPUT_DISABLE,
  WIN32_INPUT_ENABLE,
} from '../input/win32-input-mode.js';

const ESC = '\u001b';
/** `ESC[vk;sc;char;down;mods;rep_` with defaults matching the probe's pairs. */
function rec(vk: number, scan: number, char: number, mods: number, down = true): string {
  return `${ESC}[${vk};${scan};${char};${down ? 1 : 0};${mods};1_`;
}

describe('WIN32_INPUT mode bytes', () => {
  it('enables with ?9001h and disables with ?9001l', () => {
    expect(WIN32_INPUT_ENABLE).toBe(`${ESC}[?9001h`);
    expect(WIN32_INPUT_DISABLE).toBe(`${ESC}[?9001l`);
  });
});

describe('splitWin32KeySequences', () => {
  it('splits text and records, preserving order (probe capture: a then Enter)', () => {
    const segments = splitWin32KeySequences(`x${rec(65, 30, 97, 0)}y`);
    expect(segments).toEqual([
      { kind: 'text', text: 'x' },
      { kind: 'key', record: { vk: 65, scan: 30, char: 97, down: true, mods: 0, repeat: 1 } },
      { kind: 'text', text: 'y' },
    ]);
  });

  it('splits the down/up pair the console delivers in one chunk', () => {
    const segments = splitWin32KeySequences(`${rec(13, 28, 13, 0)}${rec(13, 28, 13, 0, false)}`);
    expect(segments.filter((s) => s.kind === 'key')).toHaveLength(2);
  });

  it('does not eat a CSI-u Enter, a mouse report, or a paste marker', () => {
    for (const other of [`${ESC}[13;2u`, `${ESC}[<0;12;5M`, `${ESC}[200~`]) {
      expect(splitWin32KeySequences(other)).toEqual([{ kind: 'text', text: other }]);
    }
  });

  it('rejects a _-terminated body with the wrong field count', () => {
    expect(splitWin32KeySequences(`${ESC}[13;28;13;1_`)).toEqual([
      { kind: 'text', text: `${ESC}[13;28;13;1_` },
    ]);
  });
});

describe('translateWin32Key (translated === baseline bytes)', () => {
  // Fixture = probe capture with ?9001h; expected = probe capture without it.
  it.each([
    ['a', rec(65, 30, 97, 0), 'a'],
    ['Enter', rec(13, 28, 13, 0), '\r'],
    // Baseline bytes are \n; the intent either carries is "newline",
    // which the app represents as the frame (enter-frames maps \n the same).
    ['Ctrl+Enter', rec(13, 28, 10, 8), ENTER_NEWLINE_FRAME],
    // Baseline ESC CR is the Alt+Enter shape `ENTER_SEQUENCES` maps to a
    // newline; the frame IS that newline here.
    ['Alt+Enter', rec(13, 28, 13, 2), ENTER_NEWLINE_FRAME],
    ['Ctrl+C', rec(67, 46, 3, 8), '\x03'],
    ['Ctrl+A', rec(65, 30, 1, 8), '\x01'],
    ['Alt+B', rec(66, 48, 98, 2), `${ESC}b`],
    ['Ctrl+J', rec(74, 36, 10, 8), '\n'],
    ['Esc', rec(27, 1, 27, 0), ESC],
    ['Tab', rec(9, 15, 9, 0), '\t'],
    ['Shift+Tab', rec(9, 15, 9, 16), `${ESC}[Z`],
    // Windows synthesises the SAME Tab char 0x09 for Ctrl+I, but the vk is
    // NOT agreed on: consoles that cook the chord down send VK_TAB (9),
    // while the physical-key rule every Ctrl+letter probe capture follows
    // (Ctrl+A -> vk 65, Ctrl+J -> vk 74) sends the LETTER key 0x49. Both
    // rows below are real shapes; the tell-apart from plain Tab is ctrl,
    // and the translator is the ONLY layer that can hand the app a
    // distinct intent (INDEX frame).
    ['Ctrl+I (VK_TAB shape)', rec(9, 15, 9, 8), INDEX_KEY_FRAME],
    // Ctrl+Shift+I keeps the Shift+Tab shape: the shift meaning wins.
    ['Ctrl+Shift+I (VK_TAB shape)', rec(9, 15, 9, 24), `${ESC}[Z`],
    ['Ctrl+I (letter vk shape)', rec(73, 23, 9, 8), INDEX_KEY_FRAME],
    ['Ctrl+Shift+I (letter vk shape)', rec(73, 23, 9, 24), `${ESC}[Z`],
    ['Up', rec(38, 72, 0, 0), `${ESC}[A`],
    ['Shift+Up', rec(38, 72, 0, 16), `${ESC}[1;2A`],
    ['Ctrl+Up', rec(38, 72, 0, 8), `${ESC}[1;5A`],
    ['Ctrl+Left', rec(37, 75, 0, 8), `${ESC}[1;5D`],
    ['PgUp', rec(33, 73, 0, 0), `${ESC}[5~`],
    ['Home', rec(36, 71, 0, 0), `${ESC}[H`],
    ['End', rec(35, 79, 0, 0), `${ESC}[F`],
    ['Delete', rec(46, 83, 0, 0), `${ESC}[3~`],
  ])('%s: %s -> %j', (_name, fixture, expected) => {
    const segments = splitWin32KeySequences(fixture);
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(translateWin32Key(segments[0].record)).toBe(expected);
  });

  it('THE FIX: Shift+Enter becomes the newline frame, not CR', () => {
    const segments = splitWin32KeySequences(rec(13, 28, 13, 16));
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(translateWin32Key(segments[0].record)).toBe(ENTER_NEWLINE_FRAME);
  });

  it('drops the key-up half of every pair', () => {
    const segments = splitWin32KeySequences(rec(65, 30, 97, 0, false));
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(translateWin32Key(segments[0].record)).toBe('');
  });

  it('ignores lock-state bits in mods (CAPSLOCK_ON etc)', () => {
    const segments = splitWin32KeySequences(rec(13, 28, 13, 16 | 0x80 | 0x20));
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(translateWin32Key(segments[0].record)).toBe(ENTER_NEWLINE_FRAME);
  });

  it('AltGr (RightCtrl|RightAlt) types the composed character verbatim', () => {
    const at = rec(65, 30, 64, 0x5); // '@' on a German layout
    const segments = splitWin32KeySequences(at);
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(translateWin32Key(segments[0].record)).toBe('@');
  });

  it('Ctrl+letter by vk char already carries the control byte', () => {
    // Ctrl+P: Windows resolves char to 0x10.
    const segments = splitWin32KeySequences(rec(80, 25, 16, 8));
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(translateWin32Key(segments[0].record)).toBe('\x10');
  });

  it('Backspace family lands POST-normalisation (BS, not DEL)', () => {
    for (const [mods, expected] of [
      [0, '\x08'],
      [8, '\x08'],
      [2, `${ESC}\x08`],
    ] as const) {
      const segments = splitWin32KeySequences(rec(8, 14, 8, mods));
      expect(segments[0]?.kind).toBe('key');
      if (segments[0]?.kind !== 'key') continue;
      expect(translateWin32Key(segments[0].record)).toBe(expected);
    }
  });

  it('passes Unicode text through (IME / VK_PACKET shape)', () => {
    const segments = splitWin32KeySequences(rec(239, 57, 0x4e2d, 0));
    expect(segments[0]?.kind).toBe('key');
    if (segments[0]?.kind !== 'key') return;
    expect(translateWin32Key(segments[0].record)).toBe('\u4e2d');
  });
});

describe('trailingWin32PrefixLength', () => {
  it.each([
    ['', 0],
    ['a', 0],
    [ESC, 0],
    [`${ESC}[`, 0],
    [`${ESC}[1`, 3],
    [`${ESC}[13;28;1`, 9],
    [`x${ESC}[13`, 4],
    [`${ESC}[13;28;13;1;0;1`, 16],
  ])('%j -> %d', (text, expected) => {
    expect(trailingWin32PrefixLength(text)).toBe(expected);
  });

  it('never holds a completed record (it would add 12 ms of latency)', () => {
    expect(trailingWin32PrefixLength(rec(13, 28, 13, 16))).toBe(0);
  });
});
