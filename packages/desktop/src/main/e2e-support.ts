/**
 * Everything the end-to-end harness needs from the app, and nothing it does not.
 *
 * Switches are COMMAND-LINE ONLY (never environment variables) and are parsed only when the build
 * flavor allows test switches. In a `release` build `parseE2eOptions` returns the same "all off"
 * value whatever it is given, and `installE2eHooks` installs nothing - so the behavior of a release
 * build is identical with and without these arguments (`build-flavor.test.ts` asserts exactly that).
 *
 *   --e2e                    fixed 1280x800 window, no restored window state, notifications go to
 *                            an in-memory queue instead of the OS (read through `globalThis.__aragonE2e`)
 *   --e2e-restore-window     (with --e2e) do NOT pin the window: run the real restore / persist path, so
 *                            the window-geometry tests can seed a saved state and read it back
 *   --e2e-fault=enospc|eacces  every config write fails the way a full / read-only disk does
 *   --e2e-feed=<url>         the update check reads this manifest; loopback http is allowed here
 *                            and nowhere else
 *   --e2e-user-data=<abs>    Electron's userData lives here, so the single-instance lock is keyed to
 *                            THIS run and not to whatever installed / dev instance is already open
 */

import { isAbsolute } from 'node:path';

import { allowsTestSwitches, type BuildFlavor } from './build-flavor.js';

export type E2eFault = 'enospc' | 'eacces';

export interface E2eOptions {
  enabled: boolean;
  fault: E2eFault | null;
  feedUrl: string | null;
  /** `--e2e` normally pins a 1280x800 window and never reads or writes window state. */
  restoreWindow: boolean;
  /** Absolute directory for Electron's `userData`, applied before the single-instance lock is requested. */
  userDataDir: string | null;
}

export const E2E_OFF: E2eOptions = { enabled: false, fault: null, feedUrl: null, restoreWindow: false, userDataDir: null };

export const E2E_WINDOW = { width: 1280, height: 800 } as const;

const FAULTS: readonly E2eFault[] = ['enospc', 'eacces'];

export function parseE2eOptions(argv: readonly string[], flavor: BuildFlavor): E2eOptions {
  if (!allowsTestSwitches(flavor)) return E2E_OFF;
  const value = (name: string): string | null => {
    const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const fault = value('e2e-fault');
  const userData = value('e2e-user-data');
  return {
    enabled: argv.includes('--e2e'),
    fault: FAULTS.find((candidate) => candidate === fault) ?? null,
    feedUrl: value('e2e-feed') || null,
    restoreWindow: argv.includes('--e2e-restore-window'),
    userDataDir: userData && isAbsolute(userData) && !userData.includes('\x00') ? userData : null,
  };
}

/** A notification the app would have shown. */
export interface QueuedNotification {
  title: string;
  body: string;
  sessionId?: string;
}

/** The in-memory stand-in for the OS notification center in an `--e2e` run. */
export class NotificationQueue {
  private readonly items: Array<QueuedNotification & { click: () => void }> = [];

  push(item: QueuedNotification, click: () => void): void {
    this.items.push({ ...item, click });
  }

  /** Read and clear. */
  drain(): QueuedNotification[] {
    return this.items.splice(0).map(({ click: _click, ...rest }) => rest);
  }

  /** Invoke the click handler of the n-th queued item (0-based) as the OS would. */
  activate(index: number): boolean {
    const item = this.items[index];
    if (!item) return false;
    item.click();
    return true;
  }

  get size(): number {
    return this.items.length;
  }
}

/** A native message box the app would have shown, parked until the harness answers it. */
export class E2eDialogQueue {
  private readonly open: Array<{ kind: string; choices: string[]; resolve: (index: number) => void }> = [];

  ask(kind: string, choices: string[]): Promise<number> {
    return new Promise((resolve) => { this.open.push({ kind, choices, resolve }); });
  }

  pending(): Array<{ kind: string; choices: string[] }> {
    return this.open.map(({ kind, choices }) => ({ kind, choices }));
  }

  /** Answer the oldest open box with the button at `index`. */
  answer(index: number): boolean {
    const box = this.open.shift();
    if (!box) return false;
    box.resolve(index);
    return true;
  }
}

/** Hooks that need Electron objects; supplied by index.ts, never constructed here. */
export interface E2eHostHooks {
  crashRenderer(windowIndex?: number): void;
  failLoad(windowIndex?: number): void;
  pendingMessageBoxes(): Array<{ kind: string; choices: string[] }>;
  answerMessageBox(index: number): boolean;
  getWindowGeometry(windowIndex?: number): {
    bounds: { x: number; y: number; width: number; height: number };
    normalBounds: { x: number; y: number; width: number; height: number };
    maximized: boolean; zoom: number; visible: boolean;
    /** What the main process last handed to Electron for the caption strip (null on macOS). */
    overlayHeight: number | null;
    overlayColor: string | null;
    overlaySymbol: string | null;
    backgroundColor: string | null;
  };
  setZoom(factor: number, windowIndex?: number): void;
}

/** Names of the hooks installed on the main process's global object in an `--e2e` run. */
export const E2E_HOOKS = ['drainNotifications', 'activateNotification'] as const;
export const E2E_HOST_HOOKS = [
  'crashRenderer', 'failLoad', 'pendingMessageBoxes', 'answerMessageBox', 'getWindowGeometry', 'setZoom',
] as const;

export interface E2eHooks extends Partial<E2eHostHooks> {
  drainNotifications(): QueuedNotification[];
  activateNotification(index?: number): boolean;
}

/**
 * Expose the harness's reads on `globalThis.__aragonE2e` - a MAIN-process global, reachable
 * from Playwright's `electronApp.evaluate` and from nothing else. Deliberately not an IPC channel:
 * the preload's allow-list would (rightly) refuse it, and a renderer that could read or click the
 * notification queue is a renderer that could forge "the user clicked the notification".
 * A no-op unless `options.enabled`, which a release build never sets. Returns what it installed.
 */
export function installE2eHooks(
  target: object, options: E2eOptions, queue: NotificationQueue, host?: E2eHostHooks,
): string[] {
  if (!options.enabled) return [];
  const hooks: E2eHooks = {
    drainNotifications: () => queue.drain(),
    activateNotification: (index = 0) => queue.activate(index),
    ...(host ?? {}),
  };
  (target as { __aragonE2e?: E2eHooks }).__aragonE2e = hooks;
  return [...E2E_HOOKS, ...(host ? E2E_HOST_HOOKS : [])];
}
