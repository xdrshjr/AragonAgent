/**
 * Stdout frame writer — the `Proxy` that binds `frame-differ.ts` to a real
 * stream (tui-input-flicker-fix §3.2 / §5.5).
 *
 * Ink offers no hook for "how to write a frame": `Ink#log` is constructed
 * internally and `log-update` is a private module. It DOES accept a `stdout` in
 * `render()`'s options, so the whole interposition is one `Proxy` whose only
 * trapped behaviour is `write` — everything else is the real stream.
 *
 * THREE THINGS IN HERE ARE LOAD-BEARING:
 *
 *  - The `get` trap MUST bind non-`write` function members to the REAL stream.
 *    Without the bind, `stdout.on('resize', …)` executes with `this === proxy`,
 *    and `useTerminalSize` registers and removes its listener against a
 *    different `_events` object than the one Node emits on — the frame stops
 *    resizing and nothing reports why.
 *  - The UNTYPED BOUNDARY LIVES HERE, not in the differ (P1-4). A `Uint8Array`
 *    chunk, and any `write` whose `encoding` is present and is not UTF-8, is
 *    passed straight through after `invalidate()`: in both cases the bytes on
 *    the wire are not the string a differ could reason about, and diffing one
 *    encoding while writing another is the kind of bug that only shows up on
 *    someone else's machine.
 *  - The `'resize'` SUBSCRIPTION (I-8 / P0-2). Ink renders SYNCHRONOUSLY from its
 *    own `'resize'` handler while the frame's height is still the pre-resize one
 *    — `useTerminalSize` debounces by 50 ms — so the line count is unchanged
 *    across that window and the differ's line-count guard cannot see the resize.
 *    Meanwhile the emulator has re-flowed the alternate screen, so every row the
 *    differ believes unchanged is a row it will not repaint, for the rest of the
 *    drag. It goes on the REAL stream, not the `Proxy`, and `dispose()` removes
 *    it.
 */

import type { FrameDiffer, FrameWriterStats } from './frame-differ.js';

export interface FrameWriterHandle {
  /** Hand this to `render(…, { stdout })`. */
  stdout: NodeJS.WriteStream;
  /** Hand this to `setFrameStatsProvider`. */
  stats(): FrameWriterStats;
  /**
   * Re-paint the last frame through the differ's `decorate` hook — how a
   * selection drag reaches the screen without a React commit.
   *
   * Returns whether anything was written. `false` means the differ had nothing
   * safe to do (no cache, or a geometry stand-down), which is the caller's cue to
   * fall back to `App`'s `redrawNonce`.
   *
   * I-3 / I-13 — IT WRITES TO THE REAL STREAM, NEVER THROUGH THE PROXY. Through
   * the proxy the payload would be handed to `transform`, which would not
   * recognise it and would `invalidate()`, turning every drag frame into a full
   * repaint — the flicker `tui-input-flicker-fix` removed. It is also not a
   * fallback and not a frame, so it touches neither counter.
   */
  repaint(): boolean;
  /**
   * Write bytes that are ours but are not a frame — today, the OSC 52 clipboard
   * sequence (§4.4.5).
   *
   * The differ is invalidated first, because absolute addressing is only valid
   * while nothing else writes to stdout, and one full repaint after a copy is the
   * correct price.
   *
   * IT IS NOT A FALLBACK (P1-6 / I-13), and that is the whole reason this door
   * exists rather than the caller reaching for `stdout.write`. `transform` cannot
   * recognise an OSC 52 chunk, so through the proxy it would take
   * `passThrough(true)` — which increments `fallbacks` and, on the first one,
   * raises `onFirstFallback`, wired to `console.warn(FRAME_FALLBACK_NOTICE)`.
   * The first copy of every session would print a diagnostic at a user who did
   * nothing wrong, and `fallbacks` — documented to mean "something wrote to
   * stdout behind Ink's back" — would stop being true for the rest of the run.
   */
  writeForeign(text: string): void;
  /** Removes the `'resize'` subscription of I-8. Idempotent. */
  dispose(): void;
}

/** The only encodings for which the chunk string IS the bytes on the wire. */
function isUtf8Encoding(encoding: string): boolean {
  const e = encoding.toLowerCase();
  return e === 'utf8' || e === 'utf-8';
}

/**
 * DEC private mode 25 set/reset — hide / show the cursor.
 *
 * Ink 5.2.1's own root `<App>` writes these two EXACT strings through the
 * render stdout on mount and unmount (`ink/build/components/App.js` →
 * `cli-cursor`), which is this proxy, not the process stream. Cursor
 * VISIBILITY changes no cell and moves no row, so the differ's
 * absolute-addressing cache survives them untouched — yet `transform` cannot
 * recognise them and answers `passThrough(true)`: counted, `onFirstFallback`
 * raised (the warning fired on EVERY launch), cache dropped for nothing. Worse,
 * in the real CLI the mount write arrives FIRST, so it also consumes the
 * session's one seed-write exemption (`firstChunk`, P1-1) and the seed frame
 * itself becomes the counted fallback.
 *
 * Absorbed here instead: straight to the real stream — no transform, no
 * `invalidate()`, no fallback count, no exemption consumed. The match is
 * exact on the whole chunk, so a future Ink that mixes the sequence into a
 * longer write simply misses and falls back to today's conservative handling;
 * a missed absorb costs one extra repaint, never a swallowed desync.
 */
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';

type WriteCallback = (error?: Error | null) => void;

export function wrapStdoutForFrames(
  stdout: NodeJS.WriteStream,
  differ: FrameDiffer,
): FrameWriterHandle {
  const bound = new Map<string | symbol, unknown>();

  const writeReal = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding,
    cb?: WriteCallback,
  ): boolean => {
    if (encoding !== undefined) return stdout.write(chunk as string, encoding, cb);
    return stdout.write(chunk as string, cb);
  };

  /**
   * All three Node overloads: `write(chunk)`, `write(chunk, cb)`,
   * `write(chunk, encoding, cb)`.
   */
  const write = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | WriteCallback,
    maybeCb?: WriteCallback,
  ): boolean => {
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
    const cb =
      typeof encodingOrCb === 'function'
        ? encodingOrCb
        : typeof maybeCb === 'function'
        ? maybeCb
        : undefined;

    // Foreign by construction: Ink never writes Buffers, and a non-UTF-8
    // encoding means the string is not the bytes (P1-4).
    if (typeof chunk !== 'string' || (encoding !== undefined && !isUtf8Encoding(encoding))) {
      differ.invalidate();
      return writeReal(chunk, encoding, cb);
    }

    // Ink's own cursor-mode pair (see CURSOR_HIDE / CURSOR_SHOW above): not a
    // frame and not a desync — the bytes reach the terminal untransformed,
    // uncounted, and without touching the cache or the seed exemption.
    if (chunk === CURSOR_HIDE || chunk === CURSOR_SHOW) {
      return writeReal(chunk, encoding, cb);
    }

    const out = differ.transform(chunk);
    if (out === null) return writeReal(chunk, encoding, cb);
    // Nothing to write, but the callback is still part of the contract — a
    // skipped `cb` strands whatever was waiting on the drain.
    if (out.length === 0) {
      cb?.();
      return true;
    }
    return writeReal(out, encoding, cb);
  };

  const onResize = (): void => differ.invalidate();
  stdout.on('resize', onResize);
  let disposed = false;

  const proxy = new Proxy(stdout, {
    get(target, prop) {
      if (prop === 'write') return write;
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      // Cached so repeated property access does not allocate a new bound
      // function on a hot path (K-9).
      let fn = bound.get(prop);
      if (fn === undefined) {
        fn = (value as (...args: unknown[]) => unknown).bind(target);
        bound.set(prop, fn);
      }
      return fn;
    },
  });

  return {
    stdout: proxy,
    stats: () => differ.stats(),
    repaint(): boolean {
      if (disposed) return false;
      const payload = differ.repaint();
      if (payload.length === 0) return false;
      writeReal(payload);
      return true;
    },
    writeForeign(text: string): void {
      differ.invalidate();
      if (disposed || text.length === 0) return;
      writeReal(text);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stdout.off('resize', onResize);
    },
  };
}
