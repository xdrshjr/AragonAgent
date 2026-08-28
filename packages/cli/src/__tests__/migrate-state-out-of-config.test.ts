/**
 * `config/migrate-state-out-of-config.ts` (config-state-separation §8.2).
 *
 * This is the only part of the feature that can lose data, so the cases here
 * are mostly about the failure paths: retrying, not double-importing, and never
 * touching a config file that would not parse.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const TMP = mkdtempSync(join(tmpdir(), 'aragon-cli-mig-'));
process.env.ARAGON_HOME = TMP;

const { getConfigPath, getPromptHistoryPath, getUiStatePath } = await import(
  '../config/app-paths.js'
);
const { migrateStateOutOfConfig } = await import('../config/migrate-state-out-of-config.js');
const { loadPromptHistory, resetPromptHistoryForTests } = await import(
  '../config/prompt-history.js'
);
const { getMouseNoticeSeen, readSubmitCount, resetUiStateForTests } = await import(
  '../config/ui-state.js'
);

const CONFIG_PATH = getConfigPath();
const HISTORY_PATH = getPromptHistoryPath();
const STATE_PATH = getUiStatePath();

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
}

const LEGACY = {
  version: 1,
  model: 'a-model',
  promptHistory: ['first prompt', 'second prompt'],
  submitCount: 16,
  mouseNoticeSeen: true,
  recentModels: [],
};

beforeEach(() => {
  rmSync(CONFIG_PATH, { force: true });
  rmSync(HISTORY_PATH, { force: true });
  rmSync(STATE_PATH, { force: true });
  resetPromptHistoryForTests();
  resetUiStateForTests();
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('migrateStateOutOfConfig', () => {
  it('moves all four keys and leaves the rest of the config alone', () => {
    writeConfig(LEGACY);
    const result = migrateStateOutOfConfig();

    expect(result.moved.sort()).toEqual(
      ['mouseNoticeSeen', 'promptHistory', 'recentModels', 'submitCount'].sort(),
    );
    expect(result.promptEntries).toBe(2);

    const after = readConfig();
    expect(after.promptHistory).toBeUndefined();
    expect(after.submitCount).toBeUndefined();
    expect(after.mouseNoticeSeen).toBeUndefined();
    expect(after.recentModels).toBeUndefined();
    expect(after.model).toBe('a-model');

    expect(loadPromptHistory()).toEqual(['first prompt', 'second prompt']);
    expect(readSubmitCount()).toBe(16);
    expect(getMouseNoticeSeen()).toBe(true);
  });

  it('does nothing, and writes nothing, when there are no legacy keys', () => {
    writeConfig({ version: 1, model: 'a-model' });
    const before = statSync(CONFIG_PATH).mtimeMs;

    const result = migrateStateOutOfConfig();

    expect(result.moved).toEqual([]);
    expect(existsSync(HISTORY_PATH)).toBe(false);
    expect(existsSync(STATE_PATH)).toBe(false);
    expect(statSync(CONFIG_PATH).mtimeMs).toBe(before);
  });

  it('is idempotent — a second run moves nothing and does not duplicate history', () => {
    writeConfig(LEGACY);
    migrateStateOutOfConfig();
    resetPromptHistoryForTests();

    const second = migrateStateOutOfConfig();
    expect(second.moved).toEqual([]);
    expect(loadPromptHistory()).toEqual(['first prompt', 'second prompt']);
  });

  /**
   * The idempotence key is the SOURCE data, so a run that imported the history
   * but failed before rewriting config.json retries on the next launch. That is
   * only safe because the import skips texts the file already holds.
   */
  it('does not re-import entries a previous attempt already wrote', () => {
    writeFileSync(
      HISTORY_PATH,
      `${JSON.stringify({ v: 1, ts: 1, text: 'first prompt' })}\n`,
      'utf-8',
    );
    writeConfig(LEGACY);

    const result = migrateStateOutOfConfig();
    expect(result.promptEntries).toBe(1);
    expect(loadPromptHistory()).toEqual(['first prompt', 'second prompt']);
  });

  it('keeps a newer submitCount instead of the stale one in the config file', () => {
    writeFileSync(
      STATE_PATH,
      `${JSON.stringify({ schema: 1, submitCount: 99, mouseNoticeSeen: false })}\n`,
      'utf-8',
    );
    writeConfig({ ...LEGACY, submitCount: 5 });

    migrateStateOutOfConfig();
    expect(readSubmitCount()).toBe(99);
  });

  /**
   * A config file that will not parse is the user's problem to fix, and the
   * backup they might be about to restore from is their own file. Rewriting it
   * here would destroy the evidence and the fix at once.
   */
  it('leaves a corrupt config file byte-for-byte untouched', () => {
    const broken = '{ "model": "a-model", }\n';
    writeFileSync(CONFIG_PATH, broken, 'utf-8');

    const result = migrateStateOutOfConfig();

    expect(result.moved).toEqual([]);
    expect(readFileSync(CONFIG_PATH, 'utf-8')).toBe(broken);
  });

  /**
   * RV-5 — the privacy hole this closes: upgrade, turn recording off, downgrade
   * to 0.5.x (which writes `promptHistory` back into config.json), upgrade
   * again. The key still has to LEAVE the config file; the prompts must not
   * arrive in the new one.
   */
  it('drops the key without importing it when historyEnabled is false', () => {
    writeConfig({ ...LEGACY, historyEnabled: false });

    const result = migrateStateOutOfConfig();

    expect(result.moved).toContain('promptHistory');
    expect(result.promptEntries).toBe(0);
    expect(readConfig().promptHistory).toBeUndefined();
    expect(existsSync(HISTORY_PATH)).toBe(false);
    expect(loadPromptHistory()).toEqual([]);
  });
});
