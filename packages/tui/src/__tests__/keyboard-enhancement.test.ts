/**
 * Keyboard-enhancement lifecycle -- what gets pushed and unwound, per gate.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  enableKeyboardEnhancement,
  NOOP_KEYBOARD_ENHANCEMENT,
} from '../input/keyboard-enhancement.js';

const ESC = '\u001b';

function fakeStdout(isTTY = true): { writes: string[]; stream: NodeJS.WriteStream } {
  const writes: string[] = [];
  const stream = {
    isTTY,
    write: (data: string) => {
      writes.push(data);
      return true;
    },
  };
  return { writes, stream: stream as unknown as NodeJS.WriteStream };
}

describe('enableKeyboardEnhancement (win32)', () => {
  it('pushes ?9001h and unwinds with ?9001l, exactly once', () => {
    const { writes, stream } = fakeStdout();
    const handle = enableKeyboardEnhancement(stream, {
      platform: 'win32',
      vtInputSupported: true,
    });
    expect(writes).toEqual([`${ESC}[?9001h`]);
    handle.restore();
    handle.restore();
    expect(writes).toEqual([`${ESC}[?9001h`, `${ESC}[?9001l`]);
  });

  it('writes NOTHING on a win32 host whose console cannot deliver (old Node)', () => {
    const { writes, stream } = fakeStdout();
    const handle = enableKeyboardEnhancement(stream, {
      platform: 'win32',
      vtInputSupported: false,
    });
    handle.restore();
    expect(writes).toEqual([]);
  });
});

describe('enableKeyboardEnhancement (posix)', () => {
  it.each(['darwin', 'linux'])('pushes kitty+modifyOtherKeys on %s', (platform) => {
    const { writes, stream } = fakeStdout();
    const handle = enableKeyboardEnhancement(stream, {
      platform,
      vtInputSupported: false, // the win32 gate must not leak onto posix
    });
    expect(writes).toEqual([`${ESC}[>1u${ESC}[>4;2m`]);
    handle.restore();
    expect(writes).toEqual([`${ESC}[>1u${ESC}[>4;2m`, `${ESC}[<u${ESC}[>4m`]);
  });
});

describe('enableKeyboardEnhancement (non-TTY)', () => {
  it('is a no-op for a redirected stdout, and the noop handle is inert', () => {
    const { writes, stream } = fakeStdout(false);
    expect(enableKeyboardEnhancement(stream, {
      platform: 'win32',
      vtInputSupported: true,
    })).toBe(NOOP_KEYBOARD_ENHANCEMENT);
    expect(writes).toEqual([]);
    expect(() => NOOP_KEYBOARD_ENHANCEMENT.restore()).not.toThrow();
  });

  it('never throws on a broken stream (exit-path discipline)', () => {
    const stream = {
      isTTY: true,
      write: () => {
        throw new Error('EPIPE');
      },
    } as unknown as NodeJS.WriteStream;
    const handle = enableKeyboardEnhancement(stream, {
      platform: 'darwin',
      vtInputSupported: true,
    });
    expect(() => handle.restore()).not.toThrow();
  });
});

describe('gate honesty (no hidden env reads)', () => {
  it('does not read process.env or platform globals', () => {
    const spy = vi.spyOn(process, 'platform' as never, 'get');
    enableKeyboardEnhancement(fakeStdout().stream, {
      platform: 'darwin',
      vtInputSupported: true,
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
