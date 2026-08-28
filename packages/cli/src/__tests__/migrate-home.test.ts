/**
 * Migration guard for env-paths -> `~/.aragon-agent` (chain step ②).
 *
 * Everything runs against an in-memory port, for the reason the step-① guard
 * gives: the real code path relocates the user's config, sessions and skills,
 * and a test that exercised it for real would be one typo away from relocating
 * the developer's own.
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  formatHomeMigrationNotice,
  migrateToHome,
  type HomeMigrationFsPort,
} from '../config/migrate-home.js';
import { getHomeRoot, legacyEnvPaths } from '../config/app-paths.js';

interface FakeFsOptions {
  present?: string[];
  renameFails?: Error;
  writeFails?: Error;
  mkdirFails?: Error;
}

interface FakeFs extends HomeMigrationFsPort {
  entries: Set<string>;
  renames: Array<[string, string]>;
  copies: Array<[string, string]>;
  writes: Array<[string, string]>;
}

function createFakeFs(options: FakeFsOptions = {}): FakeFs {
  const entries = new Set(options.present ?? []);
  const renames: Array<[string, string]> = [];
  const copies: Array<[string, string]> = [];
  const writes: Array<[string, string]> = [];

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
    writes,

    existsSync: (path) => entries.has(path),
    mkdirSync: (path) => {
      if (options.mkdirFails) throw options.mkdirFails;
      entries.add(path);
    },
    renameSync: (from, to) => {
      if (options.renameFails) throw options.renameFails;
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
    writeFileSync: (path, data) => {
      if (options.writeFails) throw options.writeFails;
      entries.add(path);
      writes.push([path, data]);
    },
  };
}

const OLD_CONFIG = legacyEnvPaths.config;
const OLD_DATA = legacyEnvPaths.data;
const HOME = getHomeRoot();

const oldConfigFile = join(OLD_CONFIG, 'config.json');
const oldSessions = join(OLD_DATA, 'sessions');
const oldSkills = join(OLD_DATA, 'skills');
const oldUsage = join(OLD_DATA, 'skill-usage.json');

describe('migrateToHome', () => {
  it('is a no-op when there is nothing to migrate', () => {
    const fs = createFakeFs();
    const result = migrateToHome(fs);

    expect(result).toEqual({ mode: 'none', moved: [] });
    expect(fs.renames).toEqual([]);
    expect(fs.copies).toEqual([]);
    // A fresh install must not create directories as a side effect.
    expect(fs.entries.size).toBe(0);
  });

  it('moves every artifact it finds', () => {
    const fs = createFakeFs({
      present: [OLD_CONFIG, oldConfigFile, OLD_DATA, oldSessions, oldSkills, oldUsage],
    });

    const result = migrateToHome(fs);

    expect(result.moved).toEqual(['config.json', 'sessions', 'skills', 'skill-usage.json']);
    expect(fs.entries.has(join(HOME, 'config.json'))).toBe(true);
    expect(fs.entries.has(join(HOME, 'sessions'))).toBe(true);
    expect(fs.entries.has(join(HOME, 'skills'))).toBe(true);
    expect(fs.entries.has(join(HOME, 'skill-usage.json'))).toBe(true);
  });

  it('COPIES config.json and keeps the original, but moves the bulky artifacts', () => {
    // Keeping config.json makes reinstalling 0.5.0 a lossless action; sessions
    // and skills are large enough that a copy is not a rounding error.
    const fs = createFakeFs({ present: [OLD_CONFIG, oldConfigFile, OLD_DATA, oldSessions] });

    migrateToHome(fs);

    expect(fs.copies.some(([from]) => from === oldConfigFile)).toBe(true);
    expect(fs.entries.has(oldConfigFile)).toBe(true);
    expect(fs.renames.some(([from]) => from === oldSessions)).toBe(true);
    expect(fs.entries.has(oldSessions)).toBe(false);
  });

  it('never overwrites an artifact that is already at the destination', () => {
    // The per-artifact idempotence key: second launch, and the built-by-hand
    // case. Migrating here would destroy state the user already has.
    const fs = createFakeFs({
      present: [OLD_CONFIG, oldConfigFile, join(HOME, 'config.json'), OLD_DATA, oldSessions],
    });

    const result = migrateToHome(fs);

    expect(result.moved).toEqual(['sessions']);
    expect(fs.copies.some(([, to]) => to === join(HOME, 'config.json'))).toBe(false);
  });

  it('keys on the ARTIFACT, not on the home root existing', () => {
    // The logger creates `<home>/logs` and skills/usage.ts creates `<home>`
    // itself — possibly in this very process. Keying on the root would skip a
    // half-finished migration forever.
    const fs = createFakeFs({ present: [HOME, OLD_DATA, oldSkills] });

    const result = migrateToHome(fs);

    expect(result.moved).toEqual(['skills']);
  });

  it('falls back to copying across volumes and keeps the source', () => {
    // %APPDATA% and %LOCALAPPDATA% can be different volumes on Windows, so
    // EXDEV here is ordinary rather than exceptional.
    const exdev = Object.assign(new Error('EXDEV: cross-device link not permitted'), {
      code: 'EXDEV',
    });
    const fs = createFakeFs({ present: [OLD_DATA, oldSessions], renameFails: exdev });

    const result = migrateToHome(fs);

    expect(result.mode).toBe('copied');
    expect(fs.copies.some(([from]) => from === oldSessions)).toBe(true);
    // A half-written copy next to a deleted original is the one outcome worse
    // than not migrating at all.
    expect(fs.entries.has(oldSessions)).toBe(true);
  });

  it('reports `mixed` when one artifact is renamed and another copied', () => {
    const fs = createFakeFs({ present: [OLD_CONFIG, oldConfigFile, OLD_DATA, oldSessions] });
    expect(migrateToHome(fs).mode).toBe('mixed');
  });

  it('still reports what it moved when the breadcrumb cannot be written', () => {
    // Letting an ENOENT from the breadcrumb reach the outer catch would report
    // `mode: 'none'` for a migration that really did move the user's data —
    // telling support the exact opposite of what happened.
    const fs = createFakeFs({
      present: [OLD_DATA, oldSessions],
      writeFails: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    });

    const result = migrateToHome(fs);

    expect(result.moved).toEqual(['sessions']);
    expect(result.mode).toBe('renamed');
    expect(result.error).toBeUndefined();
  });

  it('writes a breadcrumb naming the previous locations', () => {
    const fs = createFakeFs({ present: [OLD_DATA, oldSessions] });
    migrateToHome(fs);

    const breadcrumb = fs.writes.find(([p]) => p.endsWith('.migrated-from-env-paths'));
    expect(breadcrumb).toBeDefined();
    const payload = JSON.parse(breadcrumb![1]) as { from: { config: string; data: string } };
    expect(payload.from.config).toBe(OLD_CONFIG);
    expect(payload.from.data).toBe(OLD_DATA);
  });

  it('carries the step-① breadcrumb across so support can still see it', () => {
    const fs = createFakeFs({
      present: [OLD_CONFIG, join(OLD_CONFIG, '.migrated-from-argon-agent')],
    });
    const result = migrateToHome(fs);
    expect(result.moved).toEqual(['.migrated-from-argon-agent']);
  });

  it('never throws, whatever the filesystem does', () => {
    const fs = createFakeFs({
      present: [OLD_DATA, oldSessions],
      mkdirFails: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    });

    let result: ReturnType<typeof migrateToHome> | undefined;
    expect(() => {
      result = migrateToHome(fs);
    }).not.toThrow();
    expect(result!.mode).toBe('none');
    expect(result!.error).toContain('EACCES');
  });

  it('is a complete no-op on the second run', () => {
    const fs = createFakeFs({
      present: [OLD_CONFIG, oldConfigFile, OLD_DATA, oldSessions, oldSkills, oldUsage],
    });
    migrateToHome(fs);

    fs.renames.length = 0;
    fs.copies.length = 0;
    const second = migrateToHome(fs);

    expect(second).toEqual({ mode: 'none', moved: [] });
    expect(fs.renames).toEqual([]);
    expect(fs.copies).toEqual([]);
  });
});

describe('formatHomeMigrationNotice', () => {
  it('says nothing when nothing happened', () => {
    expect(formatHomeMigrationNotice({ mode: 'none', moved: [] })).toBeNull();
  });

  it('is ASCII-only — it prints before any terminal capability probe', () => {
    const notice = formatHomeMigrationNotice({ mode: 'renamed', moved: ['sessions'] });
    expect(notice).toBeTruthy();
    // eslint-disable-next-line no-control-regex
    expect(notice!).not.toMatch(/[^\x00-\x7f]/);
    expect(notice!).toContain('sessions');
  });
});
