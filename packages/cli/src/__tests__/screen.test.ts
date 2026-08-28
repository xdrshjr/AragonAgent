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

/**
 * Mouse reporting rides inside the SAME idempotent handle four independent exit
 * paths already call (`process.on('exit')`, the crash handler, the signal
 * terminator, `waitUntilExit()`). That is the whole of I-2, and it is why the
 * sequences are not written from `App.tsx` — a component on none of them.
 */
describe('enterAltScreen — mouse reporting (mouse-wheel-region-routing §4.3)', () => {
  it('writes the mouse enable pair only when options.mouse is true', () => {
    const on = fakeStdout(true);
    enterAltScreen(on.stdout, { mouse: true });
    expect(on.all()).toContain('\x1b[?1000h');
    expect(on.all()).toContain('\x1b[?1006h');

    const off = fakeStdout(true);
    enterAltScreen(off.stdout, { mouse: false });
    expect(off.all()).not.toContain('\x1b[?1000h');
    expect(off.all()).not.toContain('\x1b[?1006h');

    // The default is `{ mouse: false }`, so a caller that says nothing can
    // never enable reporting by accident (I-8).
    const silent = fakeStdout(true);
    enterAltScreen(silent.stdout);
    expect(silent.all()).not.toContain('\x1b[?1000h');
  });

  it('disables mouse reporting before leaving the alternate screen', () => {
    // I-2. Left on, the user's shell prints `[<0;12;5M` on every click, forever,
    // until they run `reset`.
    const { stdout, all } = fakeStdout(true);
    enterAltScreen(stdout, { mouse: true }).restore();
    const text = all();
    expect(text).toContain('\x1b[?1000l');
    expect(text).toContain('\x1b[?1006l');
    expect(text.indexOf('\x1b[?1000l')).toBeLessThan(text.indexOf('\x1b[?1049l'));
  });

  it('restore stays idempotent with mouse enabled', () => {
    const { stdout, all } = fakeStdout(true);
    const handle = enterAltScreen(stdout, { mouse: true });
    handle.restore();
    handle.restore();
    handle.restore();
    expect(all().split('\x1b[?1000l').length - 1).toBe(1);
    expect(all().split('\x1b[?1049l').length - 1).toBe(1);
  });

  it('saves and restores alternate scroll rather than forcing it on', () => {
    // P1-6: 1007 is GLOBAL terminal state this app does not own. A user who
    // deliberately turned alternate scroll off must not have it switched back
    // on by running `aragon --no-mouse` once.
    const { stdout, all } = fakeStdout(true);
    enterAltScreen(stdout, { mouse: false }).restore();
    const text = all();
    expect(text).toContain('\x1b[?1007s'); // XTSAVE on the way in
    expect(text).toContain('\x1b[?1007l'); // then off
    expect(text).toContain('\x1b[?1007r'); // XTRESTORE on the way out
    expect(text).not.toContain('\x1b[?1007h'); // never force-set
  });

  it('leaves alternate scroll alone entirely when reporting is on', () => {
    // `?1000h` already suppresses it by definition; a second mutation of shared
    // state would buy nothing.
    const { stdout, all } = fakeStdout(true);
    enterAltScreen(stdout, { mouse: true }).restore();
    expect(all()).not.toContain('\x1b[?1007');
  });

  it('writes nothing at all on a non-TTY stdout, mouse or not', () => {
    // I-5, restated for the new option: an opt-out that is not an opt-out is a
    // regression risk for every existing user.
    const { stdout, writes } = fakeStdout(false);
    enterAltScreen(stdout, { mouse: true }).restore();
    expect(writes).toEqual([]);
  });
});

/**
 * Motion reporting and the run-time escape hatch
 * (tui-selection-and-scroll-follow §4.4.1 / §4.4.6).
 */
describe('enterAltScreen — motion reporting and /mouse', () => {
  it('T-34 / AC-8: `motion: false` is BYTE-EQUAL to the pre-change constants', () => {
    // ═══ THIS IS WHAT MAKES "S3 IS REVERTIBLE" A FACT RATHER THAN A CLAIM ═══
    //
    // `?1002h` is gated on the resolved `mouseSelect`, so a wheel-only session
    // writes exactly the bytes it wrote before this feature existed. An
    // unconditional `?1002h` would have made AC-8 fail on day one — and an
    // acceptance criterion that cannot pass gets relaxed rather than met (D-15).
    const withFlag = fakeStdout(true);
    enterAltScreen(withFlag.stdout, { mouse: true, motion: false }).restore();
    const silent = fakeStdout(true);
    enterAltScreen(silent.stdout, { mouse: true }).restore();
    expect(withFlag.all()).toBe(silent.all());
    expect(withFlag.all()).not.toContain('\x1b[?1002');
  });

  it('writes ?1002h only when motion is asked for, inside the existing pair', () => {
    const { stdout, all } = fakeStdout(true);
    enterAltScreen(stdout, { mouse: true, motion: true });
    const text = all();
    expect(text).toContain('\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  });

  it('AC-7: enable and disable are exact reverses for both values of motion', () => {
    // I-1. Reporting left on prints `[<0;12;5M` in the user's shell on every
    // click, forever, until they run `reset`.
    for (const motion of [false, true]) {
      const { stdout, all } = fakeStdout(true);
      enterAltScreen(stdout, { mouse: true, motion }).restore();
      const text = all();
      const enable = motion ? '\x1b[?1000h\x1b[?1002h\x1b[?1006h' : '\x1b[?1000h\x1b[?1006h';
      const disable = motion ? '\x1b[?1006l\x1b[?1002l\x1b[?1000l' : '\x1b[?1006l\x1b[?1000l';
      expect(text).toContain(enable);
      expect(text).toContain(disable);
      expect(text.indexOf(disable)).toBeLessThan(text.indexOf('\x1b[?1049l'));
    }
  });

  it('T-33 / AC-14: /mouse off moves DEC 1007 in strict pairing with the capture', () => {
    // ═══ DROPPING 1007 RE-ARMS THE BUG mouse-wheel-region-routing REMOVED ═══
    //
    // With reporting OFF, alternate scroll turns every wheel notch into a burst
    // of arrow keys, which `PromptInput` reads as prompt-history recall —
    // replacing the user's draft with an old prompt. A `/mouse off` that wrote
    // only `DISABLE_MOUSE` would hand that defect back on request, in the one
    // command whose entire purpose is to make things better (P1-1).
    const { stdout, writes } = fakeStdout(true);
    const handle = enterAltScreen(stdout, { mouse: true, motion: true });
    writes.length = 0;

    handle.setMouseCapture(false);
    const off = writes.join('');
    expect(off).toBe('\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1007s\x1b[?1007l');
    // Saved, never force-set: a user who deliberately disabled alternate scroll
    // must not have it switched back on by running `/mouse off` once.
    expect(off).not.toContain('\x1b[?1007h');

    writes.length = 0;
    handle.setMouseCapture(true);
    // The exact reverse, and the save is redeemed BEFORE reporting resumes.
    expect(writes.join('')).toBe('\x1b[?1007r\x1b[?1000h\x1b[?1002h\x1b[?1006h');
  });

  it('T-33: restore() unwinds the CURRENT state, not the one the session started in', () => {
    // The exit path is the one place where being wrong leaves the user's shell
    // broken until they run `reset`. A `restore()` that closed over the immutable
    // startup `mouse` flag would disable reporting that is already off and leave
    // OUR alternate-scroll save outstanding (I-10).
    const { stdout, writes } = fakeStdout(true);
    const handle = enterAltScreen(stdout, { mouse: true, motion: true });
    handle.setMouseCapture(false);
    writes.length = 0;
    handle.restore();
    const tail = writes.join('');
    expect(tail).not.toContain('\x1b[?1000l'); // already released
    expect(tail).toContain('\x1b[?1007r'); // our save, redeemed exactly once
    expect(tail).toContain('\x1b[?1049l');
  });

  it('AC-10: off then on leaves the terminal in the startup reporting state', () => {
    const { stdout, writes } = fakeStdout(true);
    const handle = enterAltScreen(stdout, { mouse: true, motion: true });
    handle.setMouseCapture(false);
    handle.setMouseCapture(true);
    writes.length = 0;
    handle.restore();
    const tail = writes.join('');
    // Back to the untoggled shape: reporting disabled, and no outstanding save.
    expect(tail).toContain('\x1b[?1006l\x1b[?1002l\x1b[?1000l');
    expect(tail).not.toContain('\x1b[?1007r');
  });

  it('T-23: writes exactly the bytes it writes today when the option is absent', () => {
    for (const mouse of [true, false]) {
      const { stdout, all } = fakeStdout(true);
      enterAltScreen(stdout, { mouse }).restore();
      const text = all();
      const saves = text.split('\x1b[?1007s').length - 1;
      const restores = text.split('\x1b[?1007r').length - 1;
      // With reporting on, 1007 is left alone entirely (`?1000h` suppresses it);
      // with it off, exactly one save and one restore, as before this feature.
      expect(saves, `mouse=${mouse}`).toBe(mouse ? 0 : 1);
      expect(restores, `mouse=${mouse}`).toBe(mouse ? 0 : 1);
    }
  });

  it('is a no-op in both directions when the session never had a filter', () => {
    // Enabling reporting without a filter in front of Ink types `[<0;12;5M` into
    // the user's message on every click — strictly worse than the bug being
    // fixed (I-8).
    const { stdout, writes } = fakeStdout(true);
    const handle = enterAltScreen(stdout, { mouse: false });
    writes.length = 0;
    handle.setMouseCapture(true);
    handle.setMouseCapture(false);
    expect(writes).toEqual([]);
  });

  it('is idempotent, so a repeated /mouse off writes nothing the second time', () => {
    const { stdout, writes } = fakeStdout(true);
    const handle = enterAltScreen(stdout, { mouse: true, motion: true });
    handle.setMouseCapture(false);
    writes.length = 0;
    handle.setMouseCapture(false);
    expect(writes).toEqual([]);
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

/**
 * Bracketed paste (tui-paste-handling section 5.2, T-23 / T-24).
 *
 * `?2004h` left set after a `kill` makes EVERY subsequent paste in the user's
 * shell arrive wrapped in a literal `[200~` / `[201~`, fixable only by `reset`.
 * That is strictly worse than the bug this feature fixes, which is why the
 * enable is gated on a filter being installed and the disable rides the same
 * idempotent handle all four exit paths already call.
 */
describe('enterAltScreen — bracketed paste (I-1 / I-2)', () => {
  const ENABLE = '\x1b[?2004h';
  const DISABLE = '\x1b[?2004l';

  it('T-23: writes exactly the bytes it writes today when the option is absent', () => {
    const off = fakeStdout(true);
    enterAltScreen(off.stdout, { mouse: false }).restore();
    expect(off.all()).not.toContain(ENABLE);
    expect(off.all()).not.toContain(DISABLE);

    const withMouse = fakeStdout(true);
    enterAltScreen(withMouse.stdout, { mouse: true, motion: true }).restore();
    expect(withMouse.all()).not.toContain(ENABLE);
  });

  it('writes ?2004h on entry only when bracketedPaste is true', () => {
    const { stdout, all } = fakeStdout(true);
    enterAltScreen(stdout, { mouse: false, bracketedPaste: true });
    expect(all()).toContain(ENABLE);
  });

  it('T-24: restore() writes ?2004l BEFORE leaving the alternate screen, exactly once', () => {
    const { stdout, all } = fakeStdout(true);
    const handle = enterAltScreen(stdout, { mouse: true, bracketedPaste: true });
    handle.restore();
    handle.restore();
    handle.restore();

    const out = all();
    expect(out.split(DISABLE).length - 1).toBe(1);
    expect(out.indexOf(DISABLE)).toBeLessThan(out.indexOf('\x1b[?1049l'));
  });

  it('does not write ?2004l when the session never enabled it', () => {
    const { stdout, all } = fakeStdout(true);
    enterAltScreen(stdout, { mouse: true }).restore();
    expect(all()).not.toContain(DISABLE);
  });

  it('setMouseCapture never touches DEC 2004 (I-16 / P2-7)', () => {
    // `/mouse off` releases the pointer; it says nothing about pasting. A user
    // who turns the mouse off mid-session to select text with their terminal
    // must not silently lose Tier 1 detection as well.
    const { stdout, all } = fakeStdout(true);
    const handle = enterAltScreen(stdout, { mouse: true, bracketedPaste: true });
    const afterEnter = all().length;
    handle.setMouseCapture(false);
    handle.setMouseCapture(true);
    const mid = all().slice(afterEnter);
    expect(mid).not.toContain(ENABLE);
    expect(mid).not.toContain(DISABLE);
    // ...and the exit still unwinds it exactly once.
    handle.restore();
    expect(all().split(DISABLE).length - 1).toBe(1);
  });
});
