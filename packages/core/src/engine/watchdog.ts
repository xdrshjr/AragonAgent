/**
 * IdleWatchdog — fires a callback if no activity occurs within a
 * configurable timeout window.
 *
 * The Agent calls `kick()` on every emitted event to reset the timer.
 * If the timer expires (no events for `timeoutMs`), the watchdog invokes
 * the `onTimeout` callback which typically calls `Agent.abort()`.
 */

export class IdleWatchdog {
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private timeoutMs: number,
    private readonly onTimeout: () => void,
  ) {}

  /** Reset the idle timer.  Must be called on every Agent event. */
  kick(): void {
    if (!this.running) return;
    this.clearTimer();
    this.timerId = setTimeout(() => {
      this.onTimeout();
    }, this.timeoutMs);
  }

  /** Start the watchdog.  Begins (or restarts) the idle timer. */
  start(): void {
    this.running = true;
    this.kick();
  }

  /** Stop the watchdog and cancel any pending timer. */
  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  /** Update the timeout duration.  Takes effect on the next `kick()`. */
  setTimeout(ms: number): void {
    this.timeoutMs = ms;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private clearTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
