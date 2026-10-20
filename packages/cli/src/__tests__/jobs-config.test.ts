/**
 * The `jobs` config section (long-task-jobs AC-29 / C-3).
 *
 * FIVE KEYS, BOTH MERGES, THE CLAMP, THE ENV LAYER, `config set`, AND THE I-4
 * CONVERGENCE. The section's failure mode is "the setting silently does nothing",
 * which is why every one of those paths is asserted rather than assumed - and why
 * the membership assertion at the end exists: the static guard in
 * `config.test.ts` matches only LITERAL keys in `cli.tsx`, so a spread set is
 * invisible to it (RV-P2-8).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import {
  DEFAULT_CONFIG,
  DEFAULT_JOBS_CONFIG,
  clampJobsConfig,
} from '../config/schema.js';
import { applyJobsConfigSet, JOBS_CONFIG_SET_KEYS } from '../config/cli-commands.js';
import { mergePersistedConfig } from '../config/store.js';
import { JOB_WAIT_MARGIN_MS } from '../proc/limits.js';

let home: string;
let previousHome: string | undefined;
/** `src/`, so the source-level assertions below do not depend on the cwd. */
const CLI_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aragon-jobs-config-'));
  previousHome = process.env.ARAGON_HOME;
  process.env.ARAGON_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ARAGON_HOME;
  else process.env.ARAGON_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('clampJobsConfig', () => {
  it('supplies every key to a user whose config predates the section', () => {
    expect(clampJobsConfig(undefined)).toEqual(DEFAULT_JOBS_CONFIG);
  });

  it('clamps the numeric keys into their ranges', () => {
    expect(clampJobsConfig({ waitSeconds: 1 }).waitSeconds).toBe(5);
    expect(clampJobsConfig({ waitSeconds: 9999 }).waitSeconds).toBe(60);
    expect(clampJobsConfig({ stallSeconds: 1 }).stallSeconds).toBe(30);
    expect(clampJobsConfig({ stallSeconds: 99_999 }).stallSeconds).toBe(3600);
  });

  it('falls back to the defaults for non-boolean flags', () => {
    const clamped = clampJobsConfig({ enabled: 'maybe', persistLog: 3, noticeSteer: null });
    expect(clamped.enabled).toBe(DEFAULT_JOBS_CONFIG.enabled);
    expect(clamped.persistLog).toBe(DEFAULT_JOBS_CONFIG.persistLog);
    expect(clamped.noticeSteer).toBe(DEFAULT_JOBS_CONFIG.noticeSteer);
  });

  it('keeps an explicit false', () => {
    expect(clampJobsConfig({ enabled: false }).enabled).toBe(false);
    expect(clampJobsConfig({ noticeSteer: false }).noticeSteer).toBe(false);
  });
});

describe('the two merges in store.ts (R-9)', () => {
  it('writing one key does not clear the other four', () => {
    const current = {
      ...DEFAULT_CONFIG,
      jobs: clampJobsConfig({ ...DEFAULT_JOBS_CONFIG, noticeSteer: false, stallSeconds: 600 }),
    };
    const merged = mergePersistedConfig(current, { jobs: { waitSeconds: 45 } });
    expect(merged.jobs.waitSeconds).toBe(45);
    expect(merged.jobs.noticeSteer).toBe(false);
    expect(merged.jobs.stallSeconds).toBe(600);
    expect(merged.jobs.enabled).toBe(true);
    expect(merged.jobs.persistLog).toBe(true);
  });

  it('the READ merge supplies the whole section to a file that lacks it', () => {
    const merged = mergePersistedConfig({ ...DEFAULT_CONFIG, jobs: undefined } as never, {});
    expect(merged.jobs).toEqual(DEFAULT_JOBS_CONFIG);
  });
});

describe('applyJobsConfigSet (C-3)', () => {
  it('clamps and echoes the STORED value', () => {
    expect(applyJobsConfigSet('jobs.waitSeconds', '1')).toEqual({ jobs: { waitSeconds: 5 } });
    expect(applyJobsConfigSet('jobs.waitSeconds', '9999')).toEqual({ jobs: { waitSeconds: 60 } });
    expect(applyJobsConfigSet('jobs.stallSeconds', '5')).toEqual({ jobs: { stallSeconds: 30 } });
  });

  it('parses the three booleans', () => {
    expect(applyJobsConfigSet('jobs.enabled', 'false')).toEqual({ jobs: { enabled: false } });
    expect(applyJobsConfigSet('jobs.persistLog', 'off')).toEqual({ jobs: { persistLog: false } });
    expect(applyJobsConfigSet('jobs.noticeSteer', '1')).toEqual({ jobs: { noticeSteer: true } });
  });

  it('returns null for anything else, so the dispatcher falls through', () => {
    expect(applyJobsConfigSet('jobs.mirror.enabled', 'true')).toBeNull();
    expect(applyJobsConfigSet('bash.autoBackground', 'false')).toBeNull();
  });

  it('every accepted key is dispatched and registered (RV-P2-8)', () => {
    // `CONFIG_SET_KEYS` is a module-local const in `cli.tsx`, which has side
    // effects and cannot be imported from a unit test. The static guard in
    // `config.test.ts` matches only LITERAL keys there, so a spread set is
    // invisible to it - which is exactly how "registered but never dispatched"
    // would ship. This asserts both halves at the source level instead.
    const source = readFileSync(join(CLI_SRC, 'cli.tsx'), 'utf8');
    expect(source).toContain('...JOBS_CONFIG_SET_KEYS');
    expect(source).toContain('applyJobsConfigSet(key, value)');
    // And the set is non-empty, so the two assertions above cannot both pass
    // vacuously against a section nobody can write.
    expect(JOBS_CONFIG_SET_KEYS.length).toBe(5);
  });

  it('all five keys of §6.5 are covered', () => {
    expect([...JOBS_CONFIG_SET_KEYS].sort()).toEqual([
      'jobs.enabled',
      'jobs.noticeSteer',
      'jobs.persistLog',
      'jobs.stallSeconds',
      'jobs.waitSeconds',
    ]);
  });
});

describe('I-4: the wait fits inside the tool ceiling', () => {
  it('the margin is 30s', () => {
    expect(JOB_WAIT_MARGIN_MS).toBe(30_000);
  });

  it('load-time convergence lowers the wait rather than raising the ceiling', async () => {
    const { loadConfig } = await import('../config/load.js');
    const config = loadConfig({ toolTimeout: '40000' }, { interactive: false });
    // (40000 - 30000) / 1000 = 10
    expect(config.jobs.waitSeconds).toBe(10);
    // ...and the idle window still follows the tool ceiling, in ITS direction.
    expect(config.idleTimeoutMs).toBeGreaterThan(config.toolTimeoutMs);
  });

  it('a generous ceiling leaves the default alone', async () => {
    const { loadConfig } = await import('../config/load.js');
    const config = loadConfig({ toolTimeout: '180000' }, { interactive: false });
    expect(config.jobs.waitSeconds).toBe(DEFAULT_JOBS_CONFIG.waitSeconds);
  });
});
