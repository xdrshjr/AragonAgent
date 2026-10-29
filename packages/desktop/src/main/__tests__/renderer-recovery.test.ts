/** AC-74 / AC-75: what happens when the renderer dies, fails to load or hangs - and when it must NOT. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ERR_ABORTED, RELOAD_DELAY_MS, RecoveryPolicy, UNRESPONSIVE_GRACE_MS, attachRendererRecovery,
  type RecoveryChoice, type RecoveryDeps, type WebContentsLike,
} from '../renderer-recovery.js';

describe('RecoveryPolicy', () => {
  it('reloads quietly twice in a minute, then asks', () => {
    let now = 0;
    const policy = new RecoveryPolicy(() => now);
    expect(policy.onFailure('crashed')).toBe('reload');
    now += 1000;
    expect(policy.onFailure('oom')).toBe('reload');
    now += 1000;
    expect(policy.onFailure('crashed')).toBe('ask');
    now += 1000;
    expect(policy.onFailure('crashed')).toBe('ask');
  });

  it('counts again once the failures slide out of the window', () => {
    let now = 0;
    const policy = new RecoveryPolicy(() => now);
    policy.onFailure('crashed'); policy.onFailure('crashed');
    now += 61_000;
    expect(policy.onFailure('crashed')).toBe('reload');
  });

  it('a clean exit is ignored and never counts', () => {
    const policy = new RecoveryPolicy(() => 0);
    for (let index = 0; index < 10; index += 1) expect(policy.onFailure('clean-exit')).toBe('ignore');
    expect(policy.onFailure('crashed')).toBe('reload');
  });

  it('reset starts a fresh count', () => {
    const policy = new RecoveryPolicy(() => 0);
    policy.onFailure('crashed'); policy.onFailure('crashed');
    policy.reset();
    expect(policy.onFailure('crashed')).toBe('reload');
  });
});

class FakeContents implements WebContentsLike {
  destroyed = false;
  reload = vi.fn();
  forcefullyCrashRenderer = vi.fn();
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  isDestroyed(): boolean { return this.destroyed; }
  on(event: string, listener: (...args: any[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  emit(event: string, ...args: unknown[]): void { for (const listener of this.listeners.get(event) ?? []) listener({}, ...args); }
}

function setup(overrides: Partial<RecoveryDeps> = {}) {
  const contents = new FakeContents();
  const state = { quitting: false };
  const answers: RecoveryChoice[] = [];
  const asked: string[] = [];
  const resolvers: Array<(choice: RecoveryChoice) => void> = [];
  const deps: RecoveryDeps = {
    policy: new RecoveryPolicy(() => Date.now()),
    isQuitting: () => state.quitting,
    devServer: false,
    detail: () => null,
    ask: (kind) => {
      asked.push(kind);
      const next = answers.shift();
      if (next) return Promise.resolve(next);
      return new Promise((resolve) => { resolvers.push(resolve); });
    },
    openLogs: vi.fn(),
    quit: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
  const handle = attachRendererRecovery(contents, deps);
  return { contents, deps, state, answers, asked, resolvers, handle };
}

beforeEach(() => { vi.useFakeTimers(); });

describe('attachRendererRecovery - crashes and failed loads', () => {
  it('reloads after a short delay when the renderer crashes', () => {
    const { contents } = setup();
    contents.emit('render-process-gone', { reason: 'crashed' });
    expect(contents.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(contents.reload).toHaveBeenCalledTimes(1);
  });

  it('a clean exit does nothing', () => {
    const { contents, asked } = setup();
    contents.emit('render-process-gone', { reason: 'clean-exit' });
    vi.advanceTimersByTime(5000);
    expect(contents.reload).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it('the third crash in a minute asks instead of reloading; Reload resets the count', async () => {
    const { contents, asked, answers } = setup();
    answers.push('reload');
    for (let index = 0; index < 2; index += 1) contents.emit('render-process-gone', { reason: 'crashed' });
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(contents.reload).toHaveBeenCalledTimes(2);
    contents.emit('render-process-gone', { reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
    expect(asked).toEqual(['crash']);
    expect(contents.reload).toHaveBeenCalledTimes(3); // the user chose Reload
    contents.emit('render-process-gone', { reason: 'crashed' });
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(contents.reload).toHaveBeenCalledTimes(4); // count was reset, so quiet reload again
  });

  it('"open logs" opens the folder and asks again; "quit" quits', async () => {
    const { contents, deps, answers } = setup();
    answers.push('logs', 'quit');
    for (let index = 0; index < 3; index += 1) contents.emit('render-process-gone', { reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
    expect(deps.openLogs).toHaveBeenCalledTimes(1);
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });

  it('did-fail-load: ERR_ABORTED and sub-frame failures are ignored; a main-frame failure is handled', () => {
    const { contents } = setup();
    contents.emit('did-fail-load', ERR_ABORTED, 'aborted', 'app://x', true);
    contents.emit('did-fail-load', -105, 'dns', 'app://x', false);
    vi.advanceTimersByTime(1000);
    expect(contents.reload).not.toHaveBeenCalled();
    contents.emit('did-fail-load', -105, 'dns', 'app://x', true);
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(contents.reload).toHaveBeenCalledTimes(1);
  });

  it('in development a failed load asks straight away (the dev server is probably down)', async () => {
    const { contents, asked } = setup({ devServer: true });
    contents.emit('did-fail-load', -102, 'refused', 'http://localhost:5273', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toEqual(['crash']);
    expect(contents.reload).not.toHaveBeenCalled();
  });
});

describe('attachRendererRecovery - guards (AC-75)', () => {
  it('while quitting, none of the three events reload or ask', async () => {
    const { contents, state, asked } = setup();
    state.quitting = true;
    contents.emit('render-process-gone', { reason: 'killed' });
    contents.emit('did-fail-load', -2, 'failed', 'app://x', true);
    contents.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(UNRESPONSIVE_GRACE_MS + 1000);
    expect(contents.reload).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it('a window destroyed during the reload delay is not reloaded', () => {
    const { contents } = setup();
    contents.emit('render-process-gone', { reason: 'crashed' });
    contents.destroyed = true;
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(contents.reload).not.toHaveBeenCalled();
  });

  it('events on an already destroyed window never throw', () => {
    const { contents } = setup();
    contents.destroyed = true;
    expect(() => {
      contents.emit('render-process-gone', { reason: 'crashed' });
      contents.emit('unresponsive');
    }).not.toThrow();
  });

  it('only one dialog is open at a time', async () => {
    const { contents, asked, resolvers } = setup();
    for (let index = 0; index < 5; index += 1) contents.emit('render-process-gone', { reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
    expect(asked).toEqual(['crash']); // the 3rd failure opened it; the 4th and 5th did not stack another
    resolvers[0]?.('wait');
  });
});

describe('attachRendererRecovery - restart target', () => {
  it('uses the supplied restart (e.g. load the app address after a failed navigation) instead of reload()', () => {
    const restart = vi.fn();
    const { contents } = setup({ restart });
    contents.emit('did-fail-load', -105, 'dns', 'http://127.0.0.1:1', true);
    vi.advanceTimersByTime(RELOAD_DELAY_MS);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(contents.reload).not.toHaveBeenCalled();
  });
});

describe('attachRendererRecovery - unresponsive', () => {
  it('asks only after the grace period, and not at all if the page recovers first', async () => {
    const { contents, asked } = setup();
    contents.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(UNRESPONSIVE_GRACE_MS - 1);
    contents.emit('responsive');
    await vi.advanceTimersByTimeAsync(UNRESPONSIVE_GRACE_MS * 2);
    expect(asked).toEqual([]);

    contents.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(UNRESPONSIVE_GRACE_MS);
    expect(asked).toEqual(['hang']);
  });

  it('"reload" kills the stuck renderer, and the restart that follows is not counted as a crash', async () => {
    const { contents, answers, deps } = setup();
    answers.push('reload');
    contents.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(UNRESPONSIVE_GRACE_MS);
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    contents.emit('render-process-gone', { reason: 'killed' });
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
    expect(contents.reload).toHaveBeenCalledTimes(1);
    // two more real crashes are still reloaded quietly: the user-chosen one did not use a slot
    contents.emit('render-process-gone', { reason: 'crashed' });
    contents.emit('render-process-gone', { reason: 'crashed' });
    await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
    expect(contents.reload).toHaveBeenCalledTimes(3);
    expect(deps.quit).not.toHaveBeenCalled();
  });

  it('"keep waiting" leaves the renderer alone', async () => {
    const { contents, answers } = setup();
    answers.push('wait');
    contents.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(UNRESPONSIVE_GRACE_MS);
    expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    expect(contents.reload).not.toHaveBeenCalled();
  });
});
