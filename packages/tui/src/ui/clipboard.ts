/** The only clipboard writer. Interaction callers share clipboard-task's coordinator. */
import { spawn, type ChildProcess } from 'node:child_process';
import process from 'node:process';

export type CopyFailureReason =
  | 'empty' | 'unavailable' | 'write' | 'timeout' | 'too-large' | 'cancelled';

export type CopyResult =
  | { status: 'confirmed'; via: 'native' }
  | { status: 'sent'; via: 'osc52'; fallbackReason?: CopyFailureReason }
  | { status: 'failed'; reason: CopyFailureReason };

export interface ClipboardOptions {
  /** Frame differ's foreign-write door, never the intercepted stdout stream. */
  write?: (chunk: string) => void;
  remote?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ClipboardTask {
  result: Promise<CopyResult>;
  /** Resolves only after no writer can change the clipboard again. */
  released: Promise<void>;
}

export const MAX_OSC52_BYTES = 56_000;
const CLEANUP_GRACE_MS = 500;
// clip.exe preserves a supplied BOM and guesses BOM-less UTF-16 incorrectly for
// short CJK text. Decode stdin explicitly; never interpolate clipboard content.
const WINDOWS_CLIPBOARD_COMMAND = "$ErrorActionPreference='Stop'; "
  + '$reader=[IO.StreamReader]::new([Console]::OpenStandardInput(),'
  + '[Text.UTF8Encoding]::new($false),$false); Set-Clipboard -Value $reader.ReadToEnd()';

/** Encode the full clipboard selection as UTF-8, without truncating its payload. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

function sendOsc52(
  text: string,
  options: ClipboardOptions,
  fallbackReason?: CopyFailureReason,
): CopyResult {
  if (options.signal?.aborted) return { status: 'failed', reason: 'cancelled' };
  if (Buffer.byteLength(text, 'utf8') > MAX_OSC52_BYTES) {
    return { status: 'failed', reason: 'too-large' };
  }
  if (!options.write) return { status: 'failed', reason: fallbackReason ?? 'unavailable' };
  try {
    options.write(osc52(text));
    return { status: 'sent', via: 'osc52', ...(fallbackReason ? { fallbackReason } : {}) };
  } catch {
    return { status: 'failed', reason: 'write' };
  }
}

function settledTask(result: CopyResult): ClipboardTask {
  return { result: Promise.resolve(result), released: Promise.resolve() };
}

function spawnNative(): ChildProcess {
  const windows = process.platform === 'win32';
  const file = windows ? 'powershell.exe' : process.platform === 'darwin' ? 'pbcopy' : 'xclip';
  const args = windows
    ? ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_CLIPBOARD_COMMAND]
    : file === 'xclip' ? ['-selection', 'clipboard'] : [];
  return spawn(file, args, {
    stdio: ['pipe', 'ignore', 'ignore'], shell: false, windowsHide: true,
  });
}

/** Owns a writer through close, even when its user-facing result timed out earlier. */
class NativeClipboardTask implements ClipboardTask {
  readonly result: Promise<CopyResult>;
  readonly released: Promise<void>;
  private resolveResult!: (result: CopyResult) => void;
  private resolveReleased!: () => void;
  private settled = false;
  private closed = false;
  private stopping = false;
  private failure: CopyFailureReason | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly text: string,
    private readonly options: ClipboardOptions,
  ) {
    this.result = new Promise((resolve) => { this.resolveResult = resolve; });
    this.released = new Promise((resolve) => { this.resolveReleased = resolve; });
    child.on('error', this.onError);
    child.once('close', this.onClose);
    child.stdin?.on('error', this.onStdinError);
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    this.timer = setTimeout(() => this.stop('timeout'), options.timeoutMs ?? 1500);
    if (options.signal?.aborted) { this.onAbort(); return; }
    if (!child.stdin) { this.stop('write'); return; }
    try {
      child.stdin.end(Buffer.from(text, 'utf8'));
    } catch {
      this.stop('write');
    }
  }

  private settle(result: CopyResult): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    clearTimeout(this.cleanupTimer);
    this.resolveResult(result);
  }

  private stop(reason: CopyFailureReason): void {
    if (this.closed || this.stopping) return;
    this.stopping = true;
    this.failure = reason;
    clearTimeout(this.timer);
    // No fallback before close: even a successful kill request is not proof of exit.
    if (!this.settled) {
      this.cleanupTimer = setTimeout(() => {
        this.settle({ status: 'failed', reason });
      }, CLEANUP_GRACE_MS);
    }
    try { this.child.stdin?.destroy(); } catch { /* Keep error listeners until close. */ }
    try { this.child.kill(); } catch { /* A failed kill must not release the writer lock. */ }
  }

  private readonly onAbort = (): void => {
    this.settle({ status: 'failed', reason: 'cancelled' });
    this.stop('cancelled');
  };

  private readonly onError = (): void => { this.stop('unavailable'); };
  private readonly onStdinError = (): void => { this.stop('write'); };

  private readonly onClose = (code: number | null): void => {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.cleanupTimer);
    this.options.signal?.removeEventListener('abort', this.onAbort);
    if (!this.settled) {
      const result: CopyResult = code === 0 && !this.failure
        ? { status: 'confirmed', via: 'native' }
        : sendOsc52(this.text, this.options, this.failure ?? 'write');
      this.settle(result);
    }
    this.child.removeListener('error', this.onError);
    this.child.stdin?.removeListener('error', this.onStdinError);
    this.resolveReleased();
  };
}

/** Start a copy without rejecting; result and writer release are separate signals. */
export function startClipboardTask(text: string, options: ClipboardOptions = {}): ClipboardTask {
  if (options.signal?.aborted) return settledTask({ status: 'failed', reason: 'cancelled' });
  if (text.length === 0) return settledTask({ status: 'failed', reason: 'empty' });
  const remote = options.remote ?? Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
  if (remote) return settledTask(sendOsc52(text, options));
  let child: ChildProcess;
  try { child = spawnNative(); } catch {
    return settledTask(sendOsc52(text, options, 'unavailable'));
  }
  return new NativeClipboardTask(child, text, options);
}

/** Promise convenience wrapper; interactive callers must use the shared coordinator. */
export function copyText(text: string, options: ClipboardOptions = {}): Promise<CopyResult> {
  return startClipboardTask(text, options).result;
}
