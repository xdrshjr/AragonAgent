/**
 * Home-root resolution, including the test-isolation guard that keeps `npm
 * test` away from the developer's own `~/.aragon-agent`.
 *
 * `app-paths.ts` resolves once at module load, so every case re-imports it
 * through `vi.resetModules()` after setting the environment — the same pattern
 * the config tests already use, rather than a second mocking mechanism.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const TMP = mkdtempSync(join(tmpdir(), 'aragon-home-'));
const savedHome = process.env.ARAGON_HOME;
const savedVitest = process.env.VITEST;

async function importPaths(): Promise<typeof import('../config/app-paths.js')> {
  vi.resetModules();
  return import('../config/app-paths.js');
}

beforeEach(() => {
  delete process.env.ARAGON_HOME;
  process.env.VITEST = savedVitest ?? 'true';
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.ARAGON_HOME;
  else process.env.ARAGON_HOME = savedHome;
  if (savedVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = savedVitest;
});

describe('home root resolution', () => {
  it('defaults to ~/.aragon-agent outside a test process', async () => {
    delete process.env.VITEST;
    const paths = await importPaths();
    expect(paths.getHomeRoot()).toBe(join(homedir(), '.aragon-agent'));
    expect(paths.isHomeOverridden()).toBe(false);
  });

  it('derives every location from that one root', async () => {
    process.env.ARAGON_HOME = TMP;
    const paths = await importPaths();
    expect(paths.getConfigPath()).toBe(join(TMP, 'config.json'));
    expect(paths.getConfigBackupPath()).toBe(join(TMP, 'config.json.bak'));
    expect(paths.getLogsDir()).toBe(join(TMP, 'logs'));
    expect(paths.getSessionsDir()).toBe(join(TMP, 'sessions'));
    expect(paths.getUserSkillsDir()).toBe(join(TMP, 'skills'));
    // `<data>` IS the root: skill-usage.json sits directly inside it.
    expect(paths.getUserDataDir()).toBe(TMP);
  });

  it('honours ARAGON_HOME and reports the override', async () => {
    process.env.ARAGON_HOME = TMP;
    const paths = await importPaths();
    expect(paths.getHomeRoot()).toBe(TMP);
    expect(paths.isHomeOverridden()).toBe(true);
  });

  it('normalises a trailing separator and a relative path', async () => {
    process.env.ARAGON_HOME = `${TMP}\\`;
    expect((await importPaths()).getHomeRoot()).toBe(TMP);

    process.env.ARAGON_HOME = './relative-home';
    const resolved = (await importPaths()).getHomeRoot();
    expect(resolved).toBe(join(process.cwd(), 'relative-home'));
  });

  it('falls back with a warning when ARAGON_HOME points at a file', async () => {
    const file = join(TMP, 'not-a-directory');
    writeFileSync(file, 'x', 'utf-8');
    process.env.ARAGON_HOME = file;

    const paths = await importPaths();
    expect(paths.getHomeRoot()).not.toBe(file);
    expect(paths.isHomeOverridden()).toBe(false);
    expect(paths.getHomeResolutionWarning()).toContain('not a directory');
  });

  it('1b — isHomeOverridden survives the env being cleared afterwards', async () => {
    // `config.test.ts::clearEnv()` deletes every ARAGON_* var before each test.
    // A live `process.env` read here would report `false` for a run that really
    // is overridden.
    process.env.ARAGON_HOME = TMP;
    const paths = await importPaths();
    delete process.env.ARAGON_HOME;
    expect(paths.isHomeOverridden()).toBe(true);
    expect(paths.getHomeRoot()).toBe(TMP);
  });

  it('1c — a test process without ARAGON_HOME lands in tmpdir, never in the real home', async () => {
    process.env.VITEST = 'true';
    const paths = await importPaths();
    expect(paths.getHomeRoot().startsWith(tmpdir())).toBe(true);
    expect(paths.getHomeRoot()).not.toBe(join(homedir(), '.aragon-agent'));
  });

  it('1c — the same guard covers the FALLBACK, not only the default', async () => {
    // Otherwise a test that sets ARAGON_HOME to something unusable would be
    // handed the developer's real home as its consolation prize.
    const file = join(TMP, 'also-not-a-directory');
    writeFileSync(file, 'x', 'utf-8');
    process.env.VITEST = 'true';
    process.env.ARAGON_HOME = file;

    const paths = await importPaths();
    expect(paths.getHomeRoot().startsWith(tmpdir())).toBe(true);
    expect(paths.getHomeRoot()).not.toBe(join(homedir(), '.aragon-agent'));
  });

  it('keeps the env-paths roots reachable for the migrations only', async () => {
    const paths = await importPaths();
    expect(paths.legacyEnvPaths.config).toContain('aragon-agent');
    expect(paths.legacyEnvPaths.data).toContain('aragon-agent');
  });
});

process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
