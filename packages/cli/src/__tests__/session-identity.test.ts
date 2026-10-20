/**
 * Session identity: generation, branching, derivation and the `wx` reservation
 * (tui-session-id-resume 7.1 T-1..T-5, T-41).
 *
 * THE RESERVATION CASE IS A DATA-LOSS GUARD, not a formatting check. A 0-byte
 * placeholder - what `wx` alone produces - is unreadable to `loadSession`, which
 * makes the file invisible to `sessions list` while `--save` refuses that name
 * forever: an id the user can neither see, resume, nor reuse (D-23 / R-3).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SESSION_ID_ALPHABET,
  branchSessionId,
  createSessionId,
  derivedChildId,
  isGeneratedSessionId,
  reserveSessionId,
} from '../session/identity.js';
import { loadSession } from '../session/persist.js';
import {
  isValidSessionId,
  listSessions,
  readSessionFile,
  removeSession,
  sessionPathFor,
  sessionsDir,
} from '../session/store.js';

beforeEach(() => {
  rmSync(sessionsDir(), { recursive: true, force: true });
});

afterEach(() => {
  // The VITEST branch of `app-paths.ts` guarantees this is a per-pid path under
  // `os.tmpdir()`, never the developer's real home.
  rmSync(sessionsDir(), { recursive: true, force: true });
});

describe('T-1 / D-1: the generated id', () => {
  it('creates a 6-character id from the unambiguous alphabet', () => {
    const id = createSessionId();
    expect(id).toHaveLength(6);
    for (const character of id) expect(SESSION_ID_ALPHABET).toContain(character);
    expect(id).not.toMatch(/[01ilo]/);
    // THE WHOLE POINT OF THE ALPHABET: an id the user copies by eye must also be
    // an id the store accepts, or the copy produces a command that cannot run.
    expect(isValidSessionId(id)).toBe(true);
  });

  it('T-4: never returns an id outside SESSION_ID_RE', () => {
    for (let i = 0; i < 500; i += 1) {
      const id = createSessionId();
      expect(id).toMatch(/^[a-z0-9]{6}$/);
      expect(isValidSessionId(id)).toBe(true);
    }
  });

  it('T-4b: a stubbed generator of 1 stays inside the alphabet', () => {
    expect(createSessionId(() => 1)).toBe('zzzzzz');
    expect(createSessionId(() => 0)).toBe('222222');
  });
});

describe('T-2 / D-5: branching from the root', () => {
  it('branches a generated id from its root', () => {
    expect(branchSessionId('a4k2m9')).toMatch(/^a4k2m9-[a-z0-9]{4}$/);
    // THE ROOT DOES NOT GROW: a branch of a branch is still 11 characters, so a
    // chain keeps fitting the status bar and keeps naming the conversation it
    // came from.
    expect(branchSessionId('a4k2m9-x7f2')).toMatch(/^a4k2m9-[a-z0-9]{4}$/);
    expect(branchSessionId('a4k2m9')).toHaveLength(11);
  });

  it('mints a fresh id for a name it did not generate', () => {
    expect(branchSessionId('myfix')).toMatch(/^[a-z0-9]{6}$/);
  });
});

describe('T-3 / D-5: a hand-saved name is not a lineage', () => {
  it('does not pretend a hand-saved name is a session lineage', () => {
    const cleared = join(tmpdir(), 'cleared-20261008-120000-1234.json');
    expect(isGeneratedSessionId('cleared-20261008-120000-1234')).toBe(false);
    expect(derivedChildId(cleared)).toBeNull();
  });

  it('derives from the FILE NAME, never from the contents', () => {
    // 8.3 spells out why: a file's `meta.id` is input, so it must not name where
    // this process writes. The basename is the only identity the caller holds.
    expect(derivedChildId(join(tmpdir(), 'a4k2m9.json'))).toMatch(/^a4k2m9-[a-z0-9]{4}$/);
    expect(derivedChildId('a4k2m9-x7f2.json')).toMatch(/^a4k2m9-[a-z0-9]{4}$/);
  });
});

describe('T-5 / T-41 / D-23: the reservation', () => {
  it('reserves an id exactly once', () => {
    expect(reserveSessionId('a4k2m9')).toBe(true);
    expect(reserveSessionId('a4k2m9')).toBe(false);
    const files = readdirSync(sessionsDir()).filter((name) => name.startsWith('a4k2m9'));
    expect(files).toEqual(['a4k2m9.json']);
  });

  it('reserves an id as a READABLE empty session', () => {
    expect(reserveSessionId('a4k2m9')).toBe(true);
    const path = sessionPathFor('a4k2m9');
    // THE ASSERTION THAT MAKES D-23 WORTH ITS OWN DECISION: this call is what
    // throws a raw `SyntaxError` on a 0-byte placeholder.
    const saved = loadSession(path);
    expect(saved.messages).toEqual([]);
    expect(saved.entries).toEqual([]);
    // No `meta` yet, so "has meta" still means "a checkpoint landed here".
    expect(saved.meta).toBeUndefined();
    expect(readSessionFile(path)).not.toBeNull();
    expect(listSessions({ all: true }).map((entry) => entry.id)).toContain('a4k2m9');
    expect(removeSession('a4k2m9')).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('reports an unavailable name when the directory refuses the write', () => {
    // A path whose PARENT is a REGULAR FILE: creating the directory fails on
    // every platform, which is the honest stand-in for "the write did not
    // happen". The important half is that it is a `false` return and not an
    // exception on the path whose only answer is "try another id".
    const parent = join(tmpdir(), 'aragon-reserve-parent.json');
    // A previous run of this very test may have created a DIRECTORY here, so the
    // fixture is reset rather than assumed.
    rmSync(parent, { recursive: true, force: true });
    writeFileSync(parent, 'not a directory');
    try {
      const refused = reserveSessionId('a4k2m9', { pathFor: () => join(parent, 'a4k2m9.json') });
      expect(refused).toBe(false);
      expect(existsSync(join(parent, 'a4k2m9.json'))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
