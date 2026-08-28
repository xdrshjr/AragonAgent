/**
 * The clipboard (tui-selection-and-scroll-follow §4.4.5).
 *
 * `copyText` spawns a platform binary as its second mechanism, so every case here
 * asserts on the OSC 52 half — the one that is deterministic, the one that works
 * over SSH, and the one whose payload shape a terminal will silently reject if it
 * is wrong.
 */

import { describe, expect, it } from 'vitest';
import { copyText, osc52, MAX_OSC52_BYTES, type CopyVia } from '../ui/clipboard.js';

describe('osc52', () => {
  it('T-14: is `ESC ] 52 ; c ; <base64> BEL`', () => {
    // `c` is the CLIPBOARD selection, not PRIMARY: a PRIMARY write would go to
    // the X11 middle-click buffer, which is not what "copy" means anywhere else.
    expect(osc52('hi')).toBe(`\x1b]52;c;${Buffer.from('hi').toString('base64')}\x07`);
  });

  it('encodes non-ASCII as UTF-8 before base64', () => {
    const text = '你好 \u{1F600}';
    expect(osc52(text)).toBe(`\x1b]52;c;${Buffer.from(text, 'utf-8').toString('base64')}\x07`);
  });
});

describe('copyText', () => {
  it('T-14: writes through the door it is given and reports `osc52`', () => {
    const writes: string[] = [];
    const via = copyText('hello', (chunk) => writes.push(chunk));
    expect(writes).toEqual([osc52('hello')]);
    expect(via).toBe('osc52');
  });

  it('T-14: skips OSC 52 past the ceiling and falls back to the native path', () => {
    // ═══ SKIPPED RATHER THAN TRUNCATED ═══
    //
    // xterm's default limit is around 100 000 BASE64 characters and tmux / screen
    // are stricter. A terminal that drops an over-long OSC 52 leaves the
    // clipboard holding whatever was there before, and half a selection pasted
    // into a shell is worse than none.
    const writes: string[] = [];
    const via: CopyVia = copyText('x'.repeat(MAX_OSC52_BYTES + 1), (chunk) => writes.push(chunk));
    expect(writes).toEqual([]);
    expect(via).not.toBe('osc52');
  });

  it('measures the ceiling in BYTES, not characters', () => {
    // A CJK character is three UTF-8 bytes, so a character-based ceiling would
    // let a payload three times the intended size onto the wire.
    const writes: string[] = [];
    // Just over the ceiling in bytes, well under it in characters.
    copyText('你'.repeat(Math.ceil(MAX_OSC52_BYTES / 3) + 1), (chunk) => writes.push(chunk));
    expect(writes).toEqual([]);
  });

  it('skips OSC 52 entirely when no door is supplied', () => {
    // A caller with no terminal to write to (inline mode, a test) must not have
    // an escape sequence invented for it.
    expect(['native', 'none']).toContain(copyText('hello'));
  });

  it('never throws when the door does', () => {
    // A closed or broken stdout must not turn a copy into a crash on the way out.
    expect(() =>
      copyText('hello', () => {
        throw new Error('EPIPE');
      }),
    ).not.toThrow();
  });

  it('reports `none` for empty text without touching either mechanism', () => {
    const writes: string[] = [];
    expect(copyText('', (chunk) => writes.push(chunk))).toBe('none');
    expect(writes).toEqual([]);
  });
});
