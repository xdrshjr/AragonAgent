/**
 * Both of `store.ts`'s hand-written merges know about the `bash` section
 * (background-service-supervision §5.4).
 *
 * THE BUG THIS PINS IS SILENT, AND IT IS THE ONE THE SECTION'S OWN COMMENTS
 * DESCRIBE. `loadPersistedConfig` returns a spread of `DEFAULT_CONFIG` followed
 * by the raw file, so a `bash` key is always PRESENT on the result and
 * TypeScript is satisfied whatever the merge does — while a config file
 * carrying only `{ bash: { autoBackground: false } }` arrives with `background`
 * absent. `undefined` is falsy, so turning the CLASSIFIER off would unregister
 * `bash_output` / `bash_kill` and drop the prompt block from the next launch
 * onward, with nothing anywhere saying so.
 *
 * A dedicated file, and a dynamic import, for the reason
 * `config-skills-merge.test.ts` records: `app-paths.ts` resolves the user root
 * ONCE at module load, so the redirect has to happen before the import rather
 * than in a `beforeEach`.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'aragon-bash-cfg-'));
process.env.ARAGON_HOME = dir;
const configPath = (): string => join(dir, 'config.json');

const { loadPersistedConfig, updatePersistedConfig } = await import('../config/store.js');
const { DEFAULT_BASH_CONFIG } = await import('../config/schema.js');

beforeEach(() => {
  if (existsSync(configPath())) rmSync(configPath());
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the READ half', () => {
  it('supplies the whole section to a config.json that predates the feature', () => {
    writeFileSync(configPath(), JSON.stringify({ version: 1, provider: 'openai' }), 'utf-8');
    expect(loadPersistedConfig().bash).toEqual(DEFAULT_BASH_CONFIG);
  });

  it('keeps `background` on when only `autoBackground` is stored', () => {
    // The failure mode in one line: turning the classifier off must not turn the
    // TOOLS off. `background: undefined` is falsy, and every consumer reads it
    // as a boolean.
    writeFileSync(
      configPath(),
      JSON.stringify({ version: 1, bash: { autoBackground: false } }),
      'utf-8',
    );
    const loaded = loadPersistedConfig().bash;
    expect(loaded.background).toBe(true);
    expect(loaded.autoBackground).toBe(false);
    expect(loaded.startupSettleMs).toBe(DEFAULT_BASH_CONFIG.startupSettleMs);
    expect(loaded.readyTimeoutMs).toBe(DEFAULT_BASH_CONFIG.readyTimeoutMs);
  });

  it('clamps on the way in, so a hand-edited file cannot hold a wild timing', () => {
    writeFileSync(
      configPath(),
      JSON.stringify({ version: 1, bash: { startupSettleMs: 10_000_000 } }),
      'utf-8',
    );
    expect(loadPersistedConfig().bash.startupSettleMs).toBe(30_000);
  });
});

describe('the WRITE half', () => {
  it('a partial patch does not reset the rest of the section', () => {
    updatePersistedConfig({ bash: { ...DEFAULT_BASH_CONFIG, readyTimeoutMs: 30_000 } });
    const merged = updatePersistedConfig({ bash: { autoBackground: false } as never });
    expect(merged.bash.readyTimeoutMs).toBe(30_000);
    expect(merged.bash.background).toBe(true);
    expect(merged.bash.autoBackground).toBe(false);
  });

  it('clamps on the write path too, so a bad value never reaches disk', () => {
    const merged = updatePersistedConfig({ bash: { readyTimeoutMs: 1 } as never });
    expect(merged.bash.readyTimeoutMs).toBe(5_000);
    expect(loadPersistedConfig().bash.readyTimeoutMs).toBe(5_000);
  });
});
