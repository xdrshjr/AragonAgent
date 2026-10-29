/**
 * The stdout `Proxy` (tui-input-flicker-fix §5.5 / §4.3).
 *
 * Everything asserted here fails SILENTLY in production if it regresses: an
 * unbound `on` makes the frame stop resizing with nothing reporting why, a
 * skipped `write` callback strands a drain, and a missing `'resize'`
 * subscription leaves stale rows for the length of a window drag.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { FrameDiffer, FrameWriterStats } from '../ui/frame-differ.js';
import { wrapStdoutForFrames } from '../ui/stdout-frame-writer.js';

const EMPTY_STATS: FrameWriterStats = {
  framesTotal: 0,
  framesDiffed: 0,
  framesFull: 0,
  linesWritten: 0,
  bytesWritten: 0,
  fallbacks: 0,
  repaints: 0,
};

interface FakeStdout extends EventEmitter {
  columns: number;
  rows: number;
  isTTY: boolean;
  write: (chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => boolean;
}

interface Harness {
  real: FakeStdout;
  calls: Array<{ chunk: unknown; encoding?: unknown }>;
  /** What the real `write` returns — the backpressure boolean. */
  setWriteResult(value: boolean): void;
}

function fakeStdout(): Harness {
  const calls: Array<{ chunk: unknown; encoding?: unknown }> = [];
  let result = true;
  const real = new EventEmitter() as FakeStdout;
  real.columns = 120;
  real.rows = 40;
  real.isTTY = true;
  real.write = (chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    calls.push({ chunk, encoding });
    if (typeof callback === 'function') (callback as () => void)();
    return result;
  };
  return {
    real,
    calls,
    setWriteResult(value) {
      result = value;
    },
  };
}

function fakeDiffer(transform: (chunk: string) => string | null): FrameDiffer & {
  invalidations: number;
} {
  const differ = {
    invalidations: 0,
    transform,
    invalidate(): void {
      differ.invalidations += 1;
    },
    // Nothing to re-paint in a fake with no cache; the writer only forwards it.
    repaint: () => '',
    stats: () => EMPTY_STATS,
  };
  return differ;
}

describe('wrapStdoutForFrames — transparency', () => {
  it('reads columns / rows / isTTY through to the real stream', () => {
    const { real } = fakeStdout();
    const { stdout } = wrapStdoutForFrames(
      real as unknown as NodeJS.WriteStream,
      fakeDiffer(() => null),
    );
    expect(stdout.columns).toBe(120);
    expect(stdout.rows).toBe(40);
    expect(stdout.isTTY).toBe(true);

    // Live, not snapshotted: `useTerminalSize` reads these AFTER a resize.
    real.rows = 24;
    expect(stdout.rows).toBe(24);
  });

  it('binds on/off to the real stream so listeners can be removed again', () => {
    // WITHOUT THE BIND, `stdout.on('resize', …)` runs with `this === proxy` and
    // `useTerminalSize` registers and removes its listener against a different
    // `_events` object than the one Node emits on. The frame stops resizing and
    // nothing reports why.
    const { real } = fakeStdout();
    const { stdout } = wrapStdoutForFrames(
      real as unknown as NodeJS.WriteStream,
      fakeDiffer(() => null),
    );
    const listener = vi.fn();

    stdout.on('resize', listener);
    real.emit('resize');
    expect(listener).toHaveBeenCalledTimes(1);

    stdout.off('resize', listener);
    real.emit('resize');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('returns the real stream backpressure boolean', () => {
    const h = fakeStdout();
    const { stdout } = wrapStdoutForFrames(
      h.real as unknown as NodeJS.WriteStream,
      fakeDiffer(() => null),
    );
    expect(stdout.write('x')).toBe(true);
    h.setWriteResult(false);
    expect(stdout.write('x')).toBe(false);
  });
});

describe('wrapStdoutForFrames — the untyped boundary (P1-4)', () => {
  it('passes a Uint8Array chunk through and invalidates', () => {
    const h = fakeStdout();
    const differ = fakeDiffer(() => 'SHOULD NOT BE USED');
    const { stdout } = wrapStdoutForFrames(h.real as unknown as NodeJS.WriteStream, differ);

    const buf = Buffer.from('raw bytes');
    stdout.write(buf);
    expect(h.calls[0]!.chunk).toBe(buf);
    expect(differ.invalidations).toBe(1);
  });

  it('passes a non-UTF-8 encoding through and invalidates', () => {
    // The bytes on the wire are not the string the differ would have diffed, and
    // diffing one encoding while writing another only shows up on someone
    // else's machine.
    const h = fakeStdout();
    const differ = fakeDiffer(() => 'SHOULD NOT BE USED');
    const { stdout } = wrapStdoutForFrames(h.real as unknown as NodeJS.WriteStream, differ);

    stdout.write('héllo', 'latin1');
    expect(h.calls[0]!.chunk).toBe('héllo');
    expect(h.calls[0]!.encoding).toBe('latin1');
    expect(differ.invalidations).toBe(1);
  });

  it('still diffs a string written with an explicit utf8 encoding', () => {
    const h = fakeStdout();
    const differ = fakeDiffer(() => 'DIFFED');
    const { stdout } = wrapStdoutForFrames(h.real as unknown as NodeJS.WriteStream, differ);
    stdout.write('frame', 'utf-8');
    expect(h.calls[0]!.chunk).toBe('DIFFED');
    expect(differ.invalidations).toBe(0);
  });
});

describe('wrapStdoutForFrames — write overloads', () => {
  it('invokes the callback for write(chunk, cb)', () => {
    const h = fakeStdout();
    const { stdout } = wrapStdoutForFrames(
      h.real as unknown as NodeJS.WriteStream,
      fakeDiffer(() => 'OUT'),
    );
    const cb = vi.fn();
    stdout.write('frame', cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('invokes the callback for write(chunk, encoding, cb)', () => {
    const h = fakeStdout();
    const { stdout } = wrapStdoutForFrames(
      h.real as unknown as NodeJS.WriteStream,
      fakeDiffer(() => 'OUT'),
    );
    const cb = vi.fn();
    stdout.write('frame', 'utf8', cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("invokes the callback even when the differ emits '' — nothing to write", () => {
    // A skipped callback here strands whatever was waiting on the drain, and the
    // caller has no way to notice.
    const h = fakeStdout();
    const { stdout } = wrapStdoutForFrames(
      h.real as unknown as NodeJS.WriteStream,
      fakeDiffer(() => ''),
    );
    const cb = vi.fn();
    expect(stdout.write('frame', cb)).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(0);
  });

  it('writes the chunk verbatim when the differ returns null', () => {
    const h = fakeStdout();
    const { stdout } = wrapStdoutForFrames(
      h.real as unknown as NodeJS.WriteStream,
      fakeDiffer(() => null),
    );
    stdout.write('untouched');
    expect(h.calls[0]!.chunk).toBe('untouched');
  });
});

describe('wrapStdoutForFrames — resize invalidation (I-8 / P0-2)', () => {
  it('invalidates the differ on a resize of the REAL stream', () => {
    // Ink re-renders SYNCHRONOUSLY from its own `'resize'` handler while
    // `useTerminalSize` is still debouncing 50 ms, so the line count is
    // unchanged and the differ's own guards cannot see the resize. Every row it
    // believes unchanged then stays stale for the rest of the drag.
    const h = fakeStdout();
    const differ = fakeDiffer(() => null);
    wrapStdoutForFrames(h.real as unknown as NodeJS.WriteStream, differ);

    h.real.emit('resize');
    h.real.emit('resize');
    expect(differ.invalidations).toBe(2);
  });

  it('dispose() removes the listener and is idempotent', () => {
    const h = fakeStdout();
    const differ = fakeDiffer(() => null);
    const handle = wrapStdoutForFrames(h.real as unknown as NodeJS.WriteStream, differ);

    handle.dispose();
    handle.dispose();
    h.real.emit('resize');
    expect(differ.invalidations).toBe(0);
    expect(h.real.listenerCount('resize')).toBe(0);
  });
});

describe('wrapStdoutForFrames — stats', () => {
  it('re-exports the differ counters rather than duplicating them (P2-2)', () => {
    const h = fakeStdout();
    const handle = wrapStdoutForFrames(
      h.real as unknown as NodeJS.WriteStream,
      fakeDiffer(() => null),
    );
    expect(handle.stats()).toEqual(EMPTY_STATS);
  });
});
