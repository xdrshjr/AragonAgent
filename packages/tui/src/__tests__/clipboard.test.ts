import { EventEmitter } from 'node:events';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText, osc52, MAX_OSC52_BYTES, startClipboardTask } from '../ui/clipboard.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

function childProcess() {
  const stdin = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  return Object.assign(new EventEmitter(), { stdin, kill: vi.fn(() => true), pid: 123 });
}

beforeEach(() => { vi.useFakeTimers(); spawn.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('clipboard task', () => {
  it('encodes OSC 52 in UTF-8', () => {
    const text = '\u4f60\u597d \u{1f600}';
    expect(osc52(text)).toBe(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
  });

  it('reports remote writes as unconfirmed without starting a native writer', async () => {
    const write = vi.fn();
    expect(await copyText('hello', { remote: true, write }))
      .toEqual({ status: 'sent', via: 'osc52' });
    expect(write).toHaveBeenCalledWith(osc52('hello'));
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['SSH_CONNECTION', 'SSH_TTY'])('detects remote environment %s', async (key) => {
    vi.stubEnv(key, 'remote');
    expect(await copyText('hello', { write: vi.fn() }))
      .toEqual({ status: 'sent', via: 'osc52' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('confirms native success only after close, with safe stdin encoding', async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const write = vi.fn();
    const text = '\u4f60\u597d\n  M:/\u9879\u76ee/a.ts\n';
    const task = startClipboardTask(text, { remote: false, write });
    const result = vi.fn();
    task.result.then(result);
    child.emit('exit', 0);
    await Promise.resolve();
    expect(result).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0]![2]).toMatchObject({ shell: false, windowsHide: true });
    const input = child.stdin.end.mock.calls[0]![0];
    if (process.platform === 'win32') {
      expect(spawn.mock.calls[0]![0]).toBe('powershell.exe');
      expect(spawn.mock.calls[0]![1]).toEqual([
        '-NoProfile', '-NonInteractive', '-STA', '-Command', expect.any(String),
      ]);
      const command = spawn.mock.calls[0]![1].at(-1);
      expect(command).toContain('[Console]::OpenStandardInput()');
      expect(command).toContain('[Text.UTF8Encoding]::new($false),$false');
      expect(command).toContain('Set-Clipboard -Value $reader.ReadToEnd()');
      expect(command).toContain("$ErrorActionPreference='Stop'");
      expect(command).not.toContain(text);
      expect(input).toEqual(Buffer.from(text, 'utf8'));
    } else expect(input).toEqual(Buffer.from(text, 'utf8'));
    child.emit('close', 0);
    expect(await task.result).toEqual({ status: 'confirmed', via: 'native' });
    await task.released;
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });

  it('falls back on unavailable native tools and preserves the reason', async () => {
    spawn.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(await copyText('hello', { remote: false, write: vi.fn() }))
      .toMatchObject({ status: 'sent', via: 'osc52', fallbackReason: 'unavailable' });
  });

  it('handles asynchronous spawn failure before releasing', async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const write = vi.fn();
    const task = startClipboardTask('hello', { remote: false, write });
    child.emit('error', new Error('ENOENT'));
    expect(write).not.toHaveBeenCalled();
    child.emit('close', -2);
    expect(await task.result).toMatchObject({ status: 'sent', fallbackReason: 'unavailable' });
    await task.released;
  });

  it('does not confirm a zero close after a stdin error', async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const task = startClipboardTask('hello', { remote: false });
    child.stdin.emit('error', new Error('EPIPE'));
    child.emit('close', 0);
    expect(await task.result).toEqual({ status: 'failed', reason: 'write' });
    await task.released;
  });

  it('falls back after nonzero exit', async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const task = startClipboardTask('hello', { remote: false, write: vi.fn() });
    child.emit('close', 1);
    expect(await task.result).toMatchObject({ status: 'sent', fallbackReason: 'write' });
    await task.released;
  });

  it('keeps a timed out writer locked after result until its delayed close', async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const write = vi.fn();
    const task = startClipboardTask('old', { remote: false, write, timeoutMs: 10 });
    const released = vi.fn();
    task.released.then(released);
    await vi.advanceTimersByTimeAsync(510);
    expect(await task.result).toEqual({ status: 'failed', reason: 'timeout' });
    expect(released).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(() => child.emit('error', new Error('late'))).not.toThrow();
    expect(() => child.stdin.emit('error', new Error('late EPIPE'))).not.toThrow();
    child.emit('close', 0);
    await task.released;
    expect(write).not.toHaveBeenCalled();
    expect(await task.result).toEqual({ status: 'failed', reason: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('permits timeout fallback only after termination within cleanup grace', async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const write = vi.fn();
    const task = startClipboardTask('hello', { remote: false, write, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(write).not.toHaveBeenCalled();
    child.emit('close', null);
    expect(await task.result).toMatchObject({ status: 'sent', fallbackReason: 'timeout' });
    await task.released;
  });

  it('cancels without terminal fallback and still waits for native close', async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const write = vi.fn();
    const abort = new AbortController();
    const task = startClipboardTask('hello', { remote: false, write, signal: abort.signal });
    abort.abort();
    expect(await task.result).toEqual({ status: 'failed', reason: 'cancelled' });
    const released = vi.fn();
    task.released.then(released);
    await vi.advanceTimersByTimeAsync(500);
    expect(released).not.toHaveBeenCalled();
    child.emit('close', 0);
    await task.released;
    expect(write).not.toHaveBeenCalled();
  });

  it('never starts either writer for an aborted signal or empty text', async () => {
    const abort = new AbortController();
    abort.abort();
    const write = vi.fn();
    expect(await copyText('hello', { signal: abort.signal, write }))
      .toEqual({ status: 'failed', reason: 'cancelled' });
    expect(await copyText('', { write })).toEqual({ status: 'failed', reason: 'empty' });
    expect(write).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects remote oversize by bytes and handles a broken terminal door', async () => {
    const write = vi.fn();
    expect(await copyText('\u4f60'.repeat(Math.ceil(MAX_OSC52_BYTES / 3) + 1),
      { remote: true, write })).toEqual({ status: 'failed', reason: 'too-large' });
    expect(write).not.toHaveBeenCalled();
    expect(await copyText('hello', { remote: true, write: () => { throw Error('EPIPE'); } }))
      .toEqual({ status: 'failed', reason: 'write' });
  });

  it.each([
    ['darwin', 'pbcopy', []],
    ['linux', 'xclip', ['-selection', 'clipboard']],
  ])('uses UTF-8 and argument arrays on %s without killing a successful holder',
    async (platform, file, args) => {
      const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        const child = childProcess();
        spawn.mockReturnValue(child);
        const text = '\u4f60\u597d\n  code();\n';
        const task = startClipboardTask(text, { remote: false });
        expect(spawn.mock.calls[0]).toEqual([file, args, {
          stdio: ['pipe', 'ignore', 'ignore'], shell: false, windowsHide: true,
        }]);
        expect(child.stdin.end).toHaveBeenCalledWith(Buffer.from(text, 'utf8'));
        child.emit('close', 0);
        expect(await task.result).toEqual({ status: 'confirmed', via: 'native' });
        await task.released;
        expect(child.kill).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', original);
      }
    });

  it('holds the lock when killing throws and removes all owned listeners on close', async () => {
    const child = childProcess();
    child.kill.mockImplementation(() => { throw Error('permission denied'); });
    spawn.mockReturnValue(child);
    const abort = new AbortController();
    const removeListener = vi.spyOn(abort.signal, 'removeEventListener');
    const task = startClipboardTask('hello', {
      remote: false, signal: abort.signal, timeoutMs: 1, write: vi.fn(),
    });
    const released = vi.fn();
    task.released.then(released);
    await vi.advanceTimersByTimeAsync(501);
    expect(await task.result).toEqual({ status: 'failed', reason: 'timeout' });
    expect(released).not.toHaveBeenCalled();
    child.emit('close', null);
    await task.released;
    expect(child.eventNames()).toEqual([]);
    expect(child.stdin.eventNames()).toEqual([]);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('copies an oversize local payload through the native writer without OSC truncation', async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const write = vi.fn();
    const task = startClipboardTask('x'.repeat(MAX_OSC52_BYTES + 1), { remote: false, write });
    child.emit('close', 0);
    expect(await task.result).toEqual({ status: 'confirmed', via: 'native' });
    await task.released;
    expect(write).not.toHaveBeenCalled();
  });
});
