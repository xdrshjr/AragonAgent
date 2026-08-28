/**
 * Migration guard for the argon-agent -> aragon-agent rename (spec §7.2).
 *
 * Everything runs against an in-memory `MigrationFsPort`. The point of the port
 * is exactly this: the real code path relocates the user's config and skills
 * directories, and a test that exercised it for real would be one typo away
 * from moving the developer's own.
 */

import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import {
  migrateLegacyState,
  formatMigrationNotice,
  legacyAppPaths,
  type MigrationFsPort,
} from '../config/migrate-legacy-state.js';
// Step ① moves data BETWEEN env-paths trees; `~/.aragon-agent` is step ②'s
// business (see `migrate-home.test.ts`). These are therefore the env-paths
// roots, which no non-migration module may touch any more.
import { getHomeRoot, legacyEnvPaths } from '../config/app-paths.js';
import { migrateToHome } from '../config/migrate-home.js';

interface FakeFsOptions {
  /** Directories/files that exist up front. */
  present?: string[];
  /** Throw this from `renameSync` for paths that match. */
  renameFails?: { match: RegExp; error: Error };
  /** Throw this from `readdirSync`. */
  readdirFails?: Error;
  /** Throw this from `writeFileSync`, whatever the path. */
  writeFails?: Error;
}

interface FakeFs extends MigrationFsPort {
  entries: Set<string>;
  renames: Array<[string, string]>;
  copies: Array<[string, string]>;
  removed: string[];
  writes: Array<[string, string]>;
}

function createFakeFs(options: FakeFsOptions = {}): FakeFs {
  const entries = new Set(options.present ?? []);
  const renames: Array<[string, string]> = [];
  const copies: Array<[string, string]> = [];
  const removed: string[] = [];
  const writes: Array<[string, string]> = [];

  /** Children of `dir`, one level deep, derived from the flat entry set. */
  const childrenOf = (dir: string): string[] => {
    const prefix = `${dir}\\`.replace(/[\\/]+$/, '\\');
    const out = new Set<string>();
    for (const e of entries) {
      const normalised = e.replace(/\//g, '\\');
      if (!normalised.startsWith(prefix)) continue;
      const rest = normalised.slice(prefix.length);
      if (rest.length === 0) continue;
      out.add(rest.split('\\')[0]);
    }
    return [...out];
  };

  /** Rename `from` and everything beneath it. */
  const moveSubtree = (from: string, to: string): void => {
    for (const e of [...entries]) {
      if (e === from || e.startsWith(`${from}\\`) || e.startsWith(`${from}/`)) {
        entries.delete(e);
        entries.add(to + e.slice(from.length));
      }
    }
  };

  return {
    entries,
    renames,
    copies,
    removed,
    writes,

    existsSync: (path) => entries.has(path),
    mkdirSync: (path) => {
      entries.add(path);
    },
    renameSync: (from, to) => {
      if (options.renameFails && options.renameFails.match.test(from)) {
        throw options.renameFails.error;
      }
      renames.push([from, to]);
      moveSubtree(from, to);
    },
    cpSync: (from, to) => {
      copies.push([from, to]);
      for (const e of [...entries]) {
        if (e === from || e.startsWith(`${from}\\`) || e.startsWith(`${from}/`)) {
          entries.add(to + e.slice(from.length));
        }
      }
    },
    readdirSync: (path) => {
      if (options.readdirFails) throw options.readdirFails;
      return childrenOf(path);
    },
    rmSync: (path) => {
      entries.delete(path);
      removed.push(path);
    },
    writeFileSync: (path, data) => {
      if (options.writeFails) throw options.writeFails;
      // Model `node:fs`: writing into a directory that does not exist fails.
      // A port more permissive than the real thing makes the code under test
      // look safe on paths where it is not — which is exactly how the
      // breadcrumb step got to discard successful migrations unnoticed.
      if (!entries.has(dirname(path))) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
          code: 'ENOENT',
        });
      }
      entries.add(path);
      writes.push([path, data]);
    },
  };
}

const LEGACY_CONFIG = legacyAppPaths.config;
const LEGACY_DATA = legacyAppPaths.data;
const NEXT_CONFIG = legacyEnvPaths.config;
const NEXT_DATA = legacyEnvPaths.data;

describe('migrateLegacyState', () => {
  it('is a no-op when there is nothing to migrate', () => {
    const fs = createFakeFs();
    const result = migrateLegacyState(fs);

    expect(result).toEqual({ mode: 'none', movedRoots: [], manifestsRenamed: 0 });
    expect(fs.renames).toEqual([]);
    expect(fs.copies).toEqual([]);
    // A fresh install must not leave directories behind as a side effect.
    expect(fs.entries.size).toBe(0);
  });

  it('moves both legacy roots when the new ones are absent', () => {
    const fs = createFakeFs({
      present: [LEGACY_CONFIG, join(LEGACY_CONFIG, 'config.json'), LEGACY_DATA],
    });

    const result = migrateLegacyState(fs);

    expect(result.mode).toBe('renamed');
    expect(result.movedRoots).toEqual(['config', 'data']);
    expect(fs.entries.has(join(NEXT_CONFIG, 'config.json'))).toBe(true);
    expect(fs.entries.has(LEGACY_CONFIG)).toBe(false);
    expect(fs.entries.has(NEXT_DATA)).toBe(true);
    // Breadcrumb lands in the new config root.
    const breadcrumb = fs.writes.find(([p]) => p.endsWith('.migrated-from-argon-agent'));
    expect(breadcrumb).toBeDefined();
    expect(JSON.parse(breadcrumb![1]).mode).toBe('renamed');
  });

  it('does nothing when the new directory already exists', () => {
    // The idempotence key. Second launch, and the hand-made-directory case:
    // migrating here would overwrite state the user already has.
    const fs = createFakeFs({
      present: [LEGACY_CONFIG, LEGACY_DATA, NEXT_CONFIG, NEXT_DATA],
    });

    const result = migrateLegacyState(fs);

    expect(result.mode).toBe('none');
    expect(result.movedRoots).toEqual([]);
    expect(fs.renames).toEqual([]);
    expect(fs.entries.has(LEGACY_CONFIG)).toBe(true);
    expect(fs.entries.has(LEGACY_DATA)).toBe(true);
  });

  it('falls back to copying across volumes and keeps the legacy tree', () => {
    const exdev = Object.assign(new Error('EXDEV: cross-device link not permitted'), {
      code: 'EXDEV',
    });
    const fs = createFakeFs({
      present: [LEGACY_CONFIG, LEGACY_DATA],
      renameFails: { match: /argon-agent-nodejs/, error: exdev },
    });

    const result = migrateLegacyState(fs);

    expect(result.mode).toBe('copied');
    expect(fs.copies.length).toBe(2);
    // Losing the original to a partial copy is worse than not migrating.
    expect(fs.entries.has(LEGACY_CONFIG)).toBe(true);
    expect(fs.entries.has(NEXT_CONFIG)).toBe(true);
  });

  it('never throws when the legacy tree cannot be read', () => {
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const fs = createFakeFs({
      present: [LEGACY_DATA, join(NEXT_DATA, 'skills')],
      readdirFails: eacces,
    });

    const result = migrateLegacyState(fs);

    expect(result.mode).toBe('none');
    expect(result.error).toContain('EACCES');
  });

  it('renames skill manifests and drops the stale install lock', () => {
    const skills = join(NEXT_DATA, 'skills');
    const fs = createFakeFs({
      present: [
        LEGACY_DATA,
        join(LEGACY_DATA, 'skills'),
        join(LEGACY_DATA, 'skills', 'writing'),
        join(LEGACY_DATA, 'skills', 'writing', '.argon-skill.json'),
        join(LEGACY_DATA, 'skills', 'review'),
        join(LEGACY_DATA, 'skills', 'review', '.argon-skill.json'),
        join(LEGACY_DATA, 'skills', '.argon-skills.lock'),
      ],
    });

    const result = migrateLegacyState(fs);

    expect(result.manifestsRenamed).toBe(2);
    expect(fs.entries.has(join(skills, 'writing', '.aragon-skill.json'))).toBe(true);
    expect(fs.entries.has(join(skills, 'review', '.aragon-skill.json'))).toBe(true);
    expect(fs.entries.has(join(skills, 'writing', '.argon-skill.json'))).toBe(false);
    // A lock carried across versions only convinces the new build that some
    // other process is mid-install.
    expect(fs.entries.has(join(skills, '.argon-skills.lock'))).toBe(false);
    expect(fs.removed).toContain(join(skills, '.argon-skills.lock'));
  });

  it('still reports a successful migration when the breadcrumb cannot be written', () => {
    // The breadcrumb goes into the CONFIG root, but a migration that only moved
    // the DATA root leaves that root untouched — on Windows they are separate
    // trees. If the breadcrumb write is allowed to fail the whole call, a
    // migration that really did move the user's skills reports `mode: 'none'`,
    // no stderr notice is printed, and support is told the opposite of the
    // truth. The breadcrumb is a diagnostic, never a verdict.
    const fs = createFakeFs({
      present: [LEGACY_DATA],
      writeFails: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    });

    const result = migrateLegacyState(fs);

    expect(result.mode).toBe('renamed');
    expect(result.movedRoots).toEqual(['data']);
    expect(result.error).toBeUndefined();
    expect(fs.entries.has(NEXT_DATA)).toBe(true);
    expect(formatMigrationNotice(result)).toBe('migrated settings from argon-agent -> aragon-agent');
  });
});

describe('formatMigrationNotice', () => {
  it('says nothing when nothing moved', () => {
    expect(formatMigrationNotice({ mode: 'none', movedRoots: [], manifestsRenamed: 0 })).toBeNull();
  });

  it('reports the skill count only when there were skills', () => {
    expect(
      formatMigrationNotice({ mode: 'renamed', movedRoots: ['config'], manifestsRenamed: 0 }),
    ).toBe('migrated settings from argon-agent -> aragon-agent');
    expect(
      formatMigrationNotice({ mode: 'copied', movedRoots: ['data'], manifestsRenamed: 3 }),
    ).toBe('migrated settings from argon-agent -> aragon-agent (3 skills)');
  });
});

/**
 * The two migrations in sequence, which is how `main()` runs them.
 *
 * THE ORDER IS THE POINT. Run ② first and it finds the `aragon-agent`
 * env-paths tree empty and moves nothing; ① then relocates the 0.4.x data into
 * a directory no code reads any more. Per-artifact idempotence means `sessions`
 * and `skills` would still be picked up on the NEXT launch — but `config.json`
 * would not, because by then the user has re-entered their key and the target
 * exists. This case is the mechanical guard for that (R-1 / §8.1 case 10).
 */
describe('chain ① -> ② (env-paths brand rename, then home)', () => {
  const HOME = getHomeRoot();

  function chainFs() {
    return createFakeFs({
      present: [
        LEGACY_CONFIG,
        join(LEGACY_CONFIG, 'config.json'),
        LEGACY_DATA,
        join(LEGACY_DATA, 'sessions'),
        join(LEGACY_DATA, 'skills'),
      ],
    });
  }

  it('lands 0.4.x data in ~/.aragon-agent when run in the right order', () => {
    const fs = chainFs();

    migrateLegacyState(fs);
    const home = migrateToHome(fs);

    // ①'s own breadcrumb rides along, so support can still see both hops.
    expect(home.moved).toEqual([
      'config.json',
      'sessions',
      'skills',
      '.migrated-from-argon-agent',
    ]);
    expect(fs.entries.has(join(HOME, 'config.json'))).toBe(true);
    expect(fs.entries.has(join(HOME, 'sessions'))).toBe(true);
    expect(fs.entries.has(join(HOME, 'skills'))).toBe(true);
  });

  it('is a complete no-op on the second launch', () => {
    const fs = chainFs();
    migrateLegacyState(fs);
    migrateToHome(fs);

    fs.renames.length = 0;
    fs.copies.length = 0;
    expect(migrateLegacyState(fs).mode).toBe('none');
    expect(migrateToHome(fs)).toEqual({ mode: 'none', moved: [] });
    expect(fs.renames).toEqual([]);
    expect(fs.copies).toEqual([]);
  });

  it('strands config.json when the order is reversed', () => {
    // Not a wish for this behaviour — a demonstration of the cost, so nobody
    // "tidies" the two calls in `main()` into the other order.
    const fs = chainFs();

    migrateToHome(fs); // ② first: the aragon-agent env-paths tree is still empty
    migrateLegacyState(fs);

    expect(fs.entries.has(join(HOME, 'config.json'))).toBe(false);
    expect(fs.entries.has(join(NEXT_CONFIG, 'config.json'))).toBe(true);
  });
});
