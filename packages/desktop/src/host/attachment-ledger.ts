/**
 * The attachment staging area and its ledger (desktop-attachments-and-tool-voice D-11).
 *
 *   <home>/attachments/<sessionId>/<att-xxxxxxxxxxxx>.<ext>   staged bytes
 *   <home>/attachments/<sessionId>/ledger.jsonl               one JSON object per line
 *
 * The ledger is the ONLY resolver from an attachment id to a path. The renderer never names a
 * disk path: it hands over an id, and the host or the main process looks it up here. Shared by
 * the session host and the main process, so it imports nothing from Electron.
 *
 * Reads tolerate a damaged file (a torn last line after a crash must not hide the rest).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface LedgerEntry {
  id: string;
  kind: 'image' | 'file' | 'folder';
  name: string;
  /** Absolute path: the staged copy when `staged`, otherwise the user's own file. */
  path: string;
  size: number;
  at: number;
  /** True only for files this app wrote. Garbage collection must never touch the others. */
  staged: boolean;
  mediaType?: string;
}

export const LEDGER_FILE = 'ledger.jsonl';
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ATTACHMENT_ID_RE = /^att-[0-9a-f]{12}$/;

export function attachmentsRoot(homeRoot: string): string {
  return join(homeRoot, 'attachments');
}

/** The session's directory, or null when the id could escape `attachments/`. */
export function sessionAttachmentsDir(homeRoot: string, sessionId: string): string | null {
  if (!SESSION_ID_RE.test(sessionId) || sessionId === '.' || sessionId === '..') return null;
  const root = attachmentsRoot(homeRoot);
  const dir = resolve(root, sessionId);
  return isInside(root, dir) ? dir : null;
}

/** Path-segment containment (a prefix test would call `attachments-evil` a child of `attachments`). */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function isAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && ATTACHMENT_ID_RE.test(value);
}

export function ensureSessionDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** One atomic-enough line append (< 1 KB). A failure degrades the feature; it never throws. */
export function appendLedger(dir: string, entry: LedgerEntry): boolean {
  try {
    ensureSessionDir(dir);
    appendFileSync(join(dir, LEDGER_FILE), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return isAttachmentId(e.id)
    && (e.kind === 'image' || e.kind === 'file' || e.kind === 'folder')
    && typeof e.name === 'string' && typeof e.path === 'string' && isAbsolute(e.path)
    && typeof e.size === 'number' && typeof e.at === 'number' && typeof e.staged === 'boolean';
}

export function readLedger(dir: string): LedgerEntry[] {
  const file = join(dir, LEDGER_FILE);
  if (!existsSync(file)) return [];
  let raw: string;
  try { raw = readFileSync(file, 'utf-8'); } catch { return []; }
  const out: LedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isLedgerEntry(parsed)) out.push(parsed);
    } catch { /* a torn line */ }
  }
  return out;
}

/** The last record for `id` wins; a staged record must still point inside the session directory. */
export function lookupLedger(dir: string, id: string): LedgerEntry | null {
  if (!isAttachmentId(id)) return null;
  const found = [...readLedger(dir)].reverse().find((entry) => entry.id === id);
  if (!found) return null;
  if (found.staged && !isInside(dir, found.path)) return null;
  return found;
}
