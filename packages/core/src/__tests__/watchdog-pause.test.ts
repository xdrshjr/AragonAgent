/**
 * IdleWatchdog pause/resume (plan-mode §3.6a).
 *
 * The watchdog is the second of the two ceilings a tool that blocks on a human
 * has to survive. Fake timers throughout: a real 20 ms window would make this
 * test flaky on a loaded CI box, and the property under test is about which
 * timer is armed, not about wall-clock behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdleWatchdog } from '../engine/watchdog.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('IdleWatchdog.pause / resume', () => {
  it('suppresses the timeout for as long as it is paused', () => {
    const onTimeout = vi.fn();
    const dog = new IdleWatchdog(1000, onTimeout);
    dog.start();

    dog.pause();
    vi.advanceTimersByTime(10_000);
    expect(onTimeout).not.toHaveBeenCalled();

    dog.stop();
  });

  it('ignores kicks while paused, so an event mid-wait cannot re-arm it', () => {
    const onTimeout = vi.fn();
    const dog = new IdleWatchdog(1000, onTimeout);
    dog.start();
    dog.pause();

    dog.kick();
    vi.advanceTimersByTime(10_000);
    expect(onTimeout).not.toHaveBeenCalled();

    dog.stop();
  });

  it('restarts the full idle window on resume', () => {
    const onTimeout = vi.fn();
    const dog = new IdleWatchdog(1000, onTimeout);
    dog.start();

    dog.pause();
    vi.advanceTimersByTime(5000);
    dog.resume();

    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    dog.stop();
  });

  it('is idempotent in both directions', () => {
    const onTimeout = vi.fn();
    const dog = new IdleWatchdog(1000, onTimeout);
    dog.start();

    dog.pause();
    dog.pause();
    dog.resume();
    dog.resume();

    vi.advanceTimersByTime(1001);
    // Two resumes must not arm two timers.
    expect(onTimeout).toHaveBeenCalledTimes(1);

    dog.stop();
  });

  it('stop() clears the paused flag so the NEXT run is not deaf', () => {
    // The failure this pins: a run aborted mid-human-wait leaves `paused` set,
    // `start()` calls `kick()`, `kick()` returns early — and the watchdog is
    // silently disabled for the rest of the process.
    const onTimeout = vi.fn();
    const dog = new IdleWatchdog(1000, onTimeout);
    dog.start();
    dog.pause();
    dog.stop();

    dog.start();
    vi.advanceTimersByTime(1001);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    dog.stop();
  });

  it('resume() on a stopped watchdog does not arm a timer', () => {
    const onTimeout = vi.fn();
    const dog = new IdleWatchdog(1000, onTimeout);
    dog.start();
    dog.stop();

    dog.resume();
    vi.advanceTimersByTime(10_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
