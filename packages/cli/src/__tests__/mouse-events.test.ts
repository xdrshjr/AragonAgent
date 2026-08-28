import { describe, expect, it } from 'vitest';
import {
  isMousePrefix,
  MAX_PENDING_MOUSE_CHARS,
  splitMouseEvents,
  type MouseEvent,
} from '../input/mouse-events.js';

/**
 * `dir` only exists on a wheel event, and the channel now carries buttons too.
 * A narrowing helper keeps these cases readable without an `as` that would let a
 * button event through unnoticed.
 */
const dirOf = (event: MouseEvent | undefined): string | undefined =>
  event && event.kind === 'wheel' ? event.dir : undefined;

/** Written as an escape, not a raw byte, so an editor that stripped the control
 *  character could not leave a test that asserts nothing and still passes. */
const ESC = '\u001B';

/** `\x1b[<b;x;yM` — the SGR form we request via `?1006h`. */
const sgr = (b: number, x: number, y: number, final = 'M'): string =>
  `${ESC}[<${b};${x};${y}${final}`;

describe('splitMouseEvents — SGR wheel reports', () => {
  it('parses an SGR wheel-up report and reports 1-based coordinates', () => {
    const split = splitMouseEvents(sgr(64, 37, 9));
    expect(split.text).toBe('');
    expect(split.pending).toBe('');
    expect(split.events).toEqual([
      { kind: 'wheel', dir: 'up', x: 37, y: 9, shift: false, alt: false, ctrl: false },
    ]);
  });

  it('maps button 65 to wheel-down and 64 to wheel-up', () => {
    expect(dirOf(splitMouseEvents(sgr(64, 1, 1)).events[0])).toBe('up');
    expect(dirOf(splitMouseEvents(sgr(65, 1, 1)).events[0])).toBe('down');
  });

  it('decodes shift / alt / ctrl modifier bits', () => {
    const shifted = splitMouseEvents(sgr(64 + 4, 1, 1)).events[0];
    expect(shifted).toMatchObject({ dir: 'up', shift: true, alt: false, ctrl: false });
    const alted = splitMouseEvents(sgr(64 + 8, 1, 1)).events[0];
    expect(alted).toMatchObject({ shift: false, alt: true, ctrl: false });
    const ctrled = splitMouseEvents(sgr(64 + 16, 1, 1)).events[0];
    expect(ctrled).toMatchObject({ shift: false, alt: false, ctrl: true });
  });

  it('drops horizontal wheel buttons 66 and 67', () => {
    // 66 has `b & 1 === 0` and would decode as 'up' if the horizontal test came
    // after the direction decode — the whole reason that order is specified.
    for (const button of [66, 67]) {
      const split = splitMouseEvents(sgr(button, 10, 10));
      expect(split.events).toEqual([]);
      expect(split.text).toBe('');
    }
  });

  it('never leaks a press / release / drag report into the passthrough text', () => {
    // I-1: a report that leaks reaches Ink's key parser, fails `fnKeyRe`, and is
    // INSERTED into the user's message — `[` is 0x5B, so `isControlSeq` passes it.
    // The events are now EMITTED as well as consumed (§4.4.2); what must never
    // change is that not one byte of the report reaches Ink.
    for (const report of [sgr(0, 5, 5), sgr(0, 5, 5, 'm'), sgr(32, 5, 5)]) {
      const split = splitMouseEvents(report);
      expect(split.text).toBe('');
      expect(split.pending).toBe('');
    }
  });

  it('ignores a wheel RELEASE so one notch is never two steps', () => {
    expect(splitMouseEvents(sgr(64, 1, 1, 'm')).events).toEqual([]);
    expect(splitMouseEvents(sgr(64, 1, 1, 'm')).text).toBe('');
  });

  it('keeps surrounding keystrokes in the passthrough text, in order', () => {
    const split = splitMouseEvents(`ab${sgr(64, 1, 2)}cd${sgr(65, 3, 4)}ef`);
    expect(split.text).toBe('abcdef');
    expect(split.events.map(dirOf)).toEqual(['up', 'down']);
  });

  it('leaves a non-mouse escape sequence intact for Ink', () => {
    // Arrow keys, function keys and bracketed paste all start with ESC and must
    // reach Ink byte-for-byte.
    const split = splitMouseEvents(`${ESC}[A${ESC}[6~`);
    expect(split.text).toBe(`${ESC}[A${ESC}[6~`);
    expect(split.events).toEqual([]);
  });
});

describe('splitMouseEvents — chunk boundaries', () => {
  it('holds a split report as pending and completes it on the next chunk', () => {
    const report = sgr(64, 12, 34);
    const first = splitMouseEvents(`x${report.slice(0, 6)}`);
    expect(first.text).toBe('x');
    expect(first.events).toEqual([]);
    expect(first.pending).toBe(report.slice(0, 6));

    const second = splitMouseEvents(first.pending + report.slice(6) + 'y');
    expect(second.events).toEqual([
      { kind: 'wheel', dir: 'up', x: 12, y: 34, shift: false, alt: false, ctrl: false },
    ]);
    expect(second.text).toBe('y');
    expect(second.pending).toBe('');
  });

  it('flushes as text once the pending tail exceeds MAX_PENDING_MOUSE_CHARS', () => {
    // A malformed sequence must never be able to wedge input.
    const runaway = `${ESC}[<${'1'.repeat(MAX_PENDING_MOUSE_CHARS)}`;
    const split = splitMouseEvents(runaway);
    expect(split.pending).toBe('');
    expect(split.text).toBe(runaway);
  });

  it('treats a lone ESC as a prefix, and never as one that cannot resolve', () => {
    // Held for at most the filter's 12 ms flush timer — long enough to complete
    // a real report, short enough that Esc (which aborts a run) still works.
    expect(splitMouseEvents(ESC).pending).toBe(ESC);
    expect(splitMouseEvents(`${ESC}[`).pending).toBe(`${ESC}[`);
    expect(splitMouseEvents(`${ESC}[<`).pending).toBe(`${ESC}[<`);
    // ...and a completed non-mouse sequence resolves immediately.
    expect(splitMouseEvents(`${ESC}a`).pending).toBe('');
    expect(splitMouseEvents(`${ESC}a`).text).toBe(`${ESC}a`);
  });
});

describe('splitMouseEvents — legacy X10 (`?1006` unsupported)', () => {
  it('consumes a legacy X10 report rather than leaking it', () => {
    // 96 = 32 + 64 (wheel up); coordinates are `code - 32`.
    const x10 = `${ESC}[M${String.fromCharCode(96, 32 + 8, 32 + 3)}`;
    const split = splitMouseEvents(`a${x10}b`);
    expect(split.text).toBe('ab');
    expect(split.events).toEqual([
      { kind: 'wheel', dir: 'up', x: 8, y: 3, shift: false, alt: false, ctrl: false },
    ]);
  });

  it('drops an X10 report whose bytes were mangled by utf8 decoding', () => {
    // Consumed either way — a leak is the failure that matters (R-8).
    const mangled = `${ESC}[M${String.fromCharCode(96, 31, 40)}`;
    const split = splitMouseEvents(mangled);
    expect(split.events).toEqual([]);
    expect(split.text).toBe('');
  });

  it('holds a truncated X10 report as pending', () => {
    const partial = `${ESC}[M${String.fromCharCode(96)}`;
    expect(splitMouseEvents(partial).pending).toBe(partial);
  });

  it('T-28: yields wheel events only — never press / drag / release', () => {
    // I-11, AND THE STUCK-`hold` FREEZE HAS NO OTHER GUARD AT THE PARSER.
    //
    // X10 has no separate release form: it encodes a release as button 3 of a
    // press, and `matchX10` hard-codes `final = 'M'`. Decoded as a button event
    // that would be a `press` with no matching `release`, whose `button` is 3
    // while the type says `0 | 1 | 2` — and a `hold` that is set and never
    // cleared freezes the transcript for the rest of the session, silently, with
    // no key that recovers it.
    const x10 = (b: number, x: number, y: number): string =>
      `${ESC}[M${String.fromCharCode(b + 32, x + 32, y + 32)}`;
    // 0 = left press, 3 = "release" (the form that cannot be told from a press),
    // 32 = motion, 2 = right press.
    for (const button of [0, 2, 3, 32, 32 + 3]) {
      const split = splitMouseEvents(x10(button, 8, 3));
      expect(split.events, `X10 button ${button}`).toEqual([]);
      // Still CONSUMED, which is the reason this branch exists at all (I-1).
      expect(split.text, `X10 button ${button}`).toBe('');
    }
  });
});

describe('splitMouseEvents — SGR button reports (§4.4.2)', () => {
  it('T-1: decodes press / drag / release across buttons 0-2', () => {
    // THE ORDER OF THE DECODE TESTS IS THE SPECIFICATION. `b & 32` (motion) has
    // to precede the `final` test, because a drag is reported with `M` exactly as
    // a press is; get it backwards and every drag becomes a fresh press, which
    // re-anchors the selection on every motion report and makes dragging
    // impossible while looking almost right.
    for (const button of [0, 1, 2] as const) {
      expect(splitMouseEvents(sgr(button, 5, 6)).events).toEqual([
        { kind: 'press', button, x: 5, y: 6, shift: false, alt: false, ctrl: false },
      ]);
      expect(splitMouseEvents(sgr(32 + button, 5, 6)).events).toEqual([
        { kind: 'drag', button, x: 5, y: 6, shift: false, alt: false, ctrl: false },
      ]);
      expect(splitMouseEvents(sgr(button, 5, 6, 'm')).events).toEqual([
        { kind: 'release', button, x: 5, y: 6, shift: false, alt: false, ctrl: false },
      ]);
    }
  });

  it('carries the modifier bits on button events too', () => {
    expect(splitMouseEvents(sgr(4 + 8 + 16, 2, 3)).events[0]).toMatchObject({
      kind: 'press',
      button: 0,
      shift: true,
      alt: true,
      ctrl: true,
    });
  });

  it('drops a motion report with NO button held', () => {
    // `?1002` should never send it and `?1003` sends it constantly. Dropping it
    // is what keeps an any-event terminal from extending a selection with no
    // button down at all.
    expect(splitMouseEvents(sgr(32 + 3, 5, 6)).events).toEqual([]);
    expect(splitMouseEvents(sgr(32 + 3, 5, 6)).text).toBe('');
  });

  it('drops a PRESS whose button field reads 3, but never a RELEASE', () => {
    // The asymmetry is deliberate. A press of "no button" is nonsense and is
    // dropped; a release that does not name its button is a terminal saying
    // "something came up", and the ONE thing a release must always do is let go
    // of `hold` — dropping it would freeze the viewport, which is the exact
    // failure I-11 is about.
    expect(splitMouseEvents(sgr(3, 5, 6)).events).toEqual([]);
    expect(splitMouseEvents(sgr(3, 5, 6, 'm')).events).toEqual([
      { kind: 'release', button: 0, x: 5, y: 6, shift: false, alt: false, ctrl: false },
    ]);
  });

  it('T-2: a drag report split across two chunks reassembles via `pending`', () => {
    const report = sgr(32, 20, 7);
    const first = splitMouseEvents(report.slice(0, 6));
    expect(first.events).toEqual([]);
    expect(first.pending).toBe(report.slice(0, 6));
    const second = splitMouseEvents(first.pending + report.slice(6));
    expect(second.events).toEqual([
      { kind: 'drag', button: 0, x: 20, y: 7, shift: false, alt: false, ctrl: false },
    ]);
    expect(second.text).toBe('');
  });
});

describe('isMousePrefix', () => {
  it('accepts only proper prefixes, never a complete report', () => {
    expect(isMousePrefix(ESC)).toBe(true);
    expect(isMousePrefix(`${ESC}[`)).toBe(true);
    expect(isMousePrefix(`${ESC}[<`)).toBe(true);
    expect(isMousePrefix(`${ESC}[<64;12`)).toBe(true);
    expect(isMousePrefix(`${ESC}[M`)).toBe(true);
    expect(isMousePrefix(sgr(64, 1, 1))).toBe(false);
    expect(isMousePrefix(`${ESC}[A`)).toBe(false);
    expect(isMousePrefix('hello')).toBe(false);
  });
});
