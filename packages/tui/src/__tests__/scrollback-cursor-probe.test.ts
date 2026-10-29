import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  probeAnchorSpaceBelow,
  resetAnchorProbeForTests,
  setAnchorProbeDisabled,
} from '../ui/scrollback/cursor-probe.js';

/** A fake stdin that is a TTY, so the probe's own gate is satisfied. */
function fakeStdin(): NodeJS.ReadStream & PassThrough {
  const stream = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  return stream;
}

/** A fake stdout that records every write instead of performing it. */
function fakeStdout(): { writes: string[]; stream: NodeJS.WriteStream } {
  const writes: string[] = [];
  const stream = {
    isTTY: true,
    write: (chunk: string) => { writes.push(chunk); return true; },
  } as unknown as NodeJS.WriteStream;
  return { writes, stream };
}

function probe(over: {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  rows?: () => number | undefined;
  timeoutMs?: number;
} = {}) {
  const stdin = over.stdin ?? fakeStdin();
  const out = over.stdout ? { writes: [] as string[], stream: over.stdout } : fakeStdout();
  return {
    stdin,
    stdout: out.stream,
    writes: out.writes,
    promise: probeAnchorSpaceBelow({
      stdin,
      stdout: out.stream,
      rows: over.rows ?? (() => 31),
      ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
    }),
  };
}

describe('probeAnchorSpaceBelow', () => {
  beforeEach(() => {
    resetAnchorProbeForTests();
  });

  afterEach(() => {
    resetAnchorProbeForTests();
    vi.useRealTimers();
  });

  it('returns_space_below_from_a_cpr_reply', async () => {
    const { stdin, writes, promise } = probe();
    stdin.emit('data', '\x1b[12;1R');
    await expect(promise).resolves.toBe(19);
    expect(writes).toEqual(['\x1b[6n']);
  });

  it('accepts_the_decxcpr_form', async () => {
    const { stdin, promise } = probe();
    stdin.emit('data', '\x1b[?12;1R');
    await expect(promise).resolves.toBe(19);
  });

  it('finds the report inside a chunk that also carries keystrokes', async () => {
    const { stdin, promise } = probe();
    stdin.emit('data', 'abc\x1b[12;1R');
    await expect(promise).resolves.toBe(19);
  });

  it('reassembles a reply split across two chunks', async () => {
    const { stdin, promise } = probe();
    stdin.emit('data', '\x1b[12');
    stdin.emit('data', ';1R');
    await expect(promise).resolves.toBe(19);
  });

  it('times_out_without_writing_anything_further', async () => {
    vi.useFakeTimers();
    const { stdin, writes, promise } = probe();
    let settled: number | null | undefined;
    void promise.then((value) => { settled = value; });
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBeNull();
    // Exactly one query, and nothing after the timeout.
    expect(writes).toEqual(['\x1b[6n']);
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('is_single_flight', async () => {
    const { stdin, stdout, writes } = probe();
    const first = probeAnchorSpaceBelow({ stdin, stdout, rows: () => 31 });
    const second = probeAnchorSpaceBelow({ stdin, stdout, rows: () => 31 });
    expect(second).toBe(first);
    stdin.emit('data', '\x1b[12;1R');
    await expect(first).resolves.toBe(19);
    await expect(second).resolves.toBe(19);
    expect(writes).toEqual(['\x1b[6n']);
  });

  it('requires_a_tty_on_both_ends', async () => {
    const stdin = fakeStdin();
    Object.defineProperty(stdin, 'isTTY', { value: false, configurable: true });
    const notTty = probe({ stdin });
    await expect(notTty.promise).resolves.toBeNull();
    expect(notTty.writes).toEqual([]);

    const out = fakeStdout();
    Object.defineProperty(out.stream, 'isTTY', { value: false, configurable: true });
    const notTtyOut = probe({ stdout: out.stream });
    await expect(notTtyOut.promise).resolves.toBeNull();
    expect(out.writes).toEqual([]);
  });

  it('returns_null_when_rows_are_unknown', async () => {
    const { writes, promise } = probe({ rows: () => undefined });
    await expect(promise).resolves.toBeNull();
    expect(writes).toEqual([]);
  });

  it('never_probes_after_finalize', async () => {
    setAnchorProbeDisabled(true);
    const { writes, promise } = probe();
    await expect(promise).resolves.toBeNull();
    // Not one byte: a query here would leak the reply onto the shell's prompt.
    expect(writes).toEqual([]);
  });

  it('ignores_a_reply_that_arrives_after_the_timeout', async () => {
    vi.useFakeTimers();
    const { stdin, promise } = probe();
    let settled: number | null | undefined;
    void promise.then((value) => { settled = value; });
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBeNull();
    // The listener is gone, so a late reply cannot resolve anything twice.
    expect(() => stdin.emit('data', '\x1b[12;1R')).not.toThrow();
    expect(settled).toBeNull();
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('survives a write that throws', async () => {
    const stdin = fakeStdin();
    const stdout = {
      isTTY: true,
      write: () => { throw new Error('closed'); },
    } as unknown as NodeJS.WriteStream;
    await expect(probeAnchorSpaceBelow({ stdin, stdout, rows: () => 31 })).resolves.toBeNull();
  });
});
