/**
 * `config/ui-state.ts` — `<home>/state.json` (config-state-separation §8.2).
 *
 * The `mouseNoticeSeen` round-trip here is deliberately independent of `App`:
 * `mouse-routing.test.tsx` observes it through a mock, so if that mock ever
 * drifts from the real store this file is what still fails (R-7).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const TMP = mkdtempSync(join(tmpdir(), 'aragon-cli-state-'));
process.env.ARAGON_HOME = TMP;

const { getUiStatePath } = await import('../config/app-paths.js');
const {
  bumpSubmitCount,
  getMouseNoticeSeen,
  getVtInputNoticeVersion,
  importLegacyUiState,
  loadUiState,
  readSubmitCount,
  resetUiStateForTests,
  setMouseNoticeSeen,
  setVtInputNoticeVersion,
} = await import('../config/ui-state.js');

const PATH = getUiStatePath();

function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(PATH, 'utf-8')) as Record<string, unknown>;
}

beforeEach(() => {
  rmSync(PATH, { force: true });
  resetUiStateForTests();
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('reading', () => {
  it('falls back to defaults when the file is missing', () => {
    expect(loadUiState()).toEqual({
      schema: 1,
      submitCount: 0,
      mouseNoticeSeen: false,
      // AC-16: a NEW FIELD, and `UI_STATE_SCHEMA` deliberately still `1`.
      // Bumping the schema would make `readFromDisk` discard the whole object,
      // resetting every existing user's submit counter to re-show one notice
      // (P1-8). A new field simply reads as its default on an older file.
      mouseNoticeVersion: 0,
      vtInputNoticeVersion: 0,
    });
  });

  it('falls back entirely when the schema is unknown', () => {
    writeFileSync(PATH, JSON.stringify({ schema: 2, submitCount: 9, mouseNoticeSeen: true }));
    expect(readSubmitCount()).toBe(0);
    expect(getMouseNoticeSeen()).toBe(false);
  });

  /**
   * Per-field tolerance: one nonsense value must not take the other field with
   * it. A hand-edited file is a normal thing to meet.
   */
  it('recovers one bad field without discarding the other', () => {
    writeFileSync(PATH, JSON.stringify({ schema: 1, submitCount: 'abc', mouseNoticeSeen: true }));
    expect(readSubmitCount()).toBe(0);
    expect(getMouseNoticeSeen()).toBe(true);
  });

  it('survives a truncated file', () => {
    writeFileSync(PATH, '{"schema":1,"submitCo');
    expect(() => loadUiState()).not.toThrow();
    expect(readSubmitCount()).toBe(0);
  });
});

describe('writing', () => {
  it('persists the counter across a cold read', () => {
    bumpSubmitCount();
    bumpSubmitCount();
    expect(bumpSubmitCount()).toBe(3);
    expect(onDisk().submitCount).toBe(3);

    resetUiStateForTests();
    expect(readSubmitCount()).toBe(3);
  });

  it('round-trips mouseNoticeSeen', () => {
    setMouseNoticeSeen(true);
    resetUiStateForTests();
    expect(getMouseNoticeSeen()).toBe(true);
  });

  it('round-trips vtInputNoticeVersion without disturbing mouseNoticeSeen', () => {
    setMouseNoticeSeen(true);
    setVtInputNoticeVersion(1);
    resetUiStateForTests();
    expect(getMouseNoticeSeen()).toBe(true);
    expect(getVtInputNoticeVersion()).toBe(1);
  });

  /**
   * R6-1, at the storage layer: the audience for the VT-input notice is exactly
   * the set of users who have ALREADY run aragon and therefore already have
   * `mouseNoticeSeen: true` written by an older build. If a pre-existing file
   * could read as "already seen" for the new flag too, the fix would be inert
   * for everyone who needs it — and silently so.
   */
  it('reads a pre-existing state.json as not-yet-seen for the new notice', () => {
    writeFileSync(PATH, JSON.stringify({ schema: 1, submitCount: 42, mouseNoticeSeen: true }));
    expect(getMouseNoticeSeen()).toBe(true);
    expect(getVtInputNoticeVersion()).toBe(0);
    // And the older fields survive: a new field must not force a schema bump,
    // which would discard the counter and re-show the mouse notice for everyone.
    expect(readSubmitCount()).toBe(42);
  });

  /**
   * The same argument, one turn later: 0.6.1 recorded `vtInputNoticeSeen: true`
   * for a text that only ever offered `/plan`. Reading that boolean as "already
   * seen" would silence the first revision that names the fallback key for the
   * whole population it was written for — so the old key must read as version 0,
   * while everything ELSE in that user's file survives untouched.
   */
  it('reads the 0.6.1 boolean key as version 0, keeping the rest of the file', () => {
    writeFileSync(
      PATH,
      JSON.stringify({ schema: 1, submitCount: 7, mouseNoticeSeen: true, vtInputNoticeSeen: true }),
    );
    expect(getVtInputNoticeVersion()).toBe(0);
    expect(getMouseNoticeSeen()).toBe(true);
    expect(readSubmitCount()).toBe(7);
  });

  /** A hand-edited or truncated value must not read as "already shown". */
  it('recovers a nonsense vtInputNoticeVersion as 0', () => {
    writeFileSync(PATH, JSON.stringify({ schema: 1, vtInputNoticeVersion: 'soon' }));
    expect(getVtInputNoticeVersion()).toBe(0);
  });

  /** RV-2, the symmetric case to `prompt-history.test.ts`. */
  it('creates <home> when it does not exist yet', () => {
    rmSync(TMP, { recursive: true, force: true });
    expect(existsSync(TMP)).toBe(false);
    expect(bumpSubmitCount()).toBe(1);
    expect(onDisk().submitCount).toBe(1);
  });

  it.runIf(process.platform !== 'win32')('writes 0600 on POSIX (RV-6)', () => {
    bumpSubmitCount();
    expect(statSync(PATH).mode & 0o777).toBe(0o600);
  });
});

describe('legacy import', () => {
  it('fills in fields still at their default', () => {
    importLegacyUiState({ submitCount: 16, mouseNoticeSeen: true });
    expect(readSubmitCount()).toBe(16);
    expect(getMouseNoticeSeen()).toBe(true);
  });

  /**
   * A migration that retries after a partial failure must not walk the counter
   * backwards to whatever the stale config file still says.
   */
  it('never overwrites a value that is already here', () => {
    bumpSubmitCount();
    bumpSubmitCount();
    importLegacyUiState({ submitCount: 5 });
    expect(readSubmitCount()).toBe(2);
  });
});
