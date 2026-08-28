/**
 * The id-keyed session store (cli-integration-surface section 3.4 / AC-7 /
 * AC-8 / AC-9 / AC-10 / AC-23 / AC-29 / AC-30).
 *
 * TWO OF THESE CASES GUARD AGAINST UNRECOVERABLE DAMAGE rather than against a
 * wrong answer, and they are the reason this file exists at all:
 *
 *   - `--session-id ../../etc/passwd` must not become a write primitive under
 *     the user's home directory (R-7).
 *   - `sessions prune` shares a directory with the TUI's `/save`, so it must
 *     leave a file with no `meta` alone (R-16). That one is a maintenance
 *     command the docs recommend, deleting conversations a human saved by hand.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import {
  isValidSessionId,
  latestSessionForCwd,
  listSessions,
  pruneSessions,
  readSessionFile,
  removeSession,
  resolveSessionRef,
  resumedSessionId,
  sessionPathFor,
  sessionsDir,
  SESSION_LOCK_TTL_MS,
  tryAcquireSessionLock,
  writeSession,
} from '../session/store.js';
import { loadSession } from '../session/persist.js';
import { runExec } from '../exec/index.js';
import type { SessionMeta } from '../session/persist.js';

const CWD = join(tmpdir(), 'aragon-session-cwd');

function meta(id: string, at: number, cwd = CWD): SessionMeta {
  return {
    id,
    cwd,
    createdAt: at,
    updatedAt: at,
    turns: 2,
    cli: '0.6.0',
    provider: 'anthropic',
    model: 'm',
    usage: { inputTokens: 10, outputTokens: 20 },
  };
}

function write(id: string, at: number, cwd = CWD): void {
  writeSession({
    id,
    session: {
      model: { providerId: 'anthropic', modelId: 'm' },
      messages: [{ role: 'user', content: 'hi' }] as never,
      entries: [],
      todos: [],
    },
    meta: meta(id, at, cwd),
  });
}

beforeEach(() => {
  mkdirSync(CWD, { recursive: true });
  rmSync(sessionsDir(), { recursive: true, force: true });
});

afterEach(() => {
  // The VITEST branch of `app-paths.ts` guarantees this is a per-pid path under
  // `os.tmpdir()`, never the developer's real home (test-isolation rule 3).
  rmSync(sessionsDir(), { recursive: true, force: true });
});

describe('AC-8 / R-7: id validation is a security boundary', () => {
  it('refuses traversal, separators, a leading dot, emptiness and over-length', () => {
    for (const id of ['../../etc/passwd', '..', 'a/b', 'a\\b', '', '.hidden', 'x'.repeat(65)]) {
      expect(isValidSessionId(id)).toBe(false);
    }
  });

  it('accepts the ordinary shapes a wrapper mints', () => {
    for (const id of ['ci-42', 'run_7.attempt-2', 'a', 'x'.repeat(64)]) {
      expect(isValidSessionId(id)).toBe(true);
    }
  });

  it('is a pure function, tested independently of the filesystem', () => {
    // A traversal id must be rejected BEFORE anything touches the disk, which is
    // only checkable if the check does not need the disk.
    expect(isValidSessionId('../evil')).toBe(false);
    expect(existsSync(join(sessionsDir(), '..', 'evil.json'))).toBe(false);
  });
});

describe('AC-7 / AC-30: round trip', () => {
  it('writes a resumable session with meta, and reloads its messages', () => {
    write('ci-1', 1000);
    const loaded = readSessionFile(sessionPathFor('ci-1'));
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.meta?.id).toBe('ci-1');
    expect(loaded?.meta?.turns).toBe(2);
  });

  it('AC-30: `entries` is [] and the file still loads in the TUI path', () => {
    // THE DOCUMENTED D-14 OUTCOME, pinned so it cannot regress into an unnoticed
    // one: `loadSession` validates only array-ness, so `[]` passes and a resumed
    // session shows full model memory with a blank transcript.
    write('ci-2', 1000);
    const session = loadSession(sessionPathFor('ci-2'));
    expect(session.entries).toEqual([]);
    expect(session.messages).toHaveLength(1);
    expect(session.version).toBe(1);
  });

  it('resolves --resume by id and by path, and reports absence', () => {
    write('ci-3', 1000);
    expect(resolveSessionRef('ci-3', CWD)).toBe(sessionPathFor('ci-3'));
    expect(resolveSessionRef(sessionPathFor('ci-3'), CWD)).toBe(sessionPathFor('ci-3'));
    expect(resolveSessionRef('nope', CWD)).toBeNull();
    expect(resolveSessionRef('../../etc/passwd', CWD)).toBeNull();
  });

  it('removes by id', () => {
    write('ci-4', 1000);
    expect(removeSession('ci-4')).toBe(true);
    expect(removeSession('ci-4')).toBe(false);
  });
});

describe('AC-9: --continue falls back to a directory scan', () => {
  it('resolves the newest session for the cwd', () => {
    write('old', 1000);
    write('new', 2000);
    expect(latestSessionForCwd(CWD)?.id).toBe('new');
  });

  it('still resolves after the pointer file is deleted', () => {
    // THE POINTER IS A CACHE AND IS DOCUMENTED AS ONE: a desync self-heals
    // instead of stranding the user, which is what makes it safe to keep a
    // denormalised index at all (R-9).
    write('old', 1000);
    write('new', 2000);
    rmSync(join(sessionsDir(), '.last.json'), { force: true });
    expect(latestSessionForCwd(CWD)?.id).toBe('new');
  });

  it('still resolves when the pointer names a file that is gone', () => {
    write('new', 2000);
    removeSession('new');
    write('other', 1500);
    expect(latestSessionForCwd(CWD)?.id).toBe('other');
  });

  it('returns null for a cwd nothing ran in', () => {
    write('new', 2000);
    expect(latestSessionForCwd(join(tmpdir(), 'aragon-elsewhere'))).toBeNull();
  });
});

describe('AC-23 / R-16: `/save` files are neither listed nor pruned', () => {
  function writeForeign(name: string): string {
    // Exactly what the TUI's `/save <name>` produces: no `meta`.
    const path = join(sessionsDir(), `${name}.json`);
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          version: 1,
          savedAt: 500,
          model: { providerId: 'anthropic', modelId: 'm' },
          messages: [],
          entries: [],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    return path;
  }

  it('list hides them unless --all is given', () => {
    write('exec-one', 1000);
    writeForeign('my-notes');
    expect(listSessions().map((s) => s.id)).toEqual(['exec-one']);
    expect(listSessions({ all: true }).map((s) => s.id).sort()).toEqual(['exec-one', 'my-notes']);
  });

  it('prune leaves them on disk', () => {
    write('exec-one', 1000);
    const foreign = writeForeign('my-notes');
    pruneSessions({ olderThanDays: 0, now: () => 10_000_000 });
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(sessionPathFor('exec-one'))).toBe(false);
  });

  it('prune --all opts in, and reports what it touched', () => {
    write('exec-one', 1000);
    const foreign = writeForeign('my-notes');
    const doomed = pruneSessions({ olderThanDays: 0, all: true, now: () => 10_000_000 });
    expect(doomed.map((d) => d.id).sort()).toEqual(['exec-one', 'my-notes']);
    expect(existsSync(foreign)).toBe(false);
  });

  it('AC-23: --dry-run deletes nothing', () => {
    write('exec-one', 1000);
    const doomed = pruneSessions({ olderThanDays: 0, dryRun: true, now: () => 10_000_000 });
    expect(doomed.map((d) => d.id)).toEqual(['exec-one']);
    expect(existsSync(sessionPathFor('exec-one'))).toBe(true);
  });

  it('never lists the pointer file or a lock', () => {
    write('exec-one', 1000);
    const handle = tryAcquireSessionLock('exec-one');
    expect(listSessions({ all: true }).map((s) => s.id)).toEqual(['exec-one']);
    handle?.release();
  });

  it('list is sorted by updatedAt, descending', () => {
    write('a', 1000);
    write('b', 3000);
    write('c', 2000);
    expect(listSessions().map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('AC-10 / AC-29: the lock', () => {
  it('AC-10: a second acquire is refused while the first holds it', () => {
    const first = tryAcquireSessionLock('busy');
    expect(first).not.toBeNull();
    expect(tryAcquireSessionLock('busy')).toBeNull();
    first?.release();
    // And the first is unaffected: after release the id is free again.
    const third = tryAcquireSessionLock('busy');
    expect(third).not.toBeNull();
    third?.release();
  });

  it('AC-29: a lock whose pid is DEAD is reclaimed', () => {
    // Without the liveness probe, a CI job killed mid-run wedges its
    // `--session-id` for the whole TTL and every retry returns `session_busy` -
    // a hang wearing an exit code, in the one environment this feature is for.
    const first = tryAcquireSessionLock('dead');
    expect(first).not.toBeNull();
    const reclaimed = tryAcquireSessionLock('dead', { isProcessAlive: () => false });
    expect(reclaimed).not.toBeNull();
    reclaimed?.release();
  });

  it('AC-29: a lock whose pid is ALIVE is not', () => {
    const first = tryAcquireSessionLock('alive');
    expect(first).not.toBeNull();
    expect(tryAcquireSessionLock('alive', { isProcessAlive: () => true })).toBeNull();
    first?.release();
  });

  it('AC-29: release is refused when the on-disk uuid is not ours', () => {
    // If this process was judged stale and preempted, an unconditional `unlink`
    // would delete the NEW holder's lock and open a second concurrency window -
    // the classic file-lock bug, visible only under the contention the lock
    // exists to handle.
    const first = tryAcquireSessionLock('stolen');
    expect(first).not.toBeNull();
    const successor = tryAcquireSessionLock('stolen', { isProcessAlive: () => false });
    expect(successor).not.toBeNull();
    first?.release();
    expect(existsSync(join(sessionsDir(), 'stolen.lock'))).toBe(true);
    successor?.release();
    expect(existsSync(join(sessionsDir(), 'stolen.lock'))).toBe(false);
  });

  it('reclaims a lock older than the TTL', () => {
    const first = tryAcquireSessionLock('stale', { now: () => 0 });
    expect(first).not.toBeNull();
    const later = tryAcquireSessionLock('stale', {
      now: () => SESSION_LOCK_TTL_MS + 1,
      // Alive, so the TTL is the only thing that can reclaim it.
      isProcessAlive: () => true,
    });
    expect(later).not.toBeNull();
    later?.release();
  });

  it('writes the payload the recovery policy needs', () => {
    const handle = tryAcquireSessionLock('payload');
    const parsed = JSON.parse(readFileSync(join(sessionsDir(), 'payload.lock'), 'utf-8')) as {
      pid: number;
      host: string;
      startedAt: number;
      uuid: string;
    };
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.host).toBe('string');
    expect(typeof parsed.uuid).toBe('string');
    handle?.release();
  });
});

/**
 * R-7, THE OTHER HALF: an id that did not arrive through `--session-id`.
 *
 * AC-8 pins `--session-id`, which `resolveExecOptions` validates before anything
 * touches the disk. It is not the only way a caller-supplied string reaches
 * `sessionPathFor`: `--resume <id|path>` derives the id from the RESUMED FILE,
 * `sessions rm` / `sessions show` take it straight from argv, and a session file
 * can carry any `meta.id` at all. Each of those is the same write primitive the
 * validated flag is not allowed to be, so the boundary belongs at the one
 * function that turns a string into a path rather than at each caller.
 */
describe('R-7 (second boundary): ids that did not come from --session-id', () => {
  it('sessionPathFor refuses a traversal id instead of joining it', () => {
    for (const id of ['../evil', 'a/b', 'a\\b', '', '.last']) {
      expect(() => sessionPathFor(id)).toThrow(/session id/i);
    }
  });

  it('removeSession cannot delete a file outside the sessions directory', () => {
    const victim = join(CWD, 'not-a-session.json');
    writeFileSync(victim, '{}', 'utf-8');
    // `sessions rm` is documented to accept "any file IN THE DIRECTORY, because
    // the user named it" - not any file anywhere.
    expect(removeSession(`../aragon-session-cwd/not-a-session`)).toBe(false);
    expect(existsSync(victim)).toBe(true);
    rmSync(victim, { force: true });
  });

  it('a lock is never created outside the sessions directory', () => {
    expect(() => tryAcquireSessionLock('../escaped')).toThrow(/session id/i);
    expect(existsSync(join(sessionsDir(), '..', 'escaped.lock'))).toBe(false);
  });

  it('resumedSessionId prefers meta.id, then the basename, then mints one', () => {
    const base = { version: 1, savedAt: 0, model: {}, messages: [], entries: [] } as never;
    // An exec-written file names itself, and that is what keeps a `--resume`
    // round trip landing back on the same file.
    expect(resumedSessionId(sessionPathFor('ci-7'), { ...(base as object), meta: meta('ci-7', 1) } as never)).toBe('ci-7');
    // A TUI `/save` carries no meta, so the FILENAME is the id - which is what
    // makes `--resume <path>` update the file it resumed instead of inventing a
    // sibling.
    expect(resumedSessionId(join(sessionsDir(), 'hand-saved.json'), base)).toBe('hand-saved');
    // Neither is usable: mint rather than build a path out of the leftovers.
    const minted = resumedSessionId(join(CWD, '..', 'weird name!.json'), base);
    expect(isValidSessionId(minted)).toBe(true);
  });

  it('a hostile meta.id cannot redirect the write', () => {
    const base = { version: 1, savedAt: 0, model: {}, messages: [], entries: [] } as never;
    const hostile = { ...(base as object), meta: { ...meta('x', 1), id: '../../escaped' } } as never;
    expect(resumedSessionId(sessionPathFor('innocent'), hostile)).toBe('innocent');
  });

  /**
   * THE MECHANISM, NOT THE OUTCOME. The four cases above prove the guard works;
   * this one proves `planSession` goes through it. Without the wiring the id is
   * the PATH the caller typed, and the run does not merely write to the wrong
   * place - `tryAcquireSessionLock` fails to create a lock under a directory
   * that does not exist, which `runExec` reports as `session_busy`. So the
   * documented `/save` -> `exec --resume <path>` interop (README Limits 3)
   * exits 2 on its first turn.
   */
  it('AC-7 (path form): --resume <path> resumes and saves inside the sessions dir', async () => {
    const handSaved = join(CWD, 'hand-saved.json');
    writeFileSync(
      handSaved,
      JSON.stringify({
        version: 1,
        savedAt: 1,
        model: { providerId: 'anthropic', modelId: 'm' },
        messages: [{ role: 'user', content: 'from the TUI' }],
        entries: [],
      }),
      'utf-8',
    );
    const stub = {
      preflight: () => ({ ok: true }),
      subscribe: () => () => {},
      getModelInfo: () => ({ cost: { input: 0, output: 0 } }),
      getTodoSnapshot: () => null,
      getTodoConfig: () => ({ followThrough: 'notify' as const }),
      getConfig: () => ({ provider: 'anthropic', model: 'm', baseUrl: undefined }),
      getCwd: () => CWD,
      getMessages: () => [{ role: 'user', content: 'from the TUI' }],
      replaceMessages: () => {},
      restoreTodos: () => {},
      listTools: () => [],
      isPricedModel: () => false,
      abort: () => {},
      dispose: () => {},
      prompt: async () => {},
    };
    let stdout = '';
    const code = await runExec({}, { outputFormat: 'json', resume: handSaved }, 'next', {
      version: '0.6.0',
      makeController: () => stub as never,
      stdout: { write: (c: string) => ((stdout += c), true) } as never,
      stderr: { write: () => true } as never,
    });

    expect(code).toBe(0);
    // The basename became the id, so the write landed in the sessions directory
    // rather than beside the file the caller pointed at.
    expect(JSON.parse(stdout).sessionId).toBe('hand-saved');
    expect(existsSync(sessionPathFor('hand-saved'))).toBe(true);
    expect(existsSync(join(CWD, 'hand-saved.json.json'))).toBe(false);
    rmSync(handSaved, { force: true });
  });
});
