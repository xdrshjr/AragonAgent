/**
 * Session identity: minting, branching, deriving, and reserving
 * (tui-session-id-resume §3.5 / D-1 / D-5 / D-23).
 *
 * ASCII ONLY - `src/session/**` is inside `glyphs.test.ts::inScope`.
 *
 * ONE AUTHORITY FOR "WHAT IS A SESSION CALLED". `store.ts` already owns the
 * SYNTAX (`SESSION_ID_RE`) and the path (`sessionPathFor`); this module owns the
 * generator and the branch rule, and it produces ids that pass that syntax by
 * construction rather than by a second regex nobody re-checks.
 *
 * BRANCHING NEVER REUSES THE PARENT ID (D-5 / I-3). A `--resume` always derives
 * a NEW id, so two processes can never take turns overwriting one file: the
 * parent keeps writing its own id, the branch writes its own. That is the whole
 * technical content of "a branch must not affect the session it branched from".
 */

import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModelRef } from '@aragon-agent/core';
import { SESSION_ID_LIMITS } from './limits.js';
import { basenameId, sessionPathFor } from './store.js';

/**
 * 31 characters: the ten digits and the lowercase alphabet MINUS `0 o 1 l i`.
 *
 * Those five are the pairs a human misreads when copying an id out of the
 * bottom-right corner of a terminal, and copying an id by eye is the one
 * irreducible failure mode this feature has (D-14 exists to remove it, and this
 * alphabet removes most of the rest).
 */
export const SESSION_ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

/** A generated id: 6 characters, optionally with the 4-character branch suffix. */
const GENERATED_ID_RE = /^([a-z0-9]{6})(?:-([a-z0-9]{4}))?$/;

/** One character from the alphabet. `random` is injected for deterministic tests. */
function pick(random: () => number): string {
  // `Math.min` because a stubbed generator may legitimately return 1.
  const index = Math.min(
    SESSION_ID_ALPHABET.length - 1,
    Math.floor(Math.abs(random()) * SESSION_ID_ALPHABET.length),
  );
  return SESSION_ID_ALPHABET[index] as string;
}

function randomChars(count: number, random: () => number): string {
  let out = '';
  for (let i = 0; i < count; i += 1) out += pick(random);
  return out;
}

/** A fresh 6-character id. Satisfies `SESSION_ID_RE` by construction (D-1). */
export function createSessionId(random: () => number = Math.random): string {
  return randomChars(SESSION_ID_LIMITS.idLength, random);
}

/**
 * The child id for `parentId`: 6-character root plus `-` plus 4 characters.
 *
 * THE ROOT DOES NOT GROW. `a4k2m9` and `a4k2m9-x7f2` both branch to
 * `a4k2m9-<new>`, so a chain of branches keeps a name that still fits the
 * status bar and still points at the conversation it came from.
 */
export function branchSessionId(parentId: string, random: () => number = Math.random): string {
  const root = GENERATED_ID_RE.exec(parentId)?.[1];
  if (!root) return createSessionId(random);
  const suffix = randomChars(SESSION_ID_LIMITS.suffixLength, random);
  return `${root}-${suffix}`;
}

/** Whether `id` is a shape this CLI mints (as opposed to a hand-chosen name). */
export function isGeneratedSessionId(id: string): boolean {
  return GENERATED_ID_RE.test(id);
}

/**
 * The next id for a session LOADED FROM `loadedPath`, or `null` when the file
 * name is not a generated id.
 *
 * THE INPUT IS A PATH, NOT AN ID, AND THE PARENT'S IDENTITY COMES FROM THE FILE
 * NAME (D-5 / R-8). `meta.id` lives inside the file, and a file is input - a
 * hand-written `meta.id` must not be able to name where this process writes.
 * `null` means "this was a `/save` export or an archive": the caller mints a
 * fresh id and the new file has no `branchOf`.
 */
export function derivedChildId(
  loadedPath: string,
  random: () => number = Math.random,
): string | null {
  const base = basenameId(loadedPath);
  return isGeneratedSessionId(base) ? branchSessionId(base, random) : null;
}

/**
 * Claim `id` with an atomic `wx` create, writing a READABLE EMPTY SESSION into
 * it (D-23 / R-3).
 *
 * `wx` IS THE MUTUAL EXCLUSION and stays that way: `existsSync` followed by a
 * write has a window in which two processes both see "absent". What changed in
 * v2 is the CONTENT. A 0-byte placeholder is unparseable, so `loadSession()`
 * throws a raw `SyntaxError` on it, `listSessions` silently skips it, and
 * `--save` refuses the name forever - a file the user can neither see nor
 * resume. A legal empty `SavedSession` fixes all three at once: it loads, it
 * lists, and `sessions rm` can delete it.
 *
 * NO `meta` IS WRITTEN, deliberately: "has `meta`" stays equivalent to "at least
 * one checkpoint has been written", which is the predicate `sessions list` /
 * `prune` are built on. `model` is written only when the caller has one - it is
 * optional in the format, and the startup path resolves an identity BEFORE the
 * controller exists, so a fabricated model would be a lie on disk for a field
 * nothing reads back.
 */
export function reserveSessionId(
  id: string,
  opts: { model?: ModelRef; pathFor?: (id: string) => string } = {},
): boolean {
  const path = (opts.pathFor ?? sessionPathFor)(id);
  const payload = {
    version: 1,
    savedAt: Date.now(),
    ...(opts.model ? { model: opts.model } : {}),
    messages: [],
    entries: [],
  };
  let fd: number;
  try {
    // THE DIRECTORY FIRST, and inside the same `try`: on a fresh machine
    // `sessions/` does not exist yet, and a reservation that silently answered
    // "name taken" because of a missing parent would send the caller into a
    // pointless retry loop. A parent that is a FILE fails here, which is the
    // honest answer.
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, 'wx');
  } catch {
    // EEXIST is the ordinary answer to "someone already holds this name", and a
    // missing directory is the ordinary answer on a fresh machine. Both mean
    // "this id is not available", which is all the caller can act on.
    return false;
  }
  try {
    writeSync(fd, `${JSON.stringify(payload, null, 2)}\n`);
  } catch {
    // A half-written placeholder is exactly the unreadable file D-23 exists to
    // rule out, so the failure is undone rather than left behind.
    closeSync(fd);
    unlinkQuietly(path);
    return false;
  }
  // Closed IMMEDIATELY: an open handle keeps Windows from replacing the file
  // when the first checkpoint lands (the same reason `store.ts` closes its lock
  // handle at once).
  closeSync(fd);
  return true;
}

/** Best effort: a cleanup failure must not turn "id unavailable" into a throw. */
function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Nothing to clean up, or someone else already did.
  }
}
