/**
 * stdin filter + keyboard enhancement -- the integration contract.
 *
 * With `enhancedKeys` on, a win32-input-mode or CSI-u chunk must come out as
 * the legacy bytes the same keys produced before the mode existed; with it
 * off (or absent), the stream is byte-identical to the pre-feature filter.
 * Fixtures are the probe captures from
 * docs/diagnoses/shift-enter-newline-dead-by-default/repro.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createStdinFilter } from '../input/stdin-filter.js';
import { ENTER_NEWLINE_FRAME } from '../input/limits.js';

const ESC = '\u001b';

function harness(features: { mouse: boolean; paste: boolean; enhancedKeys?: boolean }) {
  const real = new PassThrough() as unknown as NodeJS.ReadStream;
  const seen: string[] = [];
  const filter = createStdinFilter(real, features);
  filter.stdin.on('data', (chunk: Buffer | string) => seen.push(String(chunk)));
  const push = (text: string): void => {
    real.push(text);
  };
  return { seen, push, dispose: filter.dispose };
}

/** `ESC[vk;sc;char;down;mods;rep_` -- one down record, the up half is noise. */
function rec(vk: number, scan: number, char: number, mods: number): string {
  return `${ESC}[${vk};${scan};${char};1;${mods};1_${ESC}[${vk};${scan};${char};0;${mods};1_`;
}

describe('enhancedKeys: off is the pre-feature filter', () => {
  it('passes win32 records and CSI-u sequences through untouched', () => {
    const h = harness({ mouse: false, paste: false });
    h.push(rec(65, 30, 97, 0));
    h.push('plain text\r');
    expect(h.seen).toEqual([rec(65, 30, 97, 0), 'plain text\r']);
    h.dispose();
  });

  it('absent enhancedKeys still runs the PRE-EXISTING CSI-u Enter table', () => {
    // `\x1b[13;2u` was translated by `enter-sequences.ts` long before this
    // feature existed: a hand-made terminal binding keeps working unchanged.
    const h = harness({ mouse: false, paste: false, enhancedKeys: undefined });
    h.push(`${ESC}[13;2u`);
    expect(h.seen).toEqual([ENTER_NEWLINE_FRAME]);
    h.dispose();
  });
});

describe('enhancedKeys: on translates the whole probe matrix', () => {
  it.each([
    ['a', rec(65, 30, 97, 0), 'a'],
    ['Enter', rec(13, 28, 13, 0), '\r'],
    ['Ctrl+C', rec(67, 46, 3, 8), '\x03'],
    ['Esc', rec(27, 1, 27, 0), ESC],
    ['Shift+Tab', rec(9, 15, 9, 16), `${ESC}[Z`],
    ['Shift+Up', rec(38, 72, 0, 16), `${ESC}[1;2A`],
    ['Ctrl+Left', rec(37, 75, 0, 8), `${ESC}[1;5D`],
  ])('%s -> legacy bytes', (_name, input, expected) => {
    const h = harness({ mouse: false, paste: false, enhancedKeys: true });
    h.push(input);
    expect(h.seen).toEqual([expected]);
    h.dispose();
  });

  it('THE FIX: Shift+Enter reaches Ink as one newline frame', () => {
    const h = harness({ mouse: false, paste: false, enhancedKeys: true });
    h.push(rec(13, 28, 13, 16));
    expect(h.seen).toEqual([ENTER_NEWLINE_FRAME]);
    h.dispose();
  });

  it('CSI-u Shift+Enter also reaches Ink as the newline frame', () => {
    const h = harness({ mouse: false, paste: false, enhancedKeys: true });
    h.push(`${ESC}[13;2u`);
    expect(h.seen).toEqual([ENTER_NEWLINE_FRAME]);
    h.dispose();
  });

  it('a record torn across chunks is assembled, not mangled', async () => {
    const h = harness({ mouse: false, paste: false, enhancedKeys: true });
    h.push(`${ESC}[13;28;13;1;16;`);
    h.push(`1_`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.seen).toEqual([ENTER_NEWLINE_FRAME]);
    h.dispose();
  });

  it('a torn tail that never completes flushes as text after 12 ms', async () => {
    const h = harness({ mouse: false, paste: false, enhancedKeys: true });
    h.push(`${ESC}[13;28;1`);
    expect(h.seen).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.seen).toEqual([`${ESC}[13;28;1`]);
    h.dispose();
  });

  it('bracketed paste bodies are never translated (payload is data)', () => {
    const h = harness({ mouse: false, paste: true, enhancedKeys: true });
    h.push(`${ESC}[200~${rec(13, 28, 13, 16)}${ESC}[201~`);
    // The paste path frames the payload as sanitised TEXT: ESC bytes are
    // stripped and no ENTER_NEWLINE_FRAME ever appears -- a record inside a
    // paste is data, never a key.
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]).not.toContain(ENTER_NEWLINE_FRAME);
    expect(h.seen[0]).not.toContain('\r');
    h.dispose();
  });

  it('typing mixed with a record preserves order', () => {
    const h = harness({ mouse: false, paste: false, enhancedKeys: true });
    h.push(`ab${rec(13, 28, 13, 16)}cd`);
    // Three writes -- the record splits the text runs -- in stream order.
    expect(h.seen).toEqual(['ab', ENTER_NEWLINE_FRAME, 'cd']);
    h.dispose();
  });
});
