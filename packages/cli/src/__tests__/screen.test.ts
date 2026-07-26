import { describe, expect, it } from 'vitest';
import { enterAltScreen, writeExitTranscript } from '../ui/screen.js';

function fakeStdout(isTTY: boolean) {
  const writes: string[] = [];
  const stdout = {
    isTTY,
    write(s: string) {
      writes.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stdout, writes, all: () => writes.join('') };
}

describe('enterAltScreen', () => {
  it('enters the alternate screen and homes the cursor on a TTY', () => {
    const { stdout, all } = fakeStdout(true);
    enterAltScreen(stdout);
    expect(all()).toContain('\x1b[?1049h');
    expect(all()).toContain('\x1b[H');
  });

  it('restore() is idempotent — three calls leave exactly one ?1049l', () => {
    const { stdout, all } = fakeStdout(true);
    const handle = enterAltScreen(stdout);
    handle.restore();
    handle.restore();
    handle.restore();
    const occurrences = all().split('\x1b[?1049l').length - 1;
    expect(occurrences).toBe(1);
  });

  it('restores the cursor visibility Ink hid', () => {
    const { stdout, all } = fakeStdout(true);
    enterAltScreen(stdout).restore();
    expect(all()).toContain('\x1b[?25h');
  });

  it('writes nothing at all on a non-TTY stdout', () => {
    const { stdout, writes } = fakeStdout(false);
    const handle = enterAltScreen(stdout);
    handle.restore();
    expect(writes).toEqual([]);
  });

  it('is a no-op for a missing stdout', () => {
    expect(() => enterAltScreen(undefined).restore()).not.toThrow();
  });
});

describe('writeExitTranscript', () => {
  it('appends a trailing newline exactly once', () => {
    const a = fakeStdout(true);
    writeExitTranscript(a.stdout, 'hello');
    expect(a.all()).toBe('hello\n');

    const b = fakeStdout(true);
    writeExitTranscript(b.stdout, 'hello\n');
    expect(b.all()).toBe('hello\n');
  });

  it('writes nothing for empty text', () => {
    const { stdout, writes } = fakeStdout(true);
    writeExitTranscript(stdout, '');
    expect(writes).toEqual([]);
  });
});
