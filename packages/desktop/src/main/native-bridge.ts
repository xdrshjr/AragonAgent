/**
 * Everything that touches the operating system on the renderer's behalf: opening files and
 * folders, external links, notifications, the folder picker, the dock/taskbar badge.
 *
 * The renderer renders model-written text, so it is never allowed to name an arbitrary path.
 * A path request arrives as (session, relative path) and is accepted only if, after resolving
 * symlinks, it lies inside that session's working directory or the home root. The containment
 * test is a path-SEGMENT comparison (`relative()` must not climb out): a prefix test would call
 * `/work-evil` "inside" `/work`, and a junction pointing out of the workspace would pass a
 * lexical check - hence `realpath` first.
 */

import { copyFileSync, existsSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BrowserWindow, Notification, app, dialog, shell } from 'electron';
import type { NotificationQueue } from './e2e-support.js';
import { isSafeExternalUrl } from './protocols.js';
import { lookupLedger, sessionAttachmentsDir, type LedgerEntry } from '../host/attachment-ledger.js';

/** True when `child` is `parent` or lies beneath it, comparing whole path segments. */
export function isInsideDir(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

/**
 * Resolve `relPath` against the first allowed root that contains it, or return null.
 * Symlinks are resolved on both sides before comparing; a path that does not exist cannot be
 * proven to be inside anything and is refused.
 */
export function resolveAllowedPath(roots: readonly string[], relPath: string): string | null {
  if (relPath.includes('\0')) return null;
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    const candidate = isAbsolute(relPath) ? relPath : resolve(realRoot, relPath);
    if (!existsSync(candidate)) continue;
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      continue;
    }
    if (isInsideDir(realRoot, real)) return real;
  }
  return null;
}

export interface ActivityLevels {
  running: number;
  waiting: number;
}

/** What to do to the OS for an activity level; the pure part of `setActivity`, unit-tested. */
export interface ActivityPlan {
  /** -1 clears the progress bar; 2 means indeterminate (Windows). */
  progress: -1 | 2 | null;
  flash: boolean | null;
  badge: number | null;
  bounce: boolean;
}

export function planActivity(
  activity: ActivityLevels, previousWaiting: number, platform: NodeJS.Platform, focused: boolean,
): ActivityPlan {
  const plan: ActivityPlan = { progress: null, flash: null, badge: null, bounce: false };
  if (platform === 'win32') {
    plan.progress = activity.running > 0 && !focused ? 2 : -1;
    plan.flash = activity.waiting > 0 && !focused;
  } else if (platform === 'darwin') {
    plan.badge = activity.waiting;
    plan.bounce = activity.waiting > previousWaiting && !focused;
  } else {
    plan.badge = activity.waiting;
  }
  return plan;
}

export interface NativeBridgeDeps {
  /** The session's working directory, or null when the session is unknown. */
  sessionCwd(sessionId: string): string | null;
  homeRoot: string;
  /** Called when a notification is clicked. */
  onNotificationClick(sessionId: string | undefined): void;
  /** `--e2e` runs only: notifications land here instead of the operating system. */
  queue?: NotificationQueue;
}

export class NativeBridge {
  constructor(private readonly deps: NativeBridgeDeps) {}

  async openPath(sessionId: string, relPath: string, reveal: boolean): Promise<boolean> {
    const cwd = this.deps.sessionCwd(sessionId);
    const roots = [...(cwd ? [cwd] : []), this.deps.homeRoot];
    const target = resolveAllowedPath(roots, relPath);
    if (!target) return false;
    if (reveal) {
      shell.showItemInFolder(target);
      return true;
    }
    return (await shell.openPath(target)) === '';
  }

  /** The ledger row for an attachment of this session, or null. The id is the only input. */
  private attachmentEntry(sessionId: string, attachmentId: string): LedgerEntry | null {
    const dir = sessionAttachmentsDir(this.deps.homeRoot, sessionId);
    const entry = dir ? lookupLedger(dir, attachmentId) : null;
    return entry && existsSync(entry.path) ? entry : null;
  }

  revealAttachment(sessionId: string, attachmentId: string): boolean {
    const entry = this.attachmentEntry(sessionId, attachmentId);
    if (!entry) return false;
    shell.showItemInFolder(entry.path);
    return true;
  }

  /** Copy a STAGED attachment; a reference attachment is the user's own file and is not copied. */
  async saveAttachment(
    window: BrowserWindow | null, sessionId: string, attachmentId: string, suggestedName: string,
  ): Promise<string | null | undefined> {
    const entry = this.attachmentEntry(sessionId, attachmentId);
    if (!entry || !entry.staged) return undefined;
    const base = basename(suggestedName.replace(/[\\/]+/g, '/')) || entry.name;
    const defaultPath = join(this.deps.sessionCwd(sessionId) ?? this.deps.homeRoot, base);
    const options = { defaultPath };
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    copyFileSync(entry.path, result.filePath);
    return result.filePath;
  }

  async openExternal(url: string): Promise<boolean> {
    if (!isSafeExternalUrl(url)) return false;
    await shell.openExternal(url);
    return true;
  }

  /** Only when no window is focused: a notification on top of the window you are reading is noise. */
  notify(title: string, body: string, sessionId?: string): boolean {
    const queue = this.deps.queue;
    if (!queue && !Notification.isSupported()) return false;
    if (BrowserWindow.getAllWindows().some((window) => window.isFocused())) return false;
    if (queue) {
      queue.push({ title, body, ...(sessionId ? { sessionId } : {}) }, () => this.deps.onNotificationClick(sessionId));
      return true;
    }
    const notification = new Notification({ title, body, silent: false });
    notification.on('click', () => this.deps.onNotificationClick(sessionId));
    notification.show();
    return true;
  }

  async pickFolder(parent: BrowserWindow | null): Promise<string | null> {
    const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? null : (result.filePaths[0] ?? null);
  }

  private lastWaiting = 0;

  /**
   * Taskbar / dock presentation of "something is running / needs you". Every call is guarded: an
   * unsupported desktop environment or a window that is closing must never surface as an error.
   */
  setActivity(activity: ActivityLevels, window: BrowserWindow | null): boolean {
    if (window && window.isDestroyed()) return false;
    const plan = planActivity(activity, this.lastWaiting, process.platform, window?.isFocused() ?? false);
    this.lastWaiting = activity.waiting;
    try {
      if (plan.progress !== null) window?.setProgressBar(plan.progress, plan.progress === 2 ? { mode: 'indeterminate' } : undefined);
      if (plan.flash !== null) window?.flashFrame(plan.flash);
      if (plan.badge !== null) app.setBadgeCount(plan.badge);
      if (plan.bounce) app.dock?.bounce('informational');
    } catch { /* unsupported on this desktop environment */ }
    return true;
  }

  setBadge(count: number): void {
    try { app.setBadgeCount(count); } catch { /* unsupported on this desktop environment */ }
  }
}
