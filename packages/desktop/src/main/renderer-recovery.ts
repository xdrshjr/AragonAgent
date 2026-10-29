/**
 * What to do when a window's renderer dies, fails to load, or stops responding.
 *
 * The session hosts are `utilityProcess` children of the MAIN process, so a renderer crash costs the
 * user nothing but a blank window - provided something reloads it. This module is that something:
 * `RecoveryPolicy` is the Electron-free decision (reload twice quietly, then ask), and
 * `attachRendererRecovery` is the thin wiring, written against a structural `WebContentsLike` so the
 * guards (quitting, destroyed window, single dialog, late timer) are unit-tested without Electron.
 */

export type RecoveryAction = 'reload' | 'ask' | 'ignore';

export class RecoveryPolicy {
  private failures: number[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs = 60_000,
    private readonly maxAuto = 2,
  ) {}

  /** Record a failure and say what to do. A clean exit never counts. */
  onFailure(reason: string): RecoveryAction {
    if (reason === 'clean-exit') return 'ignore';
    const at = this.now();
    this.failures = this.failures.filter((time) => at - time < this.windowMs);
    this.failures.push(at);
    return this.failures.length <= this.maxAuto ? 'reload' : 'ask';
  }

  reset(): void {
    this.failures = [];
  }
}

export const UNRESPONSIVE_GRACE_MS = 15_000;
export const RELOAD_DELAY_MS = 250;
/** `net::ERR_ABORTED`: a navigation superseded by another one. Normal, never a failure. */
export const ERR_ABORTED = -3;

export type RecoveryChoice = 'reload' | 'logs' | 'quit' | 'wait';

export interface WebContentsLike {
  isDestroyed(): boolean;
  reload(): void;
  forcefullyCrashRenderer(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface RecoveryDeps {
  policy: RecoveryPolicy;
  /** True once the application is quitting (our own teardown reports `killed`). */
  isQuitting(): boolean;
  /** True in development, where a failed load is a dev-server problem: ask instead of retrying. */
  devServer: boolean;
  /** Extra text for the dialog, e.g. the engine error. */
  detail(): string | null;
  ask(kind: 'crash' | 'hang', detail: string | null): Promise<RecoveryChoice>;
  /**
   * Bring the window back. Defaults to `reload()`; the real wiring loads the app's own address when the
   * window is sitting on something else (a failed navigation leaves the error URL as the "current" one).
   */
  restart?(): void;
  openLogs(): void;
  quit(): void;
  log(level: 'info' | 'warn', message: string, extra?: Record<string, unknown>): void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface RecoveryHandle {
  /** The path `render-process-gone` takes; also the seam unit tests drive. */
  fail(reason: string): void;
}

export function attachRendererRecovery(contents: WebContentsLike, deps: RecoveryDeps): RecoveryHandle {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let dialogOpen = false;
  let hangTimer: unknown = null;

  const dead = (): boolean => deps.isQuitting() || contents.isDestroyed();

  const reloadLater = (): void => {
    setTimer(() => {
      if (dead()) return; // the window may have closed during the delay
      try { (deps.restart ?? (() => contents.reload()))(); } catch (error) { deps.log('warn', 'reload failed', { error: String(error) }); }
    }, RELOAD_DELAY_MS);
  };

  const askUser = async (kind: 'crash' | 'hang'): Promise<void> => {
    if (dialogOpen) { deps.log('info', 'recovery dialog already open', { kind }); return; }
    dialogOpen = true;
    try {
      for (;;) {
        const choice = await deps.ask(kind, deps.detail());
        if (dead()) return;
        if (choice === 'logs') { deps.openLogs(); continue; }
        if (choice === 'quit') { deps.quit(); return; }
        if (choice === 'reload') {
          deps.policy.reset();
          if (kind === 'hang') {
            // A user-chosen reload of a stuck renderer: kill it, and the crash path reloads it.
            try { contents.forcefullyCrashRenderer(); } catch { /* already gone */ }
            userChosenReload = true;
          } else {
            reloadLater();
          }
        }
        return;
      }
    } finally {
      dialogOpen = false;
    }
  };

  /** Set when the next `render-process-gone` is the one WE asked for; it must not count. */
  let userChosenReload = false;

  const fail = (reason: string): void => {
    if (dead()) return;
    if (userChosenReload) {
      userChosenReload = false;
      deps.log('info', 'renderer restarted at the user\'s request', { reason });
      reloadLater();
      return;
    }
    const action = deps.devServer && reason.startsWith('load') ? 'ask' : deps.policy.onFailure(reason);
    deps.log('warn', 'renderer failure', { reason, action });
    if (action === 'reload') reloadLater();
    else if (action === 'ask') void askUser('crash');
  };

  contents.on('render-process-gone', (_event: unknown, details: { reason?: string }) => fail(details?.reason ?? 'crashed'));
  contents.on('did-fail-load', (_event: unknown, errorCode: number, _desc: string, _url: string, isMainFrame: boolean) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    fail(`load:${errorCode}`);
  });
  contents.on('unresponsive', () => {
    if (dead() || hangTimer !== null) return;
    hangTimer = setTimer(() => {
      hangTimer = null;
      if (!dead()) void askUser('hang');
    }, UNRESPONSIVE_GRACE_MS);
  });
  contents.on('responsive', () => {
    if (hangTimer !== null) { clearTimer(hangTimer); hangTimer = null; }
  });

  return { fail };
}
