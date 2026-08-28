import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createStdinFilter, tryCreateStdinFilter } from '../input/stdin-filter.js';
import type { MouseEvent } from '../input/mouse-events.js';
import { enterAltScreen } from '../ui/screen.js';

/** Written as an escape, not a raw byte, so an editor that stripped the control
 *  character could not leave a test that asserts nothing and still passes. */
const ESC = '\u001B';
const sgr = (b: number, x: number, y: number): string => `${ESC}[<${b};${x};${y}M`;

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * T-22 -- THE MOUSE HALF OF THIS FILE IS UNCHANGED, VERBATIM.
 *
 * `{ mouse: true, paste: false }` is byte-for-byte the v0.6.3 filter, so every
 * assertion below this line reads exactly as it did before the rename, and a
 * regression in the mouse path fails here rather than in a new case someone
 * might read as "the new feature is slightly different".
 */
const createMouseFilter = (real: NodeJS.ReadStream) =>
  createStdinFilter(real, { mouse: true, paste: false });
const tryCreateMouseFilter = (real: NodeJS.ReadStream, onError?: (reason: string) => void) =>
  tryCreateStdinFilter(real, { mouse: true, paste: false }, onError);

/**
 * A stand-in for `process.stdin` carrying exactly the surface Ink reads off it
 * (`isTTY` / `setRawMode` / `ref` / `unref`), so these tests never put the real
 * terminal into raw mode.
 */
function fakeStdin() {
  const stream = new PassThrough();
  const calls = { setRawMode: [] as boolean[], ref: 0, unref: 0, pause: 0 };
  Object.assign(stream, {
    isTTY: true,
    setRawMode: (mode: boolean) => {
      calls.setRawMode.push(mode);
      return stream;
    },
    ref: () => {
      calls.ref += 1;
      return stream;
    },
    unref: () => {
      calls.unref += 1;
      return stream;
    },
  });
  const realPause = stream.pause.bind(stream);
  Object.assign(stream, {
    pause: () => {
      calls.pause += 1;
      return realPause();
    },
  });
  return { stream: stream as unknown as NodeJS.ReadStream, calls };
}

/** Collect everything the wrapper hands to Ink. */
function drain(filter: { stdin: NodeJS.ReadStream }): { text: () => string } {
  let out = '';
  (filter.stdin as unknown as PassThrough).on('data', (chunk: Buffer | string) => {
    out += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  });
  return { text: () => out };
}

describe('createMouseFilter', () => {
  it('forwards ordinary keystrokes byte-for-byte to the wrapped stream', async () => {
    const { stream } = fakeStdin();
    const filter = createMouseFilter(stream);
    const sink = drain(filter);

    (stream as unknown as PassThrough).write('hello');
    (stream as unknown as PassThrough).write(`${ESC}[A`); // an arrow key
    await tick();

    expect(sink.text()).toBe(`hello${ESC}[A`);
    filter.dispose();
  });

  it('forwards CSI Z (Shift+Tab) untouched, in one chunk and torn in two', async () => {
    // The mode toggle's byte path had NO test until the same bug was reported
    // twice (shift-tab-mode-toggle-still-dead-on-windows, section 3.8). `\x1b[Z`
    // enters the same `ESC`-holding state machine every mouse report does, and
    // `matchReport` classifying it as `none` is the only thing that lets it out.
    // Swallowing it here would be indistinguishable, from the user's chair, from
    // the console never delivering it - the exact bug this file sits next to.
    const { stream } = fakeStdin();
    const filter = createMouseFilter(stream);
    const sink = drain(filter);
    const seen: MouseEvent[] = [];
    filter.source.subscribe((e) => seen.push(e));

    (stream as unknown as PassThrough).write(`${ESC}[Z`);
    await tick();
    expect(sink.text()).toBe(`${ESC}[Z`);

    // Torn across chunks, because a real console splits wherever it likes and a
    // filter that only handles the whole-sequence case still eats the key.
    (stream as unknown as PassThrough).write(ESC);
    await tick();
    (stream as unknown as PassThrough).write('[Z');
    await tick();

    expect(sink.text()).toBe(`${ESC}[Z${ESC}[Z`);
    expect(seen).toHaveLength(0); // never mistaken for a wheel event
    filter.dispose();
  });

  it('never forwards a mouse report to the wrapped stream', async () => {
    // I-1. A leak here is not a lost feature — it is `[<64;40;12M` typed into
    // the user's message, which is worse than the bug being fixed.
    const { stream } = fakeStdin();
    const filter = createMouseFilter(stream);
    const sink = drain(filter);
    const seen: MouseEvent[] = [];
    filter.source.subscribe((e) => seen.push(e));

    (stream as unknown as PassThrough).write(`a${sgr(64, 3, 4)}b${sgr(0, 1, 1)}c`);
    await tick();

    expect(sink.text()).toBe('abc');
    expect(sink.text()).not.toContain('[<');
    // TWO events, not one, since tui-selection-and-scroll-follow §4.4.2: the
    // second report is a left-button PRESS, and the channel now carries buttons
    // as well as wheel notches so the selection controller can see them. What
    // this case is actually about — I-1, that not one byte of either report
    // reaches the wrapped stream — is unchanged and asserted two lines up.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ kind: 'wheel', dir: 'up', x: 3, y: 4 });
    expect(seen[1]).toMatchObject({ kind: 'press', button: 0, x: 1, y: 1 });
    filter.dispose();
  });

  it('reassembles a report torn across two chunks without leaking its tail', async () => {
    const { stream } = fakeStdin();
    const filter = createMouseFilter(stream);
    const sink = drain(filter);
    const seen: MouseEvent[] = [];
    filter.source.subscribe((e) => seen.push(e));

    const report = sgr(65, 20, 7);
    (stream as unknown as PassThrough).write(report.slice(0, 5));
    await tick();
    expect(sink.text()).toBe('');
    (stream as unknown as PassThrough).write(report.slice(5));
    await tick();

    expect(sink.text()).toBe('');
    expect(seen).toEqual([
      { kind: 'wheel', dir: 'down', x: 20, y: 7, shift: false, alt: false, ctrl: false },
    ]);
    filter.dispose();
  });

  it('releases a held ESC to Ink once no further data arrives', async () => {
    // Esc aborts a run, so it must not be held hostage waiting for a `[` that
    // is never coming. Worst-case latency is the 12 ms flush timer.
    const { stream } = fakeStdin();
    const filter = createMouseFilter(stream);
    const sink = drain(filter);

    (stream as unknown as PassThrough).write(ESC);
    await tick();
    expect(sink.text()).toBe('');
    await new Promise((r) => setTimeout(r, 30));
    expect(sink.text()).toBe(ESC);
    filter.dispose();
  });

  it('delegates setRawMode / ref / unref to the real stream', () => {
    // Ink calls all three on whatever stream it is handed; a wrapper that
    // reimplemented them instead would silently stop putting the TERMINAL into
    // raw mode (R-5).
    const { stream, calls } = fakeStdin();
    const filter = createMouseFilter(stream);
    const inkView = filter.stdin as unknown as {
      isTTY: boolean;
      setRawMode(m: boolean): void;
      ref(): void;
      unref(): void;
    };

    expect(inkView.isTTY).toBe(true);
    inkView.ref();
    inkView.setRawMode(true);
    inkView.setRawMode(false);
    inkView.unref();

    expect(calls.ref).toBe(1);
    expect(calls.setRawMode).toEqual([true, false]);
    expect(calls.unref).toBe(1);
    filter.dispose();
  });

  it('reports isTTY through a live getter, not a snapshot', () => {
    // `isRawModeSupported()` reads this; a snapshot taken at construction would
    // make Ink throw instead of degrading when stdin is not a terminal.
    const { stream } = fakeStdin();
    const filter = createMouseFilter(stream);
    const inkView = filter.stdin as unknown as { isTTY: boolean };
    expect(inkView.isTTY).toBe(true);
    (stream as unknown as { isTTY: boolean }).isTTY = false;
    expect(inkView.isTTY).toBe(false);
    filter.dispose();
  });

  it('ends the wrapper when the real stdin closes', async () => {
    // P2-7: otherwise Ink's reader waits forever on a stream that will never
    // produce another byte.
    const { stream } = fakeStdin();
    const filter = createMouseFilter(stream);
    let ended = false;
    (filter.stdin as unknown as PassThrough).on('end', () => {
      ended = true;
    });
    (filter.stdin as unknown as PassThrough).resume();

    (stream as unknown as PassThrough).end();
    await tick();
    await tick();
    expect(ended).toBe(true);
    filter.dispose();
  });

  it('dispose removes the data listener and stops holding the stream open', async () => {
    // I-7: a live `'data'` listener on stdin keeps the event loop alive and
    // `aragon` would never return to the shell.
    const { stream, calls } = fakeStdin();
    const filter = createMouseFilter(stream);
    const sink = drain(filter);

    expect((stream as unknown as PassThrough).listenerCount('data')).toBe(1);
    filter.dispose();
    expect((stream as unknown as PassThrough).listenerCount('data')).toBe(0);
    expect(calls.unref).toBe(1);
    expect(calls.pause).toBe(1);

    (stream as unknown as PassThrough).write('after');
    await tick();
    expect(sink.text()).toBe('');
  });

  it('dispose is idempotent', () => {
    const { stream } = fakeStdin();
    const filter = createMouseFilter(stream);
    expect(() => {
      filter.dispose();
      filter.dispose();
      filter.dispose();
    }).not.toThrow();
  });

  it('unsubscribing stops delivery without disturbing the passthrough', async () => {
    const { stream } = fakeStdin();
    const filter = createMouseFilter(stream);
    const sink = drain(filter);
    const seen: MouseEvent[] = [];
    const off = filter.source.subscribe((e) => seen.push(e));
    off();

    (stream as unknown as PassThrough).write(`x${sgr(64, 1, 1)}`);
    await tick();
    expect(seen).toEqual([]);
    expect(sink.text()).toBe('x');
    filter.dispose();
  });
});

/**
 * I-8 / P0-1 — the one invariant whose violation is a WIRING ORDER rather than
 * a function's behaviour, and the reason `AltScreenOptions.mouse` is defined as
 * "a filter is installed" rather than "the user wants mouse support".
 *
 * The harness below is `runInteractive`-shaped: build the filter, then derive
 * the screen options from whether it exists. Its failure mode is silent —
 * no exception, no log line, just garbage appearing in a draft — so a manual
 * smoke pass on a machine where construction happens to succeed cannot
 * substitute for it.
 */
describe('I-8: reporting is never enabled without a filter in front of Ink', () => {
  function fakeStdout() {
    const writes: string[] = [];
    const stdout = {
      isTTY: true,
      write(s: string) {
        writes.push(s);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    return { stdout, all: () => writes.join('') };
  }

  it('enterAltScreen is never asked for mouse:true when the filter failed to build', () => {
    const { stream } = fakeStdin();
    const broken = vi.fn(() => {
      throw new Error('no raw mode here');
    });
    const onError = vi.fn();

    // Stands in for `createMouseFilter` throwing inside `tryCreateMouseFilter`.
    const filter = ((): ReturnType<typeof tryCreateMouseFilter> => {
      try {
        broken();
        return tryCreateMouseFilter(stream, onError);
      } catch {
        return null;
      }
    })();
    expect(filter).toBeNull();

    const { stdout, all } = fakeStdout();
    enterAltScreen(stdout, { mouse: filter !== null }).restore();

    expect(all()).not.toContain('\x1b[?1000h');
    expect(all()).not.toContain('\x1b[?1006h');
  });

  it('tryCreateMouseFilter returns null and reports the reason instead of throwing', () => {
    const onError = vi.fn();
    // A stream with no `on` at all is the shape of "this is not a stdin".
    const notAStream = {} as unknown as NodeJS.ReadStream;
    expect(tryCreateMouseFilter(notAStream, onError)).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('enables the pair only once a filter really exists', () => {
    const { stream } = fakeStdin();
    const filter = tryCreateMouseFilter(stream);
    expect(filter).not.toBeNull();

    const { stdout, all } = fakeStdout();
    enterAltScreen(stdout, { mouse: filter !== null });
    expect(all()).toContain('\x1b[?1000h');
    expect(all()).toContain('\x1b[?1006h');
    filter?.dispose();
  });
});

// ---------------------------------------------------------------------------
// Paste framing (tui-paste-handling section 5.1, T-16..T-21)
// ---------------------------------------------------------------------------

const OPEN = '\u0000[';
const CLOSE = '\u0000]';
const BEGIN = `${ESC}[200~`;
const END = `${ESC}[201~`;

const pasteFilter = (
  real: NodeJS.ReadStream,
  features: Partial<{ mouse: boolean; paste: boolean }> = {},
) => createStdinFilter(real, { mouse: true, paste: true, ...features });

describe('createStdinFilter — paste framing', () => {
  it('T-16: frames a bracketed paste and emits zero mouse events', async () => {
    const { stream } = fakeStdin();
    const filter = pasteFilter(stream);
    const sink = drain(filter);
    const seen: MouseEvent[] = [];
    filter.source.subscribe((e) => seen.push(e));

    (stream as unknown as PassThrough).write(`${BEGIN}a\r\nb${END}`);
    await tick();

    expect(sink.text()).toBe(`${OPEN}a\nb${CLOSE}`);
    expect(seen).toHaveLength(0);
    filter.dispose();
  });

  it('T-17: reassembles a paste split across five writes, one cutting the end marker', async () => {
    const { stream } = fakeStdin();
    const filter = pasteFilter(stream);
    const sink = drain(filter);
    const pipe = stream as unknown as PassThrough;

    for (const part of [BEGIN, 'one\r\n', 'two\r\n', `three${ESC}[20`, '1~']) {
      pipe.write(part);
      await tick();
    }

    expect(sink.text()).toBe(`${OPEN}one\ntwo\nthree${CLOSE}`);
    filter.dispose();
  });

  it('T-18: a payload containing a mouse report survives INTACT and emits nothing (I-3)', async () => {
    // The most likely thing a TUI-dev-tool user pastes is a terminal log, and
    // eating the bytes that look like SGR reports would corrupt their data with
    // nothing on screen to say so.
    const { stream } = fakeStdin();
    const filter = pasteFilter(stream);
    const sink = drain(filter);
    const seen: MouseEvent[] = [];
    filter.source.subscribe((e) => seen.push(e));

    (stream as unknown as PassThrough).write(`${BEGIN}log ${ESC}[<0;12;5M tail${END}`);
    await tick();

    // The ESC itself is stripped by `sanitisePaste` (G2), but the REPORT is not
    // consumed as a report: every printable byte of it is still there, in order.
    expect(sink.text()).toBe(`${OPEN}log [<0;12;5M tail${CLOSE}`);
    expect(seen).toHaveLength(0);
    filter.dispose();
  });

  it('T-18b: suspends mouse parsing inside a Tier 2 burst as well (P1-7)', async () => {
    const { stream } = fakeStdin();
    const filter = pasteFilter(stream);
    const sink = drain(filter);
    const seen: MouseEvent[] = [];
    filter.source.subscribe((e) => seen.push(e));
    const pipe = stream as unknown as PassThrough;

    pipe.write('first line\r\n'); // classified as a paste -> the burst opens
    await tick();
    pipe.write(`second ${ESC}[<0;12;5M line`); // arrives inside the window
    await new Promise((r) => setTimeout(r, 40));

    expect(seen).toHaveLength(0);
    expect(sink.text()).toBe(`${OPEN}first line\nsecond [<0;12;5M line${CLOSE}`);
    filter.dispose();
  });

  it('T-19: classifies by chunk shape when no marker arrives', async () => {
    const { stream } = fakeStdin();
    const filter = pasteFilter(stream);
    const sink = drain(filter);

    (stream as unknown as PassThrough).write('foo\r\nbar');
    await new Promise((r) => setTimeout(r, 40));
    expect(sink.text()).toBe(`${OPEN}foo\nbar${CLOSE}`);
    filter.dispose();

    // ...and three separate keystrokes are three pass-through writes, not a
    // frame. Ordinary typing never enters the burst window, so it never pays it.
    const typed = fakeStdin();
    const typing = pasteFilter(typed.stream);
    const typedSink = drain(typing);
    for (const ch of ['f', 'o', 'o']) {
      (typed.stream as unknown as PassThrough).write(ch);
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(typedSink.text()).toBe('foo');
    expect(typedSink.text()).not.toContain(OPEN);
    typing.dispose();
  });

  it('T-20: coalesces a burst arriving as three writes into ONE frame', async () => {
    const { stream } = fakeStdin();
    const filter = pasteFilter(stream);
    const sink = drain(filter);
    const pipe = stream as unknown as PassThrough;

    pipe.write('alpha\r\n');
    pipe.write('beta\r\n');
    pipe.write('gamma');
    await new Promise((r) => setTimeout(r, 40));

    expect(sink.text()).toBe(`${OPEN}alpha\nbeta\ngamma${CLOSE}`);
    expect(sink.text().split(OPEN)).toHaveLength(2);
    filter.dispose();
  });

  it('T-21: force-flushes an unterminated paste and returns to idle (I-4)', async () => {
    const { stream } = fakeStdin();
    const filter = pasteFilter(stream);
    const sink = drain(filter);
    const pipe = stream as unknown as PassThrough;

    pipe.write(`${BEGIN}stuck`);
    await tick();
    expect(sink.text()).toBe('');

    await new Promise((r) => setTimeout(r, 2_100));
    expect(sink.text()).toBe(`${OPEN}stuck${CLOSE}`);

    // Back in `idle`: input is never wedged, which is the whole of I-4.
    pipe.write('x');
    await new Promise((r) => setTimeout(r, 40));
    expect(sink.text()).toBe(`${OPEN}stuck${CLOSE}x`);
    filter.dispose();
  }, 10_000);

  it('flushes an open burst FIRST when a bracketed paste starts (P2-4)', async () => {
    const { stream } = fakeStdin();
    const filter = pasteFilter(stream);
    const sink = drain(filter);

    (stream as unknown as PassThrough).write(`aa\r\nbb${BEGIN}cc${END}`);
    await tick();

    expect(sink.text()).toBe(`${OPEN}aa\nbb${CLOSE}${OPEN}cc${CLOSE}`);
    filter.dispose();
  });

  it('consumes a stray end marker rather than typing it into the draft (I-16)', async () => {
    const { stream } = fakeStdin();
    const filter = pasteFilter(stream);
    const sink = drain(filter);

    (stream as unknown as PassThrough).write(`a${END}b`);
    await new Promise((r) => setTimeout(r, 40));

    expect(sink.text()).toBe('ab');
    expect(sink.text()).not.toContain('[201~');
    filter.dispose();
  });

  it('refuses an over-limit paste through the bridge and writes NO frame (D-11 / AC-9)', async () => {
    const notify = vi.fn();
    const { stream } = fakeStdin();
    const filter = createStdinFilter(stream, { mouse: false, paste: true }, { notify });
    const sink = drain(filter);
    const pipe = stream as unknown as PassThrough;

    pipe.write(BEGIN);
    // 3 MiB, above the 2 MiB single-paste ceiling.
    for (let i = 0; i < 3; i += 1) {
      pipe.write('x'.repeat(1024 * 1024));
      await tick();
    }
    pipe.write(END);
    await tick();

    expect(sink.text()).toBe('');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toBe('warn');
    expect(String(notify.mock.calls[0]![1])).toContain('Paste too large');
    expect(String(notify.mock.calls[0]![1])).toContain('2.0 MB');
    filter.dispose();
  }, 20_000);

  it('with { mouse: false } it never parses a mouse report (step 0 / P0-1)', async () => {
    const { stream } = fakeStdin();
    const filter = createStdinFilter(stream, { mouse: false, paste: true });
    const sink = drain(filter);
    const seen: MouseEvent[] = [];
    filter.source.subscribe((e) => seen.push(e));

    (stream as unknown as PassThrough).write(`a${sgr(64, 3, 4)}b`);
    await new Promise((r) => setTimeout(r, 40));

    // Neither consumed nor emitted: a `--no-mouse` session never wrote `?1000h`,
    // so no real report can arrive and the parser could only ever eat pasted
    // bytes that happen to look like one.
    expect(seen).toHaveLength(0);
    expect(sink.text()).toContain('[<64;3;4M');
    filter.dispose();
  });

  it('with { paste: false } it frames nothing at all (AC-6)', async () => {
    const { stream } = fakeStdin();
    const filter = createStdinFilter(stream, { mouse: true, paste: false });
    const sink = drain(filter);

    (stream as unknown as PassThrough).write('foo\r\nbar');
    await new Promise((r) => setTimeout(r, 40));

    expect(sink.text()).toBe('foo\r\nbar');
    filter.dispose();
  });
});
