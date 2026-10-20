/**
 * Startup-time session resolution: `--resume <id|path>` and `--save <id>`
 * (tui-session-id-resume §3.8 / D-5..D-9 / D-20 / D-23).
 *
 * ASCII ONLY - `src/session/**` is inside `glyphs.test.ts::inScope`.
 *
 * ONE RESOLUTION, TWO CALLERS. The TUI (`runInteractive`) and the headless
 * one-shot (`runOneShot`) both come through here, and the in-TUI `/resume`
 * command shares `applyRestoredSession` with them, because two copies of "adopt
 * a saved conversation" is how `/clear` and `/reset` drifted apart once already.
 *
 * THIS MODULE DOES NO I/O BEYOND READING THE FILE AND CLAIMING THE NEW ID. It
 * builds no controller and renders nothing, so every rule below is testable as a
 * pure function: a caller gets either an identity plus an `apply` thunk, or one
 * message and exit code 2.
 *
 * THE PARENT IS NEVER WRITTEN (I-3). The id comes from the file NAME, the new id
 * is always derived, and the only write this module performs is the `wx` claim
 * of that new id - which is a different file by construction.
 */

import { existsSync } from 'node:fs';
import type { Message } from '@aragon-agent/core';
import type { Entry } from '../agent/reducer.js';
import type { TodoItem } from '../todo/types.js';
import type { CompactionIdentity } from '../compaction/memory-identity.js';
import { getSessionsDir } from '../config/app-paths.js';
import {
  branchSessionId,
  createSessionId,
  derivedChildId,
  isGeneratedSessionId,
  reserveSessionId,
} from './identity.js';
import { SESSION_ID_LIMITS } from './limits.js';
import { loadSession, type SavedSession } from './persist.js';
import {
  basenameId,
  isValidSessionId,
  looksLikeSessionPath,
  resolveSessionRef,
  sessionPathFor,
} from './store.js';

/** Who this process is, as the rest of the CLI sees it. */
export interface SessionIdentity {
  id: string;
  kind: 'fresh' | 'named' | 'branch';
  /** The id this one branched from; absent unless `kind === 'branch'`. */
  parentId?: string;
  /** `--save` / `/session pin`: `sessions prune` will not delete it. */
  pinned?: boolean;
}

export interface StartupSessionInput {
  /** `--resume <id|path>` - both spellings are legal (D-5 / R-8). */
  resume?: string;
  /** `--save <id>` - an ID, never a path (D-6). */
  saveAs?: string;
  cwd: string;
  /** True when the user named `--model` / `--provider` explicitly (D-9). */
  explicitModel?: boolean;
}

/**
 * The minimum controller surface the restore needs.
 *
 * THREE METHODS, and `getConfig` is deliberately not one of them: the three
 * calls below need nothing else, and a wider port only makes the startup path
 * look like it knows more about the controller than it does.
 */
export interface SessionRestorePort {
  replaceMessages(messages: Message[], identity?: CompactionIdentity): void;
  restoreTodos(items: TodoItem[]): void;
  setModel(providerId: string, modelId: string, baseUrl?: string): void;
}

export type StartupSessionResolution =
  | {
      ok: true;
      identity: SessionIdentity;
      initialEntries: Entry[];
      notice?: string;
      /** The file this session was branched from, if any. */
      saved?: SavedSession;
      apply(port: SessionRestorePort): void;
    }
  | { ok: false; exitCode: 2; message: string };

/**
 * Adopt a saved conversation. THE ONLY IMPLEMENTATION of the three calls
 * `/resume` makes; the slash command and both startup paths call it.
 *
 * `skipModel` exists because an explicit `--model` / `--provider` on this run
 * outranks the model recorded in the file: a user who says which model they want
 * has said it more recently than the file did.
 *
 * `clearAllQueues()` and the `restoreEntries` dispatch are NOT here and belong at
 * the call sites: the first is a no-op on the startup path (there are no queues
 * yet) and indispensable inside a live TUI, and the second is a VIEW action with
 * no controller to attach it to - the startup path seeds the reducer instead.
 */
export function applyRestoredSession(
  port: SessionRestorePort,
  saved: SavedSession,
  opts: { skipModel?: boolean } = {},
): void {
  port.replaceMessages(saved.messages, saved.compactionIdentity);
  // Absence clears the previous conversation's list, including old files.
  port.restoreTodos(saved.todos ?? []);
  if (!opts.skipModel && saved.model?.providerId && saved.model?.modelId) {
    port.setModel(saved.model.providerId, saved.model.modelId, saved.model.baseUrl);
  }
}

/**
 * Work out which session this process is, and what it starts from.
 *
 * FAILURE IS EXIT 2 WITH ONE COPYABLE SENTENCE, and it happens BEFORE any write
 * (the only write is the id claim, and it is last). Sources: a `--save` value
 * that is not an id (D-6), a `--save` id that is already taken (D-6), a `--save`
 * naming the id being resumed (D-7), and a `--resume` that is missing or
 * unreadable (D-8).
 */
export function resolveStartupSession(input: StartupSessionInput): StartupSessionResolution {
  const rawSaveAs = input.saveAs?.trim();
  if (rawSaveAs !== undefined && rawSaveAs.length > 0 && !isValidSessionId(rawSaveAs)) {
    return invalidSaveId(rawSaveAs);
  }
  const saveAs = rawSaveAs !== undefined && rawSaveAs.length > 0 ? rawSaveAs : undefined;
  const resume = input.resume?.trim();
  if (resume !== undefined && resume.length > 0) return resolveBranch(input, resume, saveAs);
  return resolveFresh(saveAs);
}

/** A brand new session: optionally named by `--save`, otherwise auto-minted. */
function resolveFresh(saveAs: string | undefined): StartupSessionResolution {
  if (saveAs !== undefined) {
    const fate = tryReserve(saveAs);
    if (fate === 'taken') return alreadyExists(saveAs);
    if (fate === 'unwritable') return unwritable(saveAs);
    return {
      ok: true,
      identity: { id: saveAs, kind: 'named', pinned: true },
      initialEntries: [],
      notice: `Session ${saveAs} (pinned). Resume it from any terminal: aragon --resume ${saveAs}`,
      apply: () => {},
    };
  }
  // A collision is not a failure for an auto-minted id: another process took the
  // name in the last few milliseconds, so minting again is the whole fix.
  for (let attempt = 0; attempt < SESSION_ID_LIMITS.reserveAttempts; attempt += 1) {
    const id = createSessionId();
    const fate = tryReserve(id);
    // Retrying cannot repair a directory that refuses writes, and burning the
    // remaining attempts only delays the same answer.
    if (fate === 'unwritable') return unwritable(id);
    if (fate === 'ok') {
      return { ok: true, identity: { id, kind: 'fresh' }, initialEntries: [], apply: () => {} };
    }
  }
  return {
    ok: false,
    exitCode: 2,
    message:
      `Could not allocate a session id after ${SESSION_ID_LIMITS.reserveAttempts} attempts. ` +
      `Try: aragon sessions prune --origin tui --yes  (sessions live in ${getSessionsDir()}).`,
  };
}

/** `--resume`: read the parent, derive a new id, claim it (D-5 / D-8). */
function resolveBranch(
  input: StartupSessionInput,
  reference: string,
  saveAs: string | undefined,
): StartupSessionResolution {
  const path = resolveSessionRef(reference, input.cwd);
  if (path === null) return notFound(reference);

  let saved: SavedSession;
  try {
    saved = loadSession(path);
  } catch (error) {
    // A file that exists but cannot be read is NOT the same absence: this third
    // message exists because a raw stack trace here is a user staring at a
    // puzzle, and the only way out of it is deleting the file (D-8 / R-3).
    const id = basenameId(path);
    const reason = error instanceof Error ? error.message : String(error);
    const next = isValidSessionId(id)
      ? `Delete it with: aragon sessions rm ${id} --yes`
      : 'Delete the file, or resume another one.';
    return {
      ok: false,
      exitCode: 2,
      message: `Session "${id}" exists but could not be read (${reason}). ${next}`,
    };
  }

  // D-7 compares IDS, not the text the user typed: `--resume ./x/a4k2m9.json
  // --save a4k2m9` is the same session (D-5 derives the parent from the file
  // NAME), so the path spelling must be refused identically.
  const loadedId = basenameId(path);
  if (saveAs !== undefined && saveAs === loadedId) {
    return {
      ok: false,
      exitCode: 2,
      message:
        `--save ${saveAs} names the session you are resuming. ` +
        'Pick a different id to branch into.',
    };
  }
  // LINEAGE ONLY EXISTS FOR A GENERATED NAME (D-5 / §5.1). A `/save` export, a
  // `/clear` archive and a user-chosen name all land in this directory under
  // names this CLI did not mint; recording one of those as `meta.branchOf` would
  // write a parent that is not a session, and announcing it would claim a
  // lineage that does not exist. `derivedChildId` already draws that line for the
  // NEW id; the recorded parent must be drawn on the same line.
  const parentId = isGeneratedSessionId(loadedId) ? loadedId : undefined;
  const derived = saveAs ?? derivedChildId(path);
  const claimed = claimBranchId(derived, {
    named: saveAs !== undefined,
    // A retry must keep the branch SHAPE: losing the `-xxxx` suffix on a
    // collision would drop the one thing on disk that says where this came from.
    mint: () => (parentId ? branchSessionId(parentId) : createSessionId()),
  });
  if (!claimed.ok) return claimed.resolution;

  const identity: SessionIdentity = {
    id: claimed.id,
    // Not a "branch" when the file it came from has no id of ours to name, and
    // not a "branch" that the `-p` notice should announce.
    kind: parentId !== undefined ? 'branch' : saveAs !== undefined ? 'named' : 'fresh',
    ...(parentId !== undefined ? { parentId } : {}),
    // Written only when TRUE, like `SessionMeta.pinned`: the field means "the
    // user asked for this name", and `pinned: false` would be a second spelling
    // of the same absence.
    ...(saveAs !== undefined ? { pinned: true as const } : {}),
  };
  const notice =
    parentId !== undefined
      ? `Resumed ${parentId} as a new branch: session ${claimed.id}. ` +
        'The session you branched from is unchanged.'
      : saveAs !== undefined
        ? `Session ${claimed.id} (pinned). ` +
          `Resume it from any terminal: aragon --resume ${claimed.id}`
        : undefined;
  return {
    ok: true,
    identity,
    initialEntries: saved.entries,
    ...(notice === undefined ? {} : { notice }),
    saved,
    apply: (port: SessionRestorePort) =>
      applyRestoredSession(port, saved, { skipModel: input.explicitModel === true }),
  };
}

/**
 * Claim the branch id, retrying only when it was auto-derived.
 *
 * A `--save` name that is taken is the user's decision to lose, so it is refused
 * (D-6); an auto-derived suffix colliding means nothing to anyone, so it is
 * re-minted - WITH THE SAME ROOT (`mint`), because the suffix is the disposable
 * half of a branch id and the root is the part that carries the lineage.
 */
function claimBranchId(
  derived: string | null,
  opts: { named: boolean; mint: () => string },
): { ok: true; id: string } | { ok: false; resolution: StartupSessionResolution } {
  if (derived !== null) {
    const fate = tryReserve(derived);
    if (fate === 'ok') return { ok: true, id: derived };
    if (fate === 'unwritable') return { ok: false, resolution: unwritable(derived) };
    if (opts.named) return { ok: false, resolution: alreadyExists(derived) };
  }
  for (let attempt = 0; attempt < SESSION_ID_LIMITS.reserveAttempts; attempt += 1) {
    const id = opts.mint();
    const fate = tryReserve(id);
    if (fate === 'ok') return { ok: true, id };
    if (fate === 'unwritable') return { ok: false, resolution: unwritable(id) };
  }
  return {
    ok: false,
    resolution: {
      ok: false,
      exitCode: 2,
      message:
        `Could not allocate a branch id after ${SESSION_ID_LIMITS.reserveAttempts} attempts.`,
    },
  };
}

/**
 * `reserveSessionId` answers "did I get this name"; the CALLER needs to know
 * "who refused, and what should I tell the user".
 *
 * A read-only (or full) session directory fails the reservation for every id
 * exactly like a collision does, and reporting that as `Session "myfix" already
 * exists` sends the user to `--resume myfix`, which then reports that nothing is
 * there. One `existsSync` between the two is enough to tell "somebody holds this
 * name" from "nothing can be written here at all".
 */
function tryReserve(id: string): 'ok' | 'taken' | 'unwritable' {
  if (reserveSessionId(id)) return 'ok';
  return existsSync(sessionPathFor(id)) ? 'taken' : 'unwritable';
}

/**
 * Move to a derived id after a `/resume` inside the TUI (D-15 / R-9).
 *
 * THE ROTATION IS NOT COSMETIC. `/resume` adopts another conversation, so the
 * next checkpoint would otherwise write THAT conversation into THIS id's file -
 * silently destroying the disk record the user was building. The id therefore
 * changes with the content, exactly as it does on a startup branch, and the
 * caller resets the spend in the same breath (D-10).
 *
 * The parent id comes from the FILE NAME, never from `meta.id` (D-5): a file's
 * contents are input.
 */
export function rotateToChildOf(loadedPath: string): SessionIdentity | undefined {
  // Same lineage rule as a startup branch: a name this CLI did not mint has no
  // id to record, so it records none (D-5 / §5.1).
  const loadedId = basenameId(loadedPath);
  const parentId = isGeneratedSessionId(loadedId) ? loadedId : undefined;
  const claimed = claimBranchId(derivedChildId(loadedPath), {
    named: false,
    mint: () => (parentId ? branchSessionId(parentId) : createSessionId()),
  });
  if (!claimed.ok) return undefined;
  return {
    id: claimed.id,
    kind: parentId !== undefined ? 'branch' : 'fresh',
    ...(parentId !== undefined ? { parentId } : {}),
  };
}

function invalidSaveId(value: string): StartupSessionResolution {
  return {
    ok: false,
    exitCode: 2,
    message:
      `Invalid session id "${value}". --save takes an id ` +
      '(letters, digits, ".", "_", "-"), not a path. ' +
      'Use /save inside the TUI to export to a file.',
  };
}

function alreadyExists(id: string): StartupSessionResolution {
  return {
    ok: false,
    exitCode: 2,
    message:
      `Session "${id}" already exists. ` +
      `Use --resume ${id} to continue it as a new branch, or pick a new id.`,
  };
}

/**
 * The id was free but the file could not be created: a read-only or full
 * directory. Naming the directory is the only actionable half of this sentence -
 * "already exists" (the answer a bare `false` used to produce) would send the
 * user to `--resume <id>`, which reports that nothing is there.
 */
function unwritable(id: string): StartupSessionResolution {
  return {
    ok: false,
    exitCode: 2,
    message:
      `Could not create session "${id}" in ${getSessionsDir()} ` +
      '(the directory is not writable).',
  };
}

/**
 * `--resume` found nothing. TWO SPELLINGS, TWO SENTENCES, because the next step
 * differs: an id is looked up in a directory, a path is looked at directly.
 */
function notFound(reference: string): StartupSessionResolution {
  // THE SAME PREDICATE THE LOOKUP USED (D-5 / R-8), not a second copy of it: two
  // copies would eventually disagree about one spelling and send the user to the
  // wrong next step (`sessions list --all` for a path, or `sessions path` for an
  // id).
  if (looksLikeSessionPath(reference)) {
    return {
      ok: false,
      exitCode: 2,
      message: `No session file at "${reference}". Try: aragon sessions path`,
    };
  }
  return {
    ok: false,
    exitCode: 2,
    message:
      `No session "${reference}". Try: aragon sessions list --all  ` +
      `(sessions live in ${getSessionsDir()}).`,
  };
}
