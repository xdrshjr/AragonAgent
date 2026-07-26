/**
 * AC-A13 — local usage counters (§9).
 *
 * The load-bearing assertion is the LAST describe block: `alwaysBlock()` must
 * not count. An always-on skill is re-injected on every single turn, so
 * counting it would pin it to the top of the ranking permanently and drown out
 * the only signal the ranking exists to carry — what someone deliberately
 * reached for. That bug would be invisible in review and invisible at run time;
 * it would just make the feature quietly useless.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const tmp = { root: '' };

vi.mock('../paths.js', async () => {
  const actual = await vi.importActual<typeof import('../paths.js')>('../paths.js');
  const data = (): string => join(tmp.root, 'data');
  const user = (): string => join(data(), 'skills');
  return {
    ...actual,
    getUserDataDir: data,
    getBundledSkillsDir: () => join(tmp.root, 'bundled'),
    getUserSkillsDir: user,
    getStagingDir: () => join(user(), '.staging'),
    getTrashDir: () => join(user(), '.staging', '.trash'),
    resolveSkillRoots: (cwd: string, projectDirs?: string[]) => [
      { dir: user(), scope: 'user' as const, writable: true },
      ...actual.resolveProjectSkillDirs(cwd, projectDirs),
    ],
  };
});

const usage = await import('../usage.js');
const { SkillService } = await import('../service.js');
const { createNodeSkillHost } = await import('../node-host.js');
const { cleanup, makeTmpDir, recordingGate, runtimeOptions, skillsConfig, writeSkill } =
  await import('./helpers.js');
import type { SkillsConfig } from '../../config/schema.js';

const usagePath = (): string => join(tmp.root, 'data', 'skill-usage.json');

function makeService(config: Partial<SkillsConfig> = {}) {
  return new SkillService({
    host: createNodeSkillHost(),
    getCwd: () => join(tmp.root, 'cwd'),
    config: skillsConfig(config),
    runtime: runtimeOptions(),
    approval: recordingGate({ canPrompt: false, approve: false }),
  });
}

beforeEach(() => {
  tmp.root = makeTmpDir('argon-usage-');
  mkdirSync(join(tmp.root, 'data', 'skills'), { recursive: true });
  mkdirSync(join(tmp.root, 'cwd'), { recursive: true });
  usage.resetUsageForTests();
});
afterEach(() => {
  usage.resetUsageForTests();
  cleanup(tmp.root);
});

describe('usage store — reading', () => {
  it('a missing file reads as an empty map, not an error', () => {
    expect(usage.loadUsage()).toEqual({});
  });

  it('corrupt JSON degrades to empty AND leaves the file alone', () => {
    writeFileSync(usagePath(), '{ this is not json', 'utf-8');
    expect(usage.loadUsage()).toEqual({});
    // Deleting a file the user may have been hand-editing would be a worse
    // trade than carrying on without the counters.
    expect(existsSync(usagePath())).toBe(true);
  });

  it('a future schema reads as empty rather than being misinterpreted', () => {
    writeFileSync(
      usagePath(),
      JSON.stringify({ schema: 99, skills: { a: { useCount: 5, lastUsedAt: 1 } } }),
      'utf-8',
    );
    expect(usage.loadUsage()).toEqual({});
  });

  it('drops individual malformed rows but keeps the valid ones', () => {
    writeFileSync(
      usagePath(),
      JSON.stringify({
        schema: 1,
        skills: {
          good: { useCount: 3, lastUsedAt: 111 },
          bad: { useCount: 'lots' },
          alsoBad: null,
        },
      }),
      'utf-8',
    );
    expect(usage.loadUsage()).toEqual({ good: { useCount: 3, lastUsedAt: 111 } });
  });
});

describe('usage store — writing', () => {
  it('records a use and persists it atomically on flush', () => {
    usage.recordUse('deploy-preview', 1000);
    usage.recordUse('deploy-preview', 2000);
    usage.flushUsage();

    const written = JSON.parse(readFileSync(usagePath(), 'utf-8'));
    expect(written.schema).toBe(1);
    expect(written.skills['deploy-preview']).toEqual({ useCount: 2, lastUsedAt: 2000 });
    // The tmp file used for the atomic rename must not survive.
    expect(existsSync(`${usagePath()}.tmp-${process.pid}`)).toBe(false);
  });

  it('stores ONLY name, count and timestamp — no other keys ever', () => {
    usage.recordUse('pdf-forms', 5000);
    usage.flushUsage();
    const written = JSON.parse(readFileSync(usagePath(), 'utf-8'));
    expect(Object.keys(written).sort()).toEqual(['schema', 'skills']);
    expect(Object.keys(written.skills['pdf-forms']).sort()).toEqual(['lastUsedAt', 'useCount']);
  });

  it('flush is a no-op when nothing changed', () => {
    usage.flushUsage();
    expect(existsSync(usagePath())).toBe(false);
  });

  it('an unwritable data directory does not throw', () => {
    usage.recordUse('x', 1);
    // Point the write at a path that cannot be a directory.
    writeFileSync(join(tmp.root, 'blocker'), 'not a dir', 'utf-8');
    expect(() => usage.flushUsage()).not.toThrow();
  });
});

describe('pruneUsage', () => {
  it('drops entries for skills that no longer exist', () => {
    usage.recordUse('gone', 1);
    usage.recordUse('here', 2);
    usage.pruneUsage(['here']);
    expect(Object.keys(usage.loadUsage())).toEqual(['here']);
  });

  it('trims to USAGE_MAX_ENTRIES, evicting least-recently-used first', () => {
    const names: string[] = [];
    for (let i = 0; i < usage.USAGE_MAX_ENTRIES + 10; i += 1) {
      const name = `skill-${String(i).padStart(4, '0')}`;
      names.push(name);
      usage.recordUse(name, 1000 + i);
    }
    usage.pruneUsage(names);
    const kept = Object.keys(usage.loadUsage());
    expect(kept).toHaveLength(usage.USAGE_MAX_ENTRIES);
    expect(kept).not.toContain('skill-0000');
    expect(kept).toContain(`skill-${String(usage.USAGE_MAX_ENTRIES + 9).padStart(4, '0')}`);
  });
});

describe('pruning is cap enforcement, not a per-scan sweep (§9.2)', () => {
  it('a rescan does NOT erase counters for skills absent from THIS registry', () => {
    // `discover()` used to prune against `registry.names()` every single time.
    // The registry is cwd-dependent — it carries the `project` skills of
    // whatever directory the process is in — so opening a second repository
    // silently deleted the first one's usage history, and one unreadable root
    // deleted all of it. The counters are the entire input to the ranking; they
    // are not scratch space to be reclaimed on a schedule.
    usage.recordUse('skill-from-another-repo', 5_000);
    writeSkill(join(tmp.root, 'data', 'skills'), 'pdf-forms');

    const service = makeService();
    service.discover();
    service.discover();

    expect(usage.loadUsage()['skill-from-another-repo']?.useCount).toBe(1);
  });
});

describe('AC-A13 — the service instrumentation', () => {
  it('a `skill` / slash-command load counts', () => {
    writeSkill(join(tmp.root, 'data', 'skills'), 'pdf-forms');
    const service = makeService();
    service.discover();

    service.loadBody('pdf-forms');
    expect(usage.loadUsage()['pdf-forms']?.useCount).toBe(1);
  });

  it('usageTracking: false writes nothing at all', () => {
    writeSkill(join(tmp.root, 'data', 'skills'), 'pdf-forms');
    const service = makeService({ usageTracking: false });
    service.discover();

    service.loadBody('pdf-forms');
    usage.flushUsage();
    expect(usage.loadUsage()).toEqual({});
    expect(existsSync(usagePath())).toBe(false);
    // …and the catalog therefore ranks by the pre-feature order (I-A1).
    expect(service.getUsage()).toEqual({});
  });

  it('alwaysBlock() does NOT count (F8) — the whole point of countUse:false', () => {
    writeSkill(join(tmp.root, 'data', 'skills'), 'ambient', { activation: 'always' });
    const service = makeService();
    service.discover();

    const block = service.alwaysBlock();
    expect(block).toContain('ambient');
    expect(usage.loadUsage()['ambient']).toBeUndefined();

    // A deliberate load of the SAME skill still counts, which is what makes the
    // distinction meaningful rather than a blanket exclusion.
    service.loadBody('ambient');
    expect(usage.loadUsage()['ambient']?.useCount).toBe(1);
  });

  it('an explicit countUse:false is honoured on any path', () => {
    writeSkill(join(tmp.root, 'data', 'skills'), 'quiet');
    const service = makeService();
    service.discover();
    service.loadBody('quiet', { countUse: false });
    expect(usage.loadUsage()['quiet']).toBeUndefined();
  });

  it('discover() enforces the entry cap once the file is over it', () => {
    writeSkill(join(tmp.root, 'data', 'skills'), 'stays');
    usage.recordUse('stays', 9_000);
    for (let i = 0; i < usage.USAGE_MAX_ENTRIES + 5; i += 1) {
      usage.recordUse(`ghost-${String(i).padStart(4, '0')}`, 1000 + i);
    }
    const service = makeService();
    service.discover();

    const kept = Object.keys(usage.loadUsage());
    expect(kept.length).toBeLessThanOrEqual(usage.USAGE_MAX_ENTRIES);
    // Pruning against the registry is what reclaims the room, so the skill that
    // is actually installed is the one that survives.
    expect(kept).toContain('stays');
  });
});
