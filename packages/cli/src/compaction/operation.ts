/** Local cancellation and deadline ownership, independent of transport cooperation. */
export class CompactionOperation {
  readonly controller = new AbortController();
  readonly deadline: number;
  private settled = false;
  private reason = 'aborted';
  private readonly onParentAbort = (): void => this.abort();

  constructor(
    readonly id: number,
    private readonly parent: AbortSignal,
    timeoutMs: number,
  ) {
    this.deadline = Date.now() + timeoutMs;
    parent.addEventListener('abort', this.onParentAbort, { once: true });
    if (parent.aborted) this.abort();
  }

  get signal(): AbortSignal { return this.controller.signal; }

  /** Abort is local; a late remote reply never restores ownership. */
  abort(reason = 'aborted'): void {
    if (this.signal.aborted) return;
    this.reason = reason;
    this.controller.abort();
  }

  /** One settlement per operation, including rejected or abandoned candidates. */
  settle(): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.parent.removeEventListener('abort', this.onParentAbort);
    this.abort();
    return true;
  }

  /** Race every call locally and attach rejection handling even to late promises. */
  async run<T>(call: () => Promise<T>, timeoutMs: number): Promise<T> {
    if (this.signal.aborted || this.settled) throw new Error(this.reason);
    const remaining = Math.min(timeoutMs, this.deadline - Date.now());
    if (remaining <= 0) throw new Error('timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(this.reason));
      this.signal.addEventListener('abort', onAbort, { once: true });
      if (this.signal.aborted) onAbort();
      timer = setTimeout(() => this.abort('timeout'), remaining);
    });
    try {
      if (this.signal.aborted) throw new Error(this.reason);
      const remote = Promise.resolve().then(() => {
        if (this.signal.aborted || this.settled) throw new Error(this.reason);
        if (Date.now() >= this.deadline) throw new Error('timeout');
        return call();
      });
      return await Promise.race([remote, cancelled]);
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener('abort', onAbort);
    }
  }
}
