import { describe, expect, it, vi } from 'vitest';
import { CompactionOperation } from '../compaction/operation.js';

describe('bounded compaction operation', () => {
  it('does not enter a deferred call cancelled in the same event loop tick', async () => {
    const parent = new AbortController();
    const operation = new CompactionOperation(4, parent.signal, 120_000);
    const call = vi.fn(async () => 'result');
    const pending = operation.run(call, 45_000);
    parent.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(call).not.toHaveBeenCalled();
    operation.settle();
  });
  it('releases locally when a transport ignores cancellation', async () => {
    const parent = new AbortController();
    const operation = new CompactionOperation(1, parent.signal, 120_000);
    const pending = operation.run(() => new Promise<never>(() => {}), 45_000);
    parent.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(operation.settle()).toBe(true);
    expect(operation.settle()).toBe(false);
  });

  it('bounds an uncooperative transport by the local deadline', async () => {
    vi.useFakeTimers();
    try {
      const operation = new CompactionOperation(2, new AbortController().signal, 10);
      const pending = operation.run(() => new Promise<never>(() => {}), 45_000);
      const check = expect(pending).rejects.toThrow('timeout');
      await vi.advanceTimersByTimeAsync(10);
      await check;
      operation.settle();
    } finally { vi.useRealTimers(); }
  });

  it('does not start a call after cancellation', async () => {
    const parent = new AbortController();
    parent.abort();
    const operation = new CompactionOperation(3, parent.signal, 120_000);
    const call = vi.fn(async () => 'late');
    await expect(operation.run(call, 45_000)).rejects.toThrow('aborted');
    expect(call).not.toHaveBeenCalled();
    operation.settle();
  });
});
