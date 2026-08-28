/**
 * `<home>/update-state.json` (cli-auto-update §5.2 / §8.1).
 *
 * THE FILE IS THE CROSS-PROCESS THROTTLE, so the two properties that matter are
 * that a corrupt one costs at most one extra registry request, and that a write
 * is READ-MODIFY-WRITE rather than a replacement — another `aragon` may have
 * recorded a check between our read and our write, and clobbering its
 * `lastCheckAt` is how ten terminals turn back into ten registry requests.
 *
 * NEVER THROWS is asserted rather than reasoned: every caller runs on a
 * background timer, where an exception is an unhandled rejection.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const HOME = mkdtempSync(join(tmpdir(), 'aragon-update-state-'));
process.env.ARAGON_HOME = HOME;

const { getUpdateStatePath } = await import('../config/app-paths.js');
const { DEFAULT_UPDATE_STATE, readUpdateState, updateUpdateState, UPDATE_STATE_SCHEMA } =
  await import('../update/state.js');

beforeEach(() => {
  // A single FILE, never a directory a function returned (the `app-paths.ts`
  // test-isolation contract).
  rmSync(getUpdateStatePath(), { force: true });
});

afterEach(() => {
  rmSync(getUpdateStatePath(), { force: true });
});

describe('readUpdateState', () => {
  it('returns the defaults when the file does not exist', () => {
    expect(readUpdateState()).toEqual(DEFAULT_UPDATE_STATE);
  });

  it('round-trips every field', () => {
    updateUpdateState({
      lastCheckAt: 1_700_000_000_000,
      lastKnownVersion: '0.6.0',
      pendingRestartVersion: '0.6.0',
      skippedVersion: '0.5.9',
      consecutiveFailures: 2,
      lastFailureAt: 1_700_000_001_000,
      autoInstalledVersion: '0.6.0',
      lastGoodVersion: '0.5.9',
      bootFailures: 1,
      rolledBackFrom: '0.6.1',
    });
    // EVERY field, spelled out rather than spread: this is the one place a
    // reviewer sees the whole shape, and a field added without a line here is a
    // field nothing round-trips.
    expect(readUpdateState()).toEqual({
      schema: UPDATE_STATE_SCHEMA,
      lastCheckAt: 1_700_000_000_000,
      lastKnownVersion: '0.6.0',
      pendingRestartVersion: '0.6.0',
      skippedVersion: '0.5.9',
      consecutiveFailures: 2,
      lastFailureAt: 1_700_000_001_000,
      autoInstalledVersion: '0.6.0',
      lastGoodVersion: '0.5.9',
      bootFailures: 1,
      rolledBackFrom: '0.6.1',
    });
  });

  it('is READ-MODIFY-WRITE, so a partial patch keeps the other fields', () => {
    // The property that keeps ten terminals down to one registry request: a
    // patch that only records a failure must not erase another process's
    // `lastCheckAt`.
    updateUpdateState({ lastCheckAt: 111, lastKnownVersion: '0.6.0' });
    updateUpdateState({ consecutiveFailures: 1 });
    const state = readUpdateState();
    expect(state.lastCheckAt).toBe(111);
    expect(state.lastKnownVersion).toBe('0.6.0');
    expect(state.consecutiveFailures).toBe(1);
  });

  it('falls back WHOLESALE on an unknown schema', () => {
    // The shape is no longer known, so per-field tolerance would be guessing —
    // the rule `ui-state.ts` and `skills/usage.ts` both follow.
    writeFileSync(
      getUpdateStatePath(),
      JSON.stringify({ schema: 99, lastCheckAt: 5, skippedVersion: '9.9.9' }),
    );
    expect(readUpdateState()).toEqual(DEFAULT_UPDATE_STATE);
  });

  it('tolerates ONE bad field without losing the others', () => {
    writeFileSync(
      getUpdateStatePath(),
      JSON.stringify({
        schema: UPDATE_STATE_SCHEMA,
        lastCheckAt: 'yesterday',
        lastKnownVersion: '0.6.0',
        consecutiveFailures: -4,
      }),
    );
    const state = readUpdateState();
    expect(state.lastCheckAt).toBe(0);
    expect(state.consecutiveFailures).toBe(0);
    // The good field survived, which is the whole point of per-field tolerance.
    expect(state.lastKnownVersion).toBe('0.6.0');
  });

  it('never throws on a corrupt file', () => {
    for (const junk of ['{ not json', '', 'null', '[]', '"a string"']) {
      writeFileSync(getUpdateStatePath(), junk);
      expect(() => readUpdateState(), JSON.stringify(junk)).not.toThrow();
      expect(readUpdateState().schema).toBe(UPDATE_STATE_SCHEMA);
    }
  });

  it('NO process-lifetime cache: a write by another process is seen', () => {
    // Unlike `ui-state.ts`, which memoizes. The whole point of `lastCheckAt` is
    // that a SECOND aragon wrote it, so a value cached at first read would
    // defeat the throttle it exists to implement.
    updateUpdateState({ lastCheckAt: 1 });
    writeFileSync(
      getUpdateStatePath(),
      JSON.stringify({ schema: UPDATE_STATE_SCHEMA, lastCheckAt: 999 }),
    );
    expect(readUpdateState().lastCheckAt).toBe(999);
  });
});

describe('R-21 / C-17: this file is a CROSS-VERSION channel', () => {
  it('a file written by the PREVIOUS shape still reads its `skippedVersion` back', () => {
    // THE ASSERTION THAT STOPS A SCHEMA BUMP. `readUpdateState` falls back to the
    // whole default object on a schema mismatch, so bumping the number to add an
    // optional field would discard `skippedVersion` on every machine at once —
    // and `skippedVersion` is what stops an `install-ineffective` loop (R-12)
    // and, from the hardening round on, a bad-release loop. Per-field tolerance
    // already handles absence, so a bump buys nothing and costs the latch.
    writeFileSync(
      getUpdateStatePath(),
      JSON.stringify({
        schema: UPDATE_STATE_SCHEMA,
        lastCheckAt: 1_700_000_000_000,
        lastKnownVersion: '0.6.0',
        pendingRestartVersion: '',
        skippedVersion: '0.6.0',
        consecutiveFailures: 0,
        lastFailureAt: 0,
      }),
    );
    const state = readUpdateState();
    expect(state.skippedVersion).toBe('0.6.0');
    // And the four fields that file has never heard of read as their defaults
    // rather than failing the parse.
    expect(state.autoInstalledVersion).toBe('');
    expect(state.lastGoodVersion).toBe('');
    expect(state.bootFailures).toBe(0);
    expect(state.rolledBackFrom).toBe('');
  });

  it('the four new fields round-trip', () => {
    updateUpdateState({
      autoInstalledVersion: '0.6.0',
      lastGoodVersion: '0.5.9',
      bootFailures: 2,
      rolledBackFrom: '0.6.0',
    });
    const state = readUpdateState();
    expect(state.autoInstalledVersion).toBe('0.6.0');
    expect(state.lastGoodVersion).toBe('0.5.9');
    expect(state.bootFailures).toBe(2);
    expect(state.rolledBackFrom).toBe('0.6.0');
  });

  it('an OLDER CLI writing this file erases them, which is why the latch is `skippedVersion`', () => {
    // C-17 demonstrated rather than described. This is the read-then-write an
    // `aragon` that predates these fields performs, and the four fields are gone
    // afterwards while `skippedVersion` survives — so a rollback that latched
    // ONLY in a new field would be invisible to the version it rolled back to,
    // which would reinstall the release that just bricked the machine.
    updateUpdateState({
      skippedVersion: '0.6.0',
      autoInstalledVersion: '0.6.0',
      lastGoodVersion: '0.5.9',
      bootFailures: 2,
      rolledBackFrom: '0.6.0',
    });
    const seen = readUpdateState();
    writeFileSync(
      getUpdateStatePath(),
      JSON.stringify({
        schema: UPDATE_STATE_SCHEMA,
        lastCheckAt: seen.lastCheckAt,
        lastKnownVersion: seen.lastKnownVersion,
        pendingRestartVersion: seen.pendingRestartVersion,
        skippedVersion: seen.skippedVersion,
        consecutiveFailures: seen.consecutiveFailures,
        lastFailureAt: seen.lastFailureAt,
      }),
    );
    const after = readUpdateState();
    expect(after.skippedVersion).toBe('0.6.0');
    expect(after.autoInstalledVersion).toBe('');
    expect(after.bootFailures).toBe(0);
  });

  it('the schema number is still 1, and changing it is the bug R-21 names', () => {
    expect(UPDATE_STATE_SCHEMA).toBe(1);
  });
});

describe('updateUpdateState — never throws', () => {
  it('survives an unwritable home and keeps returning the merged value', () => {
    const previous = process.env.ARAGON_HOME;
    try {
      // A path whose parent is a FILE: `mkdirSync` fails, so does the write.
      const blocker = join(HOME, 'blocker');
      writeFileSync(blocker, 'not a directory');
      process.env.ARAGON_HOME = join(blocker, 'nested');
      // The resolution is captured at module load, so this cannot actually
      // redirect the path — which is exactly why the assertion below is about
      // NOT THROWING rather than about where the bytes went.
      expect(() => updateUpdateState({ lastCheckAt: 7 })).not.toThrow();
      expect(updateUpdateState({ lastCheckAt: 7 }).lastCheckAt).toBe(7);
    } finally {
      if (previous === undefined) delete process.env.ARAGON_HOME;
      else process.env.ARAGON_HOME = previous;
    }
  });
});
