/**
 * The id-keyed session store behind `aragon exec` (cli-integration-surface
 * section 3.4 / 4.3).
 *
 * ASCII ONLY - `src/session/**` is inside the glyph scanner's scope from this
 * feature onward (R-3 / AC-25). `session/` was outside the predicate BEFORE this
 * change too, so adding it is closing a pre-existing hole rather than extending
 * a guard to new code.
 *
 * `persist.ts` KEEPS THE FILE FORMAT; this module owns identity, listing,
 * retention and mutual exclusion. The two exist separately because the format is
 * shared with the TUI's `/save` and must not acquire exec-shaped opinions.
 *
 * THE DIRECTORY IS SHARED WITH `/save`, AND EVERY LISTING RULE HERE FOLLOWS FROM
 * THAT (P1-5 / R-16). `resolveSessionPath` puts every bare-name and default
 * `/save` target in `getSessionsDir()`, so a naive `prune` would delete
 * conversations a human saved by hand - unrecoverable loss, from a maintenance
 * command the docs recommend. `list` and `prune` therefore see only files
 * carrying `meta.id`; `show` and `rm` accept any id, because the user named it.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import type { ModelRef } from '@aragon-agent/core';
import { getSessionsDir } from '../config/app-paths.js';
import { loadSession, saveSession, type SavedSession, type SessionMeta } from './persist.js';

/**
 * The id is a FILENAME under the user's home directory, and the caller supplying
 * it is frequently the least trusted input in the pipeline (a branch name, a
 * ticket id, a webhook field). Rejecting `/`, `\`, `..` and a leading dot is a
 * SECURITY REQUIREMENT, not tidiness (R-7 / AC-8).
 *
 * A leading dot is excluded by the first character class rather than by a
 * separate check, which is also what keeps `.last.json` unreachable as an id.
 */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/**
 * 10 minutes, matching `UPDATE_LIMITS.lockTtlMs`.
 *
 * The TTL is the WORST CASE for a wedge, so a long one is not the safe choice:
 * without the liveness probe below, a CI job killed mid-run would hold its
 * `--session-id` for the whole window and every retry would return
 * `session_busy` - a hang wearing an exit code, in the one environment this
 * feature exists for.
 */
export const SESSION_LOCK_TTL_MS = 600_000;

/** The `--continue` pointer. A CACHE, with a documented scan fallback (R-9). */
const POINTER_FILE = '.last.json';

export interface SessionListEntry {
  id: string;
  path: string;
  savedAt: number;
  updatedAt: number;
  cwd: string;
  turns: number;
  provider: string;
  model: string;
  /** `true` when the file carries `meta.id`, i.e. `aragon exec` wrote it. */
  managed: boolean;
}

export function sessionsDir(): string {
  return getSessionsDir();
}

/**
 * THE CHOKE POINT. Every string that becomes a session filename passes here.
 *
 * `isValidSessionId` is applied HERE rather than only at `--session-id`, because
 * that flag is not the only way a caller-supplied string reaches this function:
 * `--resume <id|path>` derives an id from the resumed FILE, `sessions rm` /
 * `sessions show` take one straight from argv, and a session file can carry any
 * `meta.id` at all. Guarding each caller instead would mean the boundary holds
 * only for the callers someone remembered - and `join()` silently normalises
 * `../..` away, so an escape leaves no trace to notice later. Validating at the
 * single point that builds the path is what makes R-7 a property of the module
 * rather than a habit of its callers.
 *
 * THROWS rather than coercing to a "safe" name: a caller who asked for one file
 * and silently got another is a worse failure than a loud one, and every caller
 * that can be handed untrusted input validates first and reports exit 2 itself.
 */
function assertSessionId(id: string): string {
  if (!isValidSessionId(id)) {
    throw new Error(
      `Invalid session id "${id}": expected 1-64 characters matching ` +
        '[A-Za-z0-9][A-Za-z0-9._-]* (no "/", "\\", ".." or a leading dot).',
    );
  }
  return id;
}

export function sessionPathFor(id: string): string {
  return join(getSessionsDir(), `${assertSessionId(id)}.json`);
}

/**
 * The id a RESUMED session writes back under.
 *
 * `--resume` accepts `<id|path>`, so the value the caller typed is NOT usable as
 * an id: `--resume ./sessions/hand-saved.json` would otherwise make the path
 * itself the id, and every later `sessionPathFor` / lock call would build a
 * filename out of it - outside the sessions directory whenever the path was
 * relative. That is the same write primitive `--session-id` is validated to
 * prevent, arriving through the flag next to it. `meta.id` is no safer: it comes
 * out of a file, and files are inputs.
 *
 * The order is the one that keeps every legitimate resume landing where the user
 * expects: an exec-written session names itself, a TUI `/save` is named by its
 * file, and anything else gets a fresh id rather than a guess - reported back in
 * `system.init.sessionId` and `result.sessionId`, so the caller is never left
 * wondering which session it just wrote.
 */
export function resumedSessionId(path: string, saved: SavedSession): string {
  const declared = saved.meta?.id;
  if (typeof declared === 'string' && isValidSessionId(declared)) return declared;
  const base = basenameId(path);
  if (isValidSessionId(base)) return base;
  return randomUUID();
}

function ensureDir(): string {
  const dir = getSessionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

/** Read one file, or `null` for anything unreadable. NEVER THROWS. */
export function readSessionFile(path: string): SavedSession | null {
  try {
    return loadSession(path);
  } catch {
    return null;
  }
}

/**
 * Resolve `--resume <id|path>` to a file that exists, or `null`.
 *
 * A value containing a separator, or an absolute one, is a PATH; anything else
 * is an id. That split is the same one `resolveSessionPath` makes for `/save`,
 * so the two spellings agree about what "a name" means.
 */
export function resolveSessionRef(idOrPath: string, cwd: string): string | null {
  const value = idOrPath.trim();
  if (value.length === 0) return null;
  const looksLikePath =
    isAbsolute(value) || value.includes('/') || value.includes('\\') || value.endsWith('.json');
  const path = looksLikePath
    ? resolve(cwd, value)
    : isValidSessionId(value)
      ? sessionPathFor(value)
      : null;
  if (!path) return null;
  return existsSync(path) ? path : null;
}

export interface WriteSessionInput {
  id: string;
  session: Omit<SavedSession, 'version' | 'savedAt' | 'meta' | 'model'> & { model: ModelRef };
  meta: SessionMeta;
}

/**
 * Write a session and refresh the `--continue` pointer.
 *
 * THE POINTER IS UPDATED AFTER THE FILE, never before: a crash between the two
 * leaves a pointer naming a file that is one run stale, which the fallback scan
 * corrects. The other order would leave a pointer naming a file that does not
 * exist yet.
 */
export function writeSession(input: WriteSessionInput): string {
  ensureDir();
  const path = sessionPathFor(input.id);
  saveSession(path, {
    model: input.session.model,
    messages: input.session.messages,
    ...(input.session.compactionIdentity
      ? { compactionIdentity: input.session.compactionIdentity } : {}),
    entries: input.session.entries,
    todos: input.session.todos ?? [],
    meta: input.meta,
  });
  writePointer(input.meta.cwd, input.id, input.meta.updatedAt);
  return path;
}

export function removeSession(id: string): boolean {
  // An id that cannot name a session in this directory has not "failed to be
  // deleted" - there was never a file of that name to delete. `sessions rm`
  // validates first and reports the reason, so this stays a boolean.
  if (!isValidSessionId(id)) return false;
  const path = sessionPathFor(id);
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

function describe(path: string, session: SavedSession): SessionListEntry {
  const meta = session.meta;
  const id = meta?.id ?? basenameId(path);
  return {
    id,
    path,
    savedAt: session.savedAt ?? 0,
    updatedAt: meta?.updatedAt ?? session.savedAt ?? 0,
    cwd: meta?.cwd ?? '',
    turns: meta?.turns ?? 0,
    provider: meta?.provider ?? session.model?.providerId ?? '',
    model: meta?.model ?? session.model?.modelId ?? '',
    managed: typeof meta?.id === 'string' && meta.id.length > 0,
  };
}

function basenameId(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
  return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
}

/**
 * Every session in the directory, newest first.
 *
 * `all: false` (the default) keeps ONLY exec-managed files. `.last.json` and
 * `*.lock` are excluded by name on both paths, because neither is a session in
 * any sense and listing them would invite `sessions rm` on the pointer.
 */
export function listSessions(opts: { all?: boolean } = {}): SessionListEntry[] {
  const dir = getSessionsDir();
  if (!existsSync(dir)) return [];
  const out: SessionListEntry[] = [];
  for (const name of safeReaddir(dir)) {
    if (name === POINTER_FILE || name.endsWith('.lock') || !name.endsWith('.json')) continue;
    const path = join(dir, name);
    const session = readSessionFile(path);
    if (!session) continue;
    const entry = describe(path, session);
    if (!opts.all && !entry.managed) continue;
    out.push(entry);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export interface PruneOptions {
  olderThanDays?: number;
  dryRun?: boolean;
  all?: boolean;
  now?: () => number;
}

/** `--dry-run` reports and deletes nothing; nothing is ever pruned automatically. */
export function pruneSessions(opts: PruneOptions = {}): SessionListEntry[] {
  const now = (opts.now ?? Date.now)();
  const cutoff =
    opts.olderThanDays === undefined ? now : now - opts.olderThanDays * 24 * 60 * 60 * 1000;
  const doomed = listSessions({ ...(opts.all ? { all: true } : {}) }).filter(
    (entry) => entry.updatedAt <= cutoff,
  );
  if (opts.dryRun) return doomed;
  for (const entry of doomed) {
    try {
      unlinkSync(entry.path);
    } catch {
      // A file that vanished under us, or one the OS has pinned. Neither is a
      // reason to abandon the rest of the sweep.
    }
  }
  return doomed;
}

// ---------------------------------------------------------------------------
// `--continue`: the pointer, and the scan that makes it safe to keep
// ---------------------------------------------------------------------------

function cwdKey(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16);
}

type PointerFile = Record<string, { id: string; updatedAt: number }>;

function readPointer(): PointerFile {
  try {
    const parsed = JSON.parse(readFileSync(join(getSessionsDir(), POINTER_FILE), 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as PointerFile) : {};
  } catch {
    return {};
  }
}

function writePointer(cwd: string, id: string, updatedAt: number): void {
  try {
    const pointer = readPointer();
    pointer[cwdKey(cwd)] = { id, updatedAt };
    // Not atomic, and it does not need to be: a torn write yields unparseable
    // JSON, `readPointer` returns `{}`, and `latestSessionForCwd` falls back to
    // the directory scan. The failure mode is one slower `--continue`.
    writeFileSync(join(getSessionsDir(), POINTER_FILE), `${JSON.stringify(pointer)}\n`, 'utf-8');
  } catch {
    // The pointer is a cache. Failing to write it must never fail a run whose
    // session file is already safely on disk.
  }
}

/**
 * The newest exec session whose `meta.cwd` matches, or `null`.
 *
 * THE POINTER IS A CACHE AND IS TREATED AS ONE (R-9 / AC-9). If it is missing,
 * unparseable, or names a file that is gone, this falls through to reading the
 * directory - so a desync SELF-HEALS instead of stranding the user, which is the
 * property that makes it safe to keep a denormalised index at all.
 */
export function latestSessionForCwd(cwd: string): SessionListEntry | null {
  const hinted = readPointer()[cwdKey(cwd)];
  if (hinted && isValidSessionId(hinted.id)) {
    const path = sessionPathFor(hinted.id);
    const session = existsSync(path) ? readSessionFile(path) : null;
    if (session?.meta && sameCwd(session.meta.cwd, cwd)) return describe(path, session);
  }
  const target = resolve(cwd);
  for (const entry of listSessions()) {
    if (sameCwd(entry.cwd, target)) return entry;
  }
  return null;
}

function sameCwd(a: string, b: string): boolean {
  if (!a || !b) return false;
  const norm = (p: string): string => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const left = norm(a);
  const right = norm(b);
  // Case-insensitive on Windows only: two paths differing in case are the same
  // directory there and two different directories on Linux.
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

interface LockPayload {
  pid: number;
  host: string;
  startedAt: number;
  uuid: string;
}

export interface SessionLockHandle {
  path: string;
  release(): void;
}

export interface SessionLockOptions {
  now?: () => number;
  /** Injected for tests; defaults to `process.kill(pid, 0)` liveness probing. */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * `ESRCH` means gone. `EPERM` means the process EXISTS but belongs to another
 * user - treating that as dead would let one user steal another's lock, so it
 * reports ALIVE. Verbatim from `update/install-lock.ts`, which took it from
 * `skills/lock.ts`.
 */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readLock(path: string): LockPayload | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as LockPayload;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'number') return null;
    if (typeof parsed.uuid !== 'string' || typeof parsed.host !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** `wx` - atomic exclusive create. THIS SINGLE CALL IS THE MUTUAL EXCLUSION. */
function tryCreate(path: string, payload: LockPayload): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch {
    return false;
  }
  try {
    writeSync(fd, JSON.stringify(payload));
  } finally {
    // Closed IMMEDIATELY: on Windows an open handle blocks `unlink`, so holding
    // it would make our own release fail and turn every lock into a ten-minute
    // stall for the next process.
    closeSync(fd);
  }
  return true;
}

/**
 * Take the lock for one `--session-id`, or report that someone else has it.
 * NEVER SLEEPS, NEVER THROWS (D-11).
 *
 * ONE ATTEMPT, NO RETRY. A second process exits 2 with `session_busy` rather
 * than waiting, because a wrapper that wants a queue can build one and a CLI
 * that blocks for an unbounded time on a lock it cannot show the user is a hang.
 * `skills/lock.ts::acquireRootLock` busy-waits through `Atomics.wait` and
 * throws, which is right for a human who typed `aragon skills install` and wrong
 * for a background caller; `update/install-lock.ts` already made that split.
 */
export function tryAcquireSessionLock(
  id: string,
  opts: SessionLockOptions = {},
): SessionLockHandle | null {
  const now = opts.now ?? Date.now;
  const isAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  ensureDir();
  // Same boundary as `sessionPathFor` - a lock is a file in this directory too,
  // and an id that may not name a session may not name its lock either.
  const path = join(getSessionsDir(), `${assertSessionId(id)}.lock`);
  const payload: LockPayload = {
    pid: process.pid,
    host: hostname(),
    startedAt: now(),
    uuid: randomUUID(),
  };

  if (tryCreate(path, payload)) return makeHandle(path, payload);

  const holder = readLock(path);
  // An unreadable lock is indistinguishable from one mid-creation (create and
  // write are two syscalls), so it is NOT evidence of abandonment and is left
  // alone. The TTL still collects it eventually.
  if (holder === null) return null;
  const stale =
    now() - holder.startedAt > SESSION_LOCK_TTL_MS ||
    (holder.host === payload.host && !isAlive(holder.pid));
  if (!stale) return null;

  try {
    unlinkSync(path);
  } catch {
    // Another process won the race to clean it up. Not ours this tick.
    return null;
  }
  return tryCreate(path, payload) ? makeHandle(path, payload) : null;
}

function makeHandle(path: string, payload: LockPayload): SessionLockHandle {
  let released = false;
  return {
    path,
    release(): void {
      if (released) return;
      released = true;
      try {
        const holder = readLock(path);
        // THE UUID CHECK IS NOT DEFENSIVE PADDING. If this process was judged
        // stale and preempted, an unconditional `unlink` here would delete the
        // NEW holder's lock and open a second concurrency window - the classic
        // file-lock bug, and one that only shows up under exactly the contention
        // the lock exists to handle.
        if (holder?.uuid !== payload.uuid) return;
        unlinkSync(path);
      } catch {
        // A failed release costs at most one TTL of waiting for the next
        // process. Letting it throw would end a SUCCESSFUL run in an error.
      }
    },
  };
}
