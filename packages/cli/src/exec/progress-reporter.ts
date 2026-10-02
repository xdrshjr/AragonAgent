import type { ExecProgressEvent } from './events.js';

const PROGRESS_INTERVAL_MS = 1_000;

/** Request-scoped, one-shot aggregation of real semantic events. */
export class ExecProgressReporter {
  private requestSeq: number | null = null;
  private progressSeq = 0;
  private sentSeq = 0;
  private phase: ExecProgressEvent['phase'] = 'model';
  private retryDelayMs: number | undefined;
  private lastSentAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: ExecProgressEvent) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  begin(requestSeq: number): void {
    this.dispose();
    this.requestSeq = requestSeq;
    this.progressSeq = 0;
    this.sentSeq = 0;
    this.phase = 'model';
    this.retryDelayMs = undefined;
    this.lastSentAt = -Infinity;
  }

  /** Called only after the started event has reached the emitter. */
  started(requestSeq: number): void {
    if (this.requestSeq === requestSeq) this.enabled = true;
  }

  record(phase: ExecProgressEvent['phase'], retryDelayMs?: number): void {
    if (!this.enabled || this.requestSeq === null) return;
    const changed = phase !== this.phase;
    if (changed) this.flush();
    this.phase = phase;
    this.retryDelayMs = phase === 'retry' && Number.isFinite(retryDelayMs)
      ? Math.min(120_000, Math.max(0, retryDelayMs!)) : undefined;
    this.progressSeq += 1;
    if (changed || this.now() - this.lastSentAt >= PROGRESS_INTERVAL_MS) {
      this.flush();
    } else if (!this.timer) {
      const requestSeq = this.requestSeq;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.requestSeq === requestSeq && this.enabled) this.flush();
      }, Math.max(0, PROGRESS_INTERVAL_MS - (this.now() - this.lastSentAt)));
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.enabled || this.requestSeq === null || this.sentSeq === this.progressSeq) return;
    this.sentSeq = this.progressSeq;
    this.lastSentAt = this.now();
    this.emit({
      type: 'execution_progress', sessionId: this.sessionId,
      requestSeq: this.requestSeq, progressSeq: this.progressSeq, phase: this.phase,
      ...(this.retryDelayMs !== undefined ? { retryDelayMs: this.retryDelayMs } : {}),
    });
  }

  finish(requestSeq: number): void {
    if (this.requestSeq !== requestSeq) return;
    try { this.flush(); } finally { this.dispose(); }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.requestSeq = null;
    this.enabled = false;
  }
}
