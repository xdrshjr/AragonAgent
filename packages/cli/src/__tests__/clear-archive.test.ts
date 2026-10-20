/**
 * Archiving the conversation a `/clear` is about to drop
 * (clear-command-context-reset T-12..T-15b).
 *
 * ISOLATION: `ARAGON_HOME` is pointed at a throwaway directory BEFORE the modules
 * under test are imported, because `config/app-paths.ts` resolves the sessions
 * directory once at load time. Every assertion below then reads the real file the
 * real writer produced.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const TMP = mkdtempSync(join(tmpdir(), 'aragon-cli-clear-archive-'));
process.env.ARAGON_HOME = TMP;

const { archiveClearedConversation, CLEAR_ARCHIVE_LIMITS } = await import(
  '../session/clear-archive.js'
);
const { loadSession } = await import('../session/persist.js');
const { sessionsDir } = await import('../session/store.js');

type ClearedArchiveInput = import('../session/clear-archive.js').ClearedArchiveInput;

const CLEARED_DIR = join(sessionsDir(), 'cleared');
const MODEL = { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' };

function input(overrides: Partial<ClearedArchiveInput> = {}): ClearedArchiveInput {
  return {
    model: MODEL,
    messages: [{ role: 'user', content: 'what did I ask?' }],
    entries: [{ id: 'e1', kind: 'user', text: 'what did I ask?' }],
    todos: [{ content: 'Ship the fix', activeForm: 'Shipping the fix', status: 'in_progress' }],
    ...overrides,
  };
}

function archiveFiles(): string[] {
  try {
    return readdirSync(CLEARED_DIR).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

beforeEach(() => {
  rmSync(CLEARED_DIR, { recursive: true, force: true });
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('archiveClearedConversation', () => {
  it('writes a readable session under <sessions>/cleared, with no meta', async () => {
    const path = archiveClearedConversation(input());

    expect(path).toBeTruthy();
    expect(path!.startsWith(CLEARED_DIR)).toBe(true);
    const saved = loadSession(path!);
    expect(saved.messages).toHaveLength(1);
    expect(saved.entries).toEqual([{ id: 'e1', kind: 'user', text: 'what did I ask?' }]);
    // NO `meta` (I-6): that marker is what `sessions list` / `prune` scope
    // themselves by, and an archive is not a managed session. With it, a
    // maintenance command would start deleting the user's cleared conversations.
    expect(saved.meta).toBeUndefined();
    const raw = JSON.parse(readFileSync(path!, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw)).not.toContain('meta');
  });

  it('names the file from the clock and the pid, and keeps it resume-addressable', () => {
    const path = archiveClearedConversation(input())!;
    const file = path.replace(/\\/g, '/').split('/').pop()!;
    expect(file).toMatch(/^cleared-\d{8}-\d{6}-\d+\.json$/);
  });

  it('skips an empty conversation', () => {
    // Clearing a conversation that has no history must not litter the directory:
    // an empty archive would also push a real one out of the retention window.
    expect(archiveClearedConversation(input({ messages: [] }))).toBeNull();
    expect(archiveFiles()).toEqual([]);
  });

  it('keeps the newest archives only', () => {
    mkdirSync(CLEARED_DIR, { recursive: true });
    const seeded: string[] = [];
    const base = 1_700_000_000_000;
    for (let i = 0; i < CLEAR_ARCHIVE_LIMITS.maxArchives + 1; i += 1) {
      const path = join(CLEARED_DIR, `cleared-20200101-0000${String(i).padStart(2, '0')}-1.json`);
      writeFileSync(path, '{}');
      // Distinct mtimes: retention sorts on them, and every file here is written
      // within the same millisecond otherwise.
      utimesSync(path, new Date(base + i * 1000), new Date(base + i * 1000));
      seeded.push(path);
    }

    expect(archiveClearedConversation(input())).toBeTruthy();

    const survivors = archiveFiles();
    expect(survivors).toHaveLength(CLEAR_ARCHIVE_LIMITS.maxArchives);
    // The two oldest seeded files are the ones that went; the new archive stays.
    expect(survivors).not.toContain(seeded[0]!.replace(/\\/g, '/').split('/').pop());
    expect(survivors).not.toContain(seeded[1]!.replace(/\\/g, '/').split('/').pop());
  });

  it('never throws when the directory cannot be created', () => {
    // A file where the directory should be is the cheapest reliable reproduction
    // of an unwritable target, and it exercises the same catch: a disk problem
    // must never be able to stop a user from starting a new conversation (I-5).
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(CLEARED_DIR, 'blocked');

    expect(archiveClearedConversation(input())).toBeNull();

    rmSync(CLEARED_DIR, { force: true });
  });

  it('retries without the compaction identity when it fails validation', () => {
    // THE CASE THAT MATTERS MOST (P1-6 / C-8): an INTERRUPTED conversation is
    // exactly the one most likely to carry a stale identity, and it is also the
    // one a user most wants back. Losing it to an accessory field would break the
    // only promise this module makes.
    const path = archiveClearedConversation(input({
      compactionIdentity: {
        version: 1, anchorIndex: 0, blockIndex: 1, generation: 0, prefixSha256: 'nope',
      },
    }));

    expect(path).toBeTruthy();
    const saved = loadSession(path!);
    expect(saved.messages).toHaveLength(1);
    const raw = JSON.parse(readFileSync(path!, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(raw)).not.toContain('compactionIdentity');
  });

  it('writes the file at the path it reports', () => {
    const path = archiveClearedConversation(input())!;
    expect(statSync(path).isFile()).toBe(true);
  });
});
