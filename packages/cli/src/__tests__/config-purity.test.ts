/**
 * The mechanical guard for config-state-separation §4.5 / R-1.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS CATCHES: removing the four state keys from `PersistedConfig`
 * removes them from the TYPE, not from the FILE. `loadPersistedConfig()` merges
 * `{ ...DEFAULT_CONFIG, ...partial }` with `partial` being the raw parse of
 * whatever is on disk, so without `stripLegacyStateKeys` every key still in the
 * user's file rides through that spread and gets written straight back. The
 * symptom is a user deleting `promptHistory` by hand and watching it come back.
 *
 * The whole feature is worth nothing if this file goes red and someone deletes
 * the assertions instead of the keys.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const TMP = mkdtempSync(join(tmpdir(), 'aragon-cli-purity-'));
process.env.ARAGON_HOME = TMP;

const { DEFAULT_CONFIG, LEGACY_STATE_KEYS, stripLegacyStateKeys } = await import(
  '../config/schema.js'
);
const { getConfigPath, loadPersistedConfig, updatePersistedConfig } = await import(
  '../config/store.js'
);

const CONFIG_PATH = getConfigPath();

beforeEach(() => {
  rmSync(CONFIG_PATH, { force: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('config.json holds configuration only', () => {
  it('has no legacy state key left in DEFAULT_CONFIG', () => {
    const overlap = LEGACY_STATE_KEYS.filter((key) => key in DEFAULT_CONFIG);
    expect(overlap).toEqual([]);
  });

  it('strips them from a hand-written file on the very next write', () => {
    writeFileSync(
      CONFIG_PATH,
      `${JSON.stringify(
        {
          version: 1,
          model: 'kept',
          promptHistory: ['something private'],
          submitCount: 16,
          mouseNoticeSeen: true,
          recentModels: ['m'],
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    updatePersistedConfig({ theme: 'cool' });

    const written = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
    for (const key of LEGACY_STATE_KEYS) expect(written[key]).toBeUndefined();
    // ...and the write it was carrying still landed, plus the untouched field.
    expect(written.theme).toBe('cool');
    expect(written.model).toBe('kept');
  });

  it('never surfaces one through loadPersistedConfig', () => {
    writeFileSync(
      CONFIG_PATH,
      `${JSON.stringify({ version: 1, promptHistory: ['leaked'], submitCount: 3 })}\n`,
      'utf-8',
    );
    const loaded = loadPersistedConfig() as unknown as Record<string, unknown>;
    for (const key of LEGACY_STATE_KEYS) expect(loaded[key]).toBeUndefined();
  });

  it('leaves every other key alone when stripping', () => {
    const raw = { model: 'm', promptHistory: ['x'], skills: { enabled: true } };
    expect(stripLegacyStateKeys(raw)).toEqual({ model: 'm', skills: { enabled: true } });
    // A copy, not a mutation of the caller's object.
    expect(raw.promptHistory).toEqual(['x']);
  });
});
