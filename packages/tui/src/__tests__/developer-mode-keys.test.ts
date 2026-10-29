/**
 * The hidden developer-mode chord and the key-frame hygiene around it
 * (tui-subagent-persona-and-developer-mode §3.3 / AC-7, AC-7b).
 *
 * Ctrl+Shift+P collides with Ctrl+P (0x10) on every legacy encoding, so the chord is
 * only reachable through the two enhanced-keyboard translators; everything else must
 * keep meaning what it meant.
 */

import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { DEV_MODE_KEY_FRAME, INDEX_KEY_FRAME } from '../input/limits.js';
import { hasKeyFrame, stripKeyFrames } from '../input/key-frames.js';
import { translateCsiUKey, type CsiUKey } from '../input/csiu-keys.js';
import { translateWin32Key } from '../input/win32-input-mode.js';
import { createStdinFilter } from '../input/stdin-filter.js';
import { stripPasteFrames } from '../ui/paste-frames.js';

const ESC = '\u001b';

/** A CSI-u key; only `code` and `mods` matter to the translator. */
const csiu = (code: number, mods: number): CsiUKey =>
  ({ code, mods, seq: '', alternates: [] }) as unknown as CsiUKey;

const win32 = (vk: number, char: number, mods: number): string =>
  translateWin32Key({ vk, scan: 25, char, down: true, mods, repeat: 1 });

describe('DEV_MODE_KEY_FRAME', () => {
  it('is a NUL-prefixed frame, like its siblings, so pasted text cannot forge it', () => {
    expect(DEV_MODE_KEY_FRAME.startsWith('\u0000')).toBe(true);
    expect(DEV_MODE_KEY_FRAME).not.toBe(INDEX_KEY_FRAME);
  });
});

describe('win32-input-mode: Ctrl+Shift+P', () => {
  it('Ctrl+Shift+P becomes the frame (both char shapes)', () => {
    // LEFT_CTRL = 8, SHIFT = 16 -> 24
    expect(win32(0x50, 0x10, 24)).toBe(DEV_MODE_KEY_FRAME);
    expect(win32(0x50, 0, 24)).toBe(DEV_MODE_KEY_FRAME);
  });

  it('Ctrl+P (no Shift) is still the prompt-library byte', () => {
    expect(win32(0x50, 0x10, 8)).toBe('\x10');
  });

  it('Ctrl+Alt+Shift+P and Shift+P are not the chord', () => {
    expect(win32(0x50, 0x10, 8 | 16 | 2)).not.toBe(DEV_MODE_KEY_FRAME);
    expect(win32(0x50, 80, 16)).toBe('P');
  });

  it('a key-up record produces nothing', () => {
    expect(translateWin32Key({ vk: 0x50, scan: 25, char: 0x10, down: false, mods: 24, repeat: 1 })).toBe('');
  });
});

describe('CSI-u: Ctrl+Shift+P', () => {
  it('maps both codepoint shapes to the frame and leaves Ctrl+P alone', () => {
    // `mods` is the CSI parameter minus one: shift = 1, alt = 2, ctrl = 4.
    expect(translateCsiUKey(csiu(112, 4))).toBe('\x10');
    expect(translateCsiUKey(csiu(112, 4 | 1))).toBe(DEV_MODE_KEY_FRAME);
    expect(translateCsiUKey(csiu(80, 4 | 1))).toBe(DEV_MODE_KEY_FRAME);
  });

  it('Alt makes it a different chord', () => {
    expect(translateCsiUKey(csiu(112, 4 | 1 | 2))).not.toBe(DEV_MODE_KEY_FRAME);
  });
});

describe('stdin filter', () => {
  const harness = (): { seen: string[]; push: (text: string) => void; dispose: () => void } => {
    const real = new PassThrough() as unknown as NodeJS.ReadStream;
    const seen: string[] = [];
    const filter = createStdinFilter(real, { mouse: false, paste: false, enhancedKeys: true });
    filter.stdin.on('data', (chunk: Buffer | string) => seen.push(String(chunk)));
    return { seen, push: (text) => { real.push(text); }, dispose: filter.dispose };
  };

  it('delivers the frame for the chord and the legacy byte for Ctrl+P', () => {
    const h = harness();
    h.push(`${ESC}[80;25;16;1;24;1_${ESC}[80;25;16;0;24;1_`);
    h.push(`${ESC}[112;6u`);
    h.push(`${ESC}[112;5u`);
    expect(h.seen.join('')).toBe(`${DEV_MODE_KEY_FRAME}${DEV_MODE_KEY_FRAME}\x10`);
    h.dispose();
  });
});

describe('stripKeyFrames (AC-7b: every text surface runs its input through this)', () => {
  it('removes both frames and leaves ordinary text alone', () => {
    expect(stripKeyFrames(DEV_MODE_KEY_FRAME)).toBe('');
    expect(stripKeyFrames(INDEX_KEY_FRAME)).toBe('');
    expect(stripKeyFrames(`ab${DEV_MODE_KEY_FRAME}cd${INDEX_KEY_FRAME}ef`)).toBe('abcdef');
    expect(stripKeyFrames('plain d i text')).toBe('plain d i text');
    expect(hasKeyFrame(`x${DEV_MODE_KEY_FRAME}`)).toBe(true);
    expect(hasKeyFrame('x')).toBe(false);
  });

  it('is what keeps the frame from typing a stray letter into a field', () => {
    // The control sweep alone removes the NUL and would leave `d` / `i` behind.
    expect(stripPasteFrames(DEV_MODE_KEY_FRAME)).toBe('');
    expect(stripPasteFrames(INDEX_KEY_FRAME)).toBe('');
    expect(stripPasteFrames(`gpt${DEV_MODE_KEY_FRAME}-5`)).toBe('gpt-5');
  });
});
