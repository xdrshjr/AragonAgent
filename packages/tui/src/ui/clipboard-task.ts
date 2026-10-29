import {
  startClipboardTask, type ClipboardOptions, type CopyResult,
} from './clipboard.js';

export interface CopyRequest {
  text: string;
  lines: number;
}

export type CopyRequestResult = CopyResult | { status: 'busy' };

export interface ClipboardState {
  busy: boolean;
  cleanupPending: boolean;
}

export interface ClipboardCoordinatorOptions {
  clipboard?: ClipboardOptions;
  /** Clears the previous Ctrl+C exit preparation for both copy entry points. */
  onRequest?: () => void;
  /** A repeated request is consumed; its selection must remain untouched. */
  onBusy?: (state: ClipboardState) => void;
  onResult?: (result: CopyResult, request: CopyRequest) => void;
  onStateChange?: (state: ClipboardState) => void;
}

export interface ClipboardCoordinator {
  requestCopy(request: CopyRequest): Promise<CopyRequestResult>;
  isBusy(): boolean;
  isCleanupPending(): boolean;
  dispose(): void;
}

class SharedClipboardCoordinator implements ClipboardCoordinator {
  private busy = false;
  private cleanupPending = false;
  private disposed = false;
  private readonly abort = new AbortController();

  constructor(private readonly options: ClipboardCoordinatorOptions) {
    options.clipboard?.signal?.addEventListener('abort', this.dispose, { once: true });
    if (options.clipboard?.signal?.aborted) this.dispose();
  }

  isBusy(): boolean { return this.busy; }
  isCleanupPending(): boolean { return this.cleanupPending; }

  private state(): ClipboardState {
    return { busy: this.busy, cleanupPending: this.cleanupPending };
  }

  private notifyState(): void {
    if (!this.disposed) this.options.onStateChange?.(this.state());
  }

  readonly requestCopy = (request: CopyRequest): Promise<CopyRequestResult> => {
    if (this.disposed) return Promise.resolve({ status: 'failed', reason: 'cancelled' });
    if (this.busy) {
      this.options.onRequest?.();
      this.options.onBusy?.(this.state());
      return Promise.resolve({ status: 'busy' });
    }
    // Claim synchronously, before callbacks or Promise work can re-enter this port.
    this.busy = true;
    this.options.onRequest?.();
    this.notifyState();
    const snapshot = { ...request };
    const task = startClipboardTask(snapshot.text, {
      ...this.options.clipboard, signal: this.abort.signal,
    });
    const result = task.result.then((value) => {
      if (!this.disposed) {
        this.cleanupPending = this.busy && value.status === 'failed';
        this.notifyState();
        this.options.onResult?.(value, snapshot);
      }
      return value;
    });
    // Failure feedback is not a release signal: the old native writer may still live.
    void task.released.then(() => {
      this.busy = false;
      this.cleanupPending = false;
      this.notifyState();
    });
    return result;
  };

  readonly dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.options.clipboard?.signal?.removeEventListener('abort', this.dispose);
    this.abort.abort();
  };
}

/** Create the App-owned copy port; use its live busy state before taking a selection. */
export function createClipboardCoordinator(
  options: ClipboardCoordinatorOptions = {},
): ClipboardCoordinator {
  return new SharedClipboardCoordinator(options);
}
