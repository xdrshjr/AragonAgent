/**
 * Archive the conversation a `/clear` is about to destroy
 * (clear-command-context-reset §3.8 / D-5 / I-5).
 *
 * ASCII ONLY: `src/session/**` is inside `glyphs.test.ts::inScope`.
 *
 * WHY THIS EXISTS AT ALL: a command whose whole job is to destroy context is a
 * command a user will eventually fire by accident, one keystroke from `/cwd`. The
 * difference between "I lost an hour of work" and "I resumed it" is one file, and
 * `saveSession()` already knows how to write it.
 *
 * WHY THIS IS NOT `session/store.ts::writeSession()`: that function MOVES THE
 * `--continue` POINTER and writes `meta`. An archive is not a session you continue;
 * it is a record you resume BY PATH. Writing `meta` would also make the file look
 * `aragon exec`-managed to `sessions list` / `prune`, which is the scoping rule
 * `persist.ts` records at the top of `SessionMeta` - so a maintenance command would
 * start deleting the user's cleared conversations.
 *
 * ISOLATION IS TWO DEEP (I-6 / P2-4). The directory is the first fence:
 * `listSessions` / `pruneSessions` / `latestSessionForCwd` read `sessionsDir()`
 * non-recursively and skip anything not ending in `.json` (`store.ts`), so a
 * SUBDIRECTORY name is invisible to all three by construction. Omitting `meta` is
 * the second fence, for the day someone makes that listing recursive or gives
 * `--all` a wider meaning.
 */

import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import type { Message, ModelRef } from '@aragon-agent/core';
import type { Entry } from '../agent/reducer.js';
import type { TodoItem } from '../todo/types.js';
import type { CompactionIdentity } from '../compaction/memory-identity.js';
import { getLogger } from '../logging/logger.js';
import { saveSession } from './persist.js';
import { sessionsDir } from './store.js';

/** Everything the archive writes. `entries` is supplied by the command layer. */
export interface ClearedArchiveInput {
  model: ModelRef;
  messages: Message[];
  compactionIdentity?: CompactionIdentity;
  /** The screen transcript, which lives only in `ViewState` (P0-1). */
  entries: Entry[];
  todos: TodoItem[];
}

/** Bounded retention: the newest N cleared conversations survive. */
export const CLEAR_ARCHIVE_LIMITS = { maxArchives: 20 } as const;

/** `<sessions>/cleared` - a subdirectory, which is the first isolation fence. */
const CLEARED_DIR_NAME = 'cleared';

/** Every archive's filename starts with this, which is what `prune` selects on. */
const ARCHIVE_PREFIX = 'cleared-';

/**
 * Best-effort archive of the conversation being cleared.
 *
 * @returns the absolute path of the written file, or `null` when there was
 * nothing to save (an empty conversation) or the write failed. NEVER THROWS:
 * a full disk must not be able to stop a user from starting a new conversation
 * (I-5), and a caller that had to wrap this in `try` would eventually forget.
 */
export function archiveClearedConversation(input: ClearedArchiveInput): string | null {
  // Clearing an empty conversation produces no file. Without this, every
  // `/clear` on a fresh session would litter the directory with empty archives
  // and push a real one out of the retention window.
  if (input.messages.length === 0) return null;
  const dir = join(sessionsDir(), CLEARED_DIR_NAME);
  const path = join(dir, `${archiveId(new Date())}.json`);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    getLogger().debug('agent', 'clear_archive_failed', { reason: reasonOf(err) });
    return null;
  }
  // DEGRADE AND RETRY (P1-6 / C-8). `saveSession` VALIDATES the compaction
  // identity and THROWS on a damaged or stale one, and an interrupted
  // conversation - the one a user most wants back - is exactly the one most
  // likely to carry a stale identity. Losing a whole conversation to an
  // accessory field would break the only promise this module makes, so the
  // second attempt drops it: `messages` is what makes the archive recoverable,
  // the identity only lets the NEXT compaction reuse a prefix.
  //
  // The retry runs ONLY when there is an identity to drop. A disk that refused
  // the first write will refuse an identical second one, so retrying without one
  // would just double the log line and the wait without changing the outcome.
  const wrote = writeArchive(path, input, true)
    || (input.compactionIdentity !== undefined && writeArchive(path, input, false));
  if (!wrote) return null;
  pruneArchives(dir);
  return path;
}

/**
 * One write attempt. `withIdentity` is the only difference between the first and
 * the degraded second attempt, which is why it is a parameter rather than a
 * duplicated body.
 */
function writeArchive(path: string, input: ClearedArchiveInput, withIdentity: boolean): boolean {
  const identity = withIdentity ? input.compactionIdentity : undefined;
  try {
    saveSession(path, {
      model: input.model,
      messages: input.messages,
      ...(identity ? { compactionIdentity: identity } : {}),
      entries: input.entries,
      todos: input.todos,
    });
    return true;
  } catch (err) {
    getLogger().debug('agent', 'clear_archive_write_failed', {
      withIdentity, reason: reasonOf(err),
    });
    return false;
  }
}

/**
 * Deterministic, collision-free id (P2-3).
 *
 * `cleared-<yyyyMMdd>-<HHmmss>-<pid>` is ASCII, matches `isValidSessionId`
 * (`[A-Za-z0-9][A-Za-z0-9._-]*`), and is legible enough to type after
 * `/resume `. The pid removes cross-process collisions; within one process a
 * second `cleared-` file in the same second is unreachable because the FIRST
 * clear leaves an empty conversation and `archiveClearedConversation` returns
 * early on that. So no `-2`/`-3` suffix ladder is needed, and none is here.
 */
function archiveId(at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`;
  const clock = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `${ARCHIVE_PREFIX}${day}-${clock}-${process.pid}`;
}

/**
 * Keep the newest `maxArchives` files; delete the rest.
 *
 * A sweep, not a scheduled job: retention that runs on the write path cannot be
 * forgotten, and the failure mode of a missed sweep is bounded disk usage rather
 * than unbounded. Every error here is swallowed on purpose - pruning is
 * housekeeping and must never be able to fail a clear that already succeeded.
 */
function pruneArchives(dir: string): void {
  const survivors: { path: string; modified: number }[] = [];
  for (const name of safeReaddir(dir)) {
    if (!name.startsWith(ARCHIVE_PREFIX) || !name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      survivors.push({ path, modified: statSync(path).mtimeMs });
    } catch {
      // A file that vanished between listing and stat is already deleted.
    }
  }
  survivors.sort((a, b) => b.modified - a.modified);
  for (const doomed of survivors.slice(CLEAR_ARCHIVE_LIMITS.maxArchives)) {
    try {
      unlinkSync(doomed.path);
    } catch (err) {
      getLogger().debug('agent', 'clear_archive_prune_failed', { reason: reasonOf(err) });
    }
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
