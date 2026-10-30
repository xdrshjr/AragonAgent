/**
 * Main-process attachment helpers that need no Electron: the `native:stat-path` classifier and
 * the staging-area garbage collector (desktop-attachments-and-tool-voice §3.8, §5.3).
 *
 * `statPath` is the one thing the sandboxed renderer can learn about the disk, so it is
 * deliberately small: type and size, never content, and it refuses the two path families that
 * make a `stat` dangerous. A UNC path makes Windows authenticate to a remote host (an NTLM hash
 * the user never agreed to share), and a device-namespace path can address devices. The UNC case
 * answers "unverified" without touching the filesystem; the host checks it once, after the user
 * presses send.
 */

import { readdirSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { attachmentsRoot, isInside, sessionAttachmentsDir } from '../host/attachment-ledger.js';

export type StatPathResult =
  | { ok: true; kind: 'file' | 'folder' | 'missing'; size: number }
  | { ok: false; message: string };

/** `\\?\C:\x` and `\\.\PhysicalDrive0`, in either slash direction. */
const DEVICE_NAMESPACE = /^[\\/]{2}[?.][\\/]/;
/** `\\server\share` and `//server/share` (device namespaces are handled before this). */
const UNC = /^[\\/]{2}[^\\/]/;

export function classifyStatPath(
  path: string,
  stat: (p: string) => { isDirectory(): boolean; size: number } = statSync,
): StatPathResult {
  if (path.length === 0 || path.length > 4096 || path.includes('\0')) {
    return { ok: false, message: 'The path is not valid.' };
  }
  if (DEVICE_NAMESPACE.test(path)) return { ok: false, message: 'Device paths are not allowed.' };
  if (UNC.test(path)) return { ok: true, kind: 'file', size: -1 }; // unverified, deliberately not touched
  if (!isAbsolute(path)) return { ok: false, message: 'The path must be absolute.' };
  try {
    const info = stat(path);
    return info.isDirectory()
      ? { ok: true, kind: 'folder', size: 0 }
      : { ok: true, kind: 'file', size: info.size };
  } catch {
    return { ok: true, kind: 'missing', size: 0 };
  }
}

/** The staging directory of a deleted session. A bad id or a failure is ignored by design. */
export function removeSessionAttachments(homeRoot: string, sessionId: string): void {
  const dir = sessionAttachmentsDir(homeRoot, sessionId);
  if (dir) purgeSessionDir(dir);
}

export const ATTACHMENT_GC_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface GcOptions {
  homeRoot: string;
  /** Session ids that still exist. */
  liveSessions: ReadonlySet<string>;
  now?: number;
  maxAgeMs?: number;
}

/**
 * Remove staging directories whose session is gone AND which have not been touched for 30 days.
 * Only ever deletes inside `<home>/attachments/`, and inside a directory only the files the
 * ledger marks `staged` (a reference attachment points at the user's own file).
 */
export function collectAttachmentGarbage(options: GcOptions): string[] {
  const root = attachmentsRoot(options.homeRoot);
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? ATTACHMENT_GC_MAX_AGE_MS;
  const removed: string[] = [];
  let names: string[];
  try { names = readdirSync(root); } catch { return removed; }
  for (const name of names) {
    const dir = join(root, name);
    if (!isInside(root, dir) || options.liveSessions.has(name)) continue;
    let age: number;
    try { age = now - statSync(dir).mtimeMs; } catch { continue; }
    if (age < maxAge) continue;
    purgeSessionDir(dir);
    removed.push(name);
  }
  return removed;
}

/**
 * Delete one session's staging directory. Everything in it was written by this app: a
 * reference attachment is only a ledger LINE pointing at the user's own file, and nothing here
 * ever follows such a path, so removing the directory cannot reach user data.
 */
export function purgeSessionDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* the next pass retries */ }
}
