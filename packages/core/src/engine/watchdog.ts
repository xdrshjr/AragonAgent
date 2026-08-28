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
  private paused = false;

  constructor(
    private timeoutMs: number,
    private readonly onTimeout: () => void,
  ) {}

  /** Reset the idle timer.  Must be called on every Agent event. */
  kick(): void {
    if (!this.running || this.paused) return;
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

  /**
   * Suspend the idle timer — e.g. while a tool blocks on a human answer.
   * Idempotent.  A paused watchdog swallows `kick()`, so an event arriving
   * mid-wait cannot silently re-arm it.
   */
  pause(): void {
    this.paused = true;
    this.clearTimer();
  }

  /** Resume and restart the idle window from now.  Idempotent. */
  resume(): void {
    this.paused = false;
    this.kick();
  }

  /**
   * Stop the watchdog and cancel any pending timer.
   *
   * Clearing `paused` here is load-bearing: a run aborted while paused would
   * otherwise leave the watchdog deaf for the NEXT run — `start()` calls
   * `kick()`, and `kick()` returns early while paused — and nothing anywhere
   * would report it.
   */
  stop(): void {
    this.running = false;
    this.paused = false;
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
