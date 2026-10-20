/**
 * Startup session resolution (tui-session-id-resume 7.1 T-15..T-21, T-39, T-43).
 *
 * THE PARENT-FILE CASE IS THE ONE THAT MATTERS (T-16 / I-3). "A branch does not
 * affect the session it branched from" is a claim about BYTES, so the test
 * compares the parent's full contents and `mtimeMs` before and after, and checks
 * that the `--continue` pointer was not created or moved.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Message } from '@aragon-agent/core';
import type { Entry } from '../agent/reducer.js';
import { saveSession } from '../session/persist.js';
import { sessionPathFor, sessionsDir } from '../session/store.js';
import {
  applyRestoredSession,
  resolveStartupSession,
  rotateToChildOf,
  type SessionRestorePort,
} from '../session/startup-session.js';

const CWD = join(tmpdir(), 'aragon-startup-cwd');
const MODEL = { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' };

const MESSAGES: Message[] = [
  { role: 'user', content: 'rename the column' },
  { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
];

const ENTRIES: Entry[] = [{ id: 'e1', kind: 'user', text: 'rename the column' }];

/** Write a parent session exactly where `--resume <id>` looks for it. */
function writeParent(id = 'a4k2m9'): string {
  const path = sessionPathFor(id);
  saveSession(path, {
    model: MODEL,
    messages: MESSAGES,
    entries: ENTRIES,
    todos: [{ content: 'ship it', activeForm: 'shipping it', status: 'pending' }],
  });
  return path;
}

/** A restore port that records the order of its calls. */
function recordingPort(): SessionRestorePort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    replaceMessages: () => calls.push('replaceMessages'),
    restoreTodos: () => calls.push('restoreTodos'),
    setModel: () => calls.push('setModel'),
  };
}

beforeEach(() => {
  mkdirSync(CWD, { recursive: true });
  rmSync(sessionsDir(), { recursive: true, force: true });
  mkdirSync(sessionsDir(), { recursive: true });
});

afterEach(() => {
  rmSync(sessionsDir(), { recursive: true, force: true });
});

describe('T-15 / T-17 / D-5 / D-8: resuming', () => {
  it('resumes an existing session as a new branch', () => {
    writeParent();
    const result = resolveStartupSession({ resume: 'a4k2m9', cwd: CWD });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.identity.kind).toBe('branch');
    expect(result.identity.parentId).toBe('a4k2m9');
    expect(result.identity.id).toMatch(/^a4k2m9-[a-z0-9]{4}$/);
    expect(result.identity.pinned).toBeFalsy();
    // The transcript comes from the file, so a resumed tab is complete on frame 1.
    expect(result.initialEntries).toEqual(ENTRIES);
    // And the branch tells the user what just happened, including the sentence
    // that makes `--resume` safe to reach for (D-13).
    expect(result.notice).toBe(
      `Resumed a4k2m9 as a new branch: session ${result.identity.id}. ` +
        'The session you branched from is unchanged.',
    );
  });

  it('accepts a path spelling as well as an id (R-8)', () => {
    const path = writeParent();
    const result = resolveStartupSession({ resume: path, cwd: CWD });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    // The parent identity comes from the FILE NAME, so the two spellings agree.
    expect(result.identity.parentId).toBe('a4k2m9');
  });

  it('refuses an absent id with the documented message', () => {
    const result = resolveStartupSession({ resume: 'nope42', cwd: CWD });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('No session "nope42"');
    expect(result.message).toContain('sessions list --all');
  });

  it('refuses an absent path with the OTHER documented message', () => {
    const result = resolveStartupSession({ resume: './missing.json', cwd: CWD });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('No session file at "./missing.json"');
    expect(result.message).toContain('aragon sessions path');
  });

  it('names the way out when the file exists but cannot be read', () => {
    // A real corruption rather than the old 0-byte placeholder: D-23 makes the
    // placeholder legal, so anything unreadable now means genuine damage.
    const path = sessionPathFor('a4k2m9');
    writeFileSync(path, '{ not json');
    const result = resolveStartupSession({ resume: 'a4k2m9', cwd: CWD });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('exists but could not be read');
    expect(result.message).toContain('aragon sessions rm a4k2m9 --yes');
  });
});

describe('T-16 / I-3: the parent is never written', () => {
  it('leaves the parent file byte-identical', () => {
    const path = writeParent();
    const before = readFileSync(path);
    const beforeMtime = statSync(path).mtimeMs;
    const pointer = join(sessionsDir(), '.last.json');
    const pointerBefore = existsSync(pointer) ? readFileSync(pointer) : null;

    const result = resolveStartupSession({ resume: 'a4k2m9', cwd: CWD });
    expect(result.ok).toBe(true);

    expect(readFileSync(path).equals(before)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(beforeMtime);
    expect(existsSync(pointer) ? readFileSync(pointer) : null).toEqual(pointerBefore);
  });

  it('derives a rotation parent from the file name, not its metadata', () => {
    const path = writeParent();
    const rotated = rotateToChildOf(path);
    expect(rotated?.parentId).toBe('a4k2m9');
    expect(rotated?.id).toMatch(/^a4k2m9-[a-z0-9]{4}$/);
    // A hand-named file has no lineage to claim: the new id is minted outright.
    const hand = join(CWD, 'hand-saved.json');
    saveSession(hand, { model: MODEL, messages: MESSAGES, entries: [], todos: [] });
    const minted = rotateToChildOf(hand);
    expect(minted?.id).toMatch(/^[a-z0-9]{6}$/);
    // AND IT DOES NOT CLAIM A PARENT IT DOES NOT HAVE (§5.1: "no branchOf").
    // A `/save` export or a `/clear` archive was never a session id, so naming it
    // as one would put a non-id in `meta.branchOf` and a false lineage in the
    // resume notice.
    expect(minted?.parentId).toBeUndefined();
    expect(minted?.kind).toBe('fresh');
  });

  it('resumes a hand-saved file without inventing a parent', () => {
    const hand = join(CWD, 'hand-saved.json');
    saveSession(hand, { model: MODEL, messages: MESSAGES, entries: ENTRIES, todos: [] });
    const result = resolveStartupSession({ resume: hand, cwd: CWD });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    // The context still comes across in full - only the LINEAGE is withheld.
    expect(result.initialEntries).toEqual(ENTRIES);
    expect(result.identity.parentId).toBeUndefined();
    expect(result.identity.kind).toBe('fresh');
    expect(result.identity.id).toMatch(/^[a-z0-9]{6}$/);
    expect(result.notice).toBeUndefined();

    // `--save` on the same file names the branch and says what it is; the parent
    // is still not a session id, so it is still not recorded.
    const named = resolveStartupSession({ resume: hand, saveAs: 'try2', cwd: CWD });
    if (!named.ok) throw new Error(named.message);
    expect(named.identity).toMatchObject({ id: 'try2', kind: 'named', pinned: true });
    expect(named.identity.parentId).toBeUndefined();
    expect(named.notice).toContain('aragon --resume try2');
  });
});

describe('T-18 / T-19 / T-43 / D-6 / D-7: `--save`', () => {
  it('names a fresh session and pins it', () => {
    const result = resolveStartupSession({ saveAs: 'myfix', cwd: CWD });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.identity).toMatchObject({ id: 'myfix', kind: 'named', pinned: true });
    expect(result.notice).toContain('aragon --resume myfix');
    expect(existsSync(sessionPathFor('myfix'))).toBe(true);
  });

  it('refuses to overwrite an existing id named by --save', () => {
    const path = writeParent('taken');
    const before = statSync(path).mtimeMs;
    const result = resolveStartupSession({ saveAs: 'taken', cwd: CWD });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('Session "taken" already exists');
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it('refuses --save on the id being resumed', () => {
    writeParent();
    const result = resolveStartupSession({ resume: 'a4k2m9', saveAs: 'a4k2m9', cwd: CWD });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('names the session you are resuming');
  });

  it('refuses --save on the id being resumed even when spelled as a path', () => {
    const path = writeParent();
    const result = resolveStartupSession({ resume: path, saveAs: 'a4k2m9', cwd: CWD });
    expect(result.ok).toBe(false);
    // Compared by ID, not by the text the user typed (D-7).
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('names the session you are resuming');
  });

  it('refuses a --save value that is not an id', () => {
    for (const value of ['./notes.json', 'has space', '../escape']) {
      const result = resolveStartupSession({ saveAs: value, cwd: CWD });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain('--save takes an id');
      // NOTHING WAS CREATED, AND NOT JUST UNDER THE NAME WE THOUGHT OF: the whole
      // directory is still empty, so a value that escapes to another folder or
      // to a different suffix cannot slip past two spot checks.
      expect(readdirSync(sessionsDir())).toEqual([]);
      expect(existsSync(join(CWD, 'notes.json'))).toBe(false);
    }
  });

  it('names the directory when the id is free but the file cannot be written', () => {
    // A READ-ONLY HOME IS NOT A NAME COLLISION. Reporting `already exists` for a
    // directory that refuses writes sends the user to `--resume <id>`, which then
    // reports that nothing is there - two wrong answers to one problem.
    rmSync(sessionsDir(), { recursive: true, force: true });
    writeFileSync(sessionsDir(), 'not a directory');
    const result = resolveStartupSession({ saveAs: 'myfix', cwd: CWD });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('Could not create session "myfix"');
    expect(result.message).toContain(sessionsDir());
    expect(result.message).not.toContain('already exists');
  });

  it('branches into a user-named id', () => {
    writeParent();
    const result = resolveStartupSession({ resume: 'a4k2m9', saveAs: 'try2', cwd: CWD });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.identity).toMatchObject({ id: 'try2', kind: 'branch', pinned: true });
    expect(result.identity.parentId).toBe('a4k2m9');
  });
});

describe('T-20 / D-9: the restore is one shared implementation', () => {
  it('applies messages, todos, identity and model exactly once', () => {
    writeParent();
    const result = resolveStartupSession({ resume: 'a4k2m9', cwd: CWD });
    if (!result.ok) throw new Error(result.message);
    const port = recordingPort();
    result.apply(port);
    expect(port.calls).toEqual(['replaceMessages', 'restoreTodos', 'setModel']);
  });

  it('does not override an explicit --model', () => {
    writeParent();
    const result = resolveStartupSession({ resume: 'a4k2m9', cwd: CWD, explicitModel: true });
    if (!result.ok) throw new Error(result.message);
    const port = recordingPort();
    result.apply(port);
    // The user said what they wanted on this command line, which is more recent
    // than whatever the file recorded.
    expect(port.calls).toEqual(['replaceMessages', 'restoreTodos']);
  });

  it('is the same function the slash command calls', () => {
    const port = recordingPort();
    applyRestoredSession(port, {
      version: 1,
      savedAt: 0,
      messages: MESSAGES,
      entries: [],
    });
    expect(port.calls).toEqual(['replaceMessages', 'restoreTodos']);
  });
});

describe('T-21 / D-10: the branch does not adopt the parent spend', () => {
  it('does not adopt the parent spend', () => {
    writeParent();
    const result = resolveStartupSession({ resume: 'a4k2m9', cwd: CWD });
    if (!result.ok) throw new Error(result.message);
    // EXACTLY THREE FIELDS, by full equality rather than by key count: the
    // resolution carries no spend at all. `usageTotal` belongs to the App, is
    // reset on every id change (AC-9 / AC-19), and `meta.usage` is never read back
    // - so there is nowhere for the parent's cost to leak in from, and a future
    // field named `usage` would fail here instead of quietly appearing.
    expect(result.identity).toEqual({ id: result.identity.id, kind: 'branch', parentId: 'a4k2m9' });
  });
});

describe('T-39 / AC-14: the two --resume flags stay apart', () => {
  const root = readFileSync(new URL('../cli.tsx', import.meta.url), 'utf8');
  const exec = readFileSync(new URL('../exec/cli-commands.ts', import.meta.url), 'utf8');

  it('declares the root flags, with the exec flag still its own', () => {
    // STRUCTURAL, NOT A HELP-TEXT PARSE (the design's instruction): a wording
    // change must not turn this red, and a DELETED flag must.
    expect(root).toContain("'--resume <id|path>'");
    expect(root).toContain("'--save <id>'");
    expect(exec).toContain("'--resume <id|path>'");
    // The root declarations live in `buildProgram`, which `exec` does not touch:
    // commander does not inherit parent options, so both can exist.
    expect(root).not.toContain("command('exec");
  });
});

describe('a fresh launch', () => {
  it('mints an id, writes nothing but the reservation, and says nothing', () => {
    const result = resolveStartupSession({ cwd: CWD });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.identity.kind).toBe('fresh');
    expect(result.identity.id).toMatch(/^[a-z0-9]{6}$/);
    expect(result.notice).toBeUndefined();
    expect(result.initialEntries).toEqual([]);
    // The reservation IS the file, and it is a legal empty session (D-23).
    expect(existsSync(sessionPathFor(result.identity.id))).toBe(true);
  });
});
