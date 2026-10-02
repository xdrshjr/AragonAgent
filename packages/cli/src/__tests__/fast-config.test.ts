/**
 * The `fast` config section: clamp, merge, and the four resolution layers
 * (fast-model-tier §3.7 / §4.2 / §8.1).
 *
 * THE ROUND TRIP THROUGH `updatePersistedConfig` IS THE POINT (C-3 / R-10).
 * `store.ts` merges nested sections BY HAND in TWO places, and omitting the
 * write half is silent: `/fast review 8` sends `{ fast: { reviewEveryTurns: 8 } }`,
 * a shallow top-level spread replaces the whole section, `enabled` is written
 * absent, and the tier the user configured yesterday is gone tomorrow with no
 * error anywhere. This package has paid for that once already, in `todo` (P0-1).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const HOME = mkdtempSync(join(tmpdir(), 'aragon-fast-config-'));
process.env.ARAGON_HOME = HOME;

const { clampFastConfig, DEFAULT_FAST_CONFIG } = await import('../config/schema.js');
const { applyFastConfigSet, FAST_CONFIG_SET_KEYS } = await import('../config/cli-commands.js');
const { fastSettingsFrom, readFastSettings } = await import(
  '../ui/overlays/SettingsScreen.js'
);
const { loadPersistedConfig, updatePersistedConfig, writeConfigFile } = await import(
  '../config/store.js'
);
const { loadConfig } = await import('../config/load.js');

const ENV_KEYS = [
  'ARAGON_FAST',
  'ARAGON_FAST_PROVIDER',
  'ARAGON_FAST_MODEL',
  'ARAGON_FAST_BASE_URL',
];

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  writeConfigFile(loadPersistedConfig());
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('clampFastConfig - the single gate for read AND write', () => {
  it('AC-1: an absent section resolves to the DEFAULTS, with the tier off (R-d)', () => {
    expect(clampFastConfig(undefined)).toEqual(DEFAULT_FAST_CONFIG);
    expect(clampFastConfig(undefined).enabled).toBe(false);
  });

  it('AC-13: clamps a wild cadence rather than rejecting it', () => {
    expect(clampFastConfig({ reviewEveryTurns: 400 }).reviewEveryTurns).toBe(50);
    expect(clampFastConfig({ reviewEveryTurns: 1 }).reviewEveryTurns).toBe(1);
    // `0` and a negative fall back to the DEFAULT rather than to the floor, and
    // that is the package-wide behaviour of `clampInt` (via `coercePositiveInt`)
    // rather than an accident here — `clampTeamConfig` does the same for
    // `maxSubagents`. It is correct for this key because a cadence of zero is
    // meaningless: the user who typed it meant a number, not the minimum. The
    // key that genuinely needs zero is `retry.maxRetries`, which is why THAT one
    // has its own `clampIntAllowingZero`.
    expect(clampFastConfig({ reviewEveryTurns: 0 }).reviewEveryTurns).toBe(
      DEFAULT_FAST_CONFIG.reviewEveryTurns,
    );
    expect(clampFastConfig({ reviewContextTurns: 99 }).reviewContextTurns).toBe(10);
    expect(clampFastConfig({ reviewMaxChars: 9 }).reviewMaxChars).toBe(80);
    expect(clampFastConfig({ reviewMaxChars: 5000 }).reviewMaxChars).toBe(600);
  });

  it('clamps `reviewMaxPerSession` into 1-500 (test 12 / hardening §4.1)', () => {
    expect(clampFastConfig({ reviewMaxPerSession: 9999 }).reviewMaxPerSession).toBe(500);
    expect(clampFastConfig({ reviewMaxPerSession: 1 }).reviewMaxPerSession).toBe(1);
    // `0` and `'x'` fall back to the DEFAULT rather than to the floor, the
    // package-wide behaviour of `clampInt` - and correct here for the same
    // reason it is for `reviewEveryTurns`: a budget of zero is not a value a
    // user means, and there is deliberately no "unlimited" sentinel to confuse
    // it with (D-H2).
    expect(clampFastConfig({ reviewMaxPerSession: 0 }).reviewMaxPerSession).toBe(
      DEFAULT_FAST_CONFIG.reviewMaxPerSession,
    );
    expect(clampFastConfig({ reviewMaxPerSession: 'x' }).reviewMaxPerSession).toBe(40);
    expect(clampFastConfig(undefined).reviewMaxPerSession).toBe(40);
  });

  it('clamps a provider with no adapter to `` (inherit), never to garbage', () => {
    // `''` means "inherit the main provider", which is the safe reading of a
    // typo — and `resolveFastTier` still reports `no_adapter` for the case where
    // the MAIN provider is the dead one.
    expect(clampFastConfig({ provider: 'nope' }).provider).toBe('');
    expect(clampFastConfig({ provider: 'openai' }).provider).toBe('openai');
  });

  it('clamps an unrecognized thinking level to the default', () => {
    expect(clampFastConfig({ thinkingLevel: 'nonsense' }).thinkingLevel).toBe('off');
  });

  it('trims the string fields, so a pasted key with a newline still resolves', () => {
    expect(clampFastConfig({ model: '  haiku \n' }).model).toBe('haiku');
  });
});

describe('store.ts - BOTH merges learn the section (C-3 / R-10)', () => {
  it('the READ half: a file with no `fast` key gets the defaults', () => {
    writeConfigFile({ ...loadPersistedConfig(), fast: undefined as never });
    expect(loadPersistedConfig().fast).toEqual(DEFAULT_FAST_CONFIG);
  });

  it('the WRITE half: a PARTIAL patch does not wipe the rest of the section', () => {
    updatePersistedConfig({
      fast: { enabled: true, model: 'claude-haiku-4-5', provider: 'anthropic' } as never,
    });
    // `/fast review 8` sends exactly this shape.
    const merged = updatePersistedConfig({ fast: { reviewEveryTurns: 8 } as never });
    expect(merged.fast.reviewEveryTurns).toBe(8);
    // Without the second merge site these three would be gone, and the tier the
    // user configured would be off on the next launch with nothing saying why.
    expect(merged.fast.enabled).toBe(true);
    expect(merged.fast.model).toBe('claude-haiku-4-5');
    expect(merged.fast.provider).toBe('anthropic');

    // And it SURVIVES a reload, which is what "my setting won't stick" is about.
    expect(loadPersistedConfig().fast.enabled).toBe(true);
  });

  it('clamps on the WRITE path too, so a bad value never reaches disk', () => {
    const merged = updatePersistedConfig({ fast: { reviewEveryTurns: 999 } as never });
    expect(merged.fast.reviewEveryTurns).toBe(50);
    expect(loadPersistedConfig().fast.reviewEveryTurns).toBe(50);
  });

  it('`/fast budget 9999` lands CLAMPED on disk, not reverted on every launch', () => {
    // The whole reason `clampFastConfig` gates the write path as well as the
    // read: hardening only the read leaves a bad value on disk that resolves to
    // the default on each launch, which presents to the user as "my setting
    // won't stick".
    const merged = updatePersistedConfig({ fast: { reviewMaxPerSession: 9999 } as never });
    expect(merged.fast.reviewMaxPerSession).toBe(500);
    expect(loadPersistedConfig().fast.reviewMaxPerSession).toBe(500);
  });
});

describe('config set fast.* coverage', () => {
  // `aragon config set` is the third configuration surface, beside the file and
  // `/fast` - and the round-2 key reached the first two while missing this one,
  // because nothing asserted the pairing. `retry` and `team` both carry this
  // guard already; `fast` did not, which is exactly why the gap was silent: a
  // key absent from the list is rejected as unknown, and a key present in the
  // list but absent from the switch prints `Set fast.x = y` and writes nothing.
  it('every declared key produces a patch (a listed-but-unhandled key writes nothing)', () => {
    for (const key of FAST_CONFIG_SET_KEYS) {
      expect(applyFastConfigSet(key, '1'), key).not.toBeNull();
    }
    expect(applyFastConfigSet('fast.nope', '1')).toBeNull();
    expect(applyFastConfigSet('retry.maxRetries', '1')).toBeNull();
  });

  it('declares one key per `FastConfig` field, so a new key cannot be half-added', () => {
    expect([...FAST_CONFIG_SET_KEYS].sort()).toEqual(
      Object.keys(DEFAULT_FAST_CONFIG)
        .map((field) => `fast.${field}`)
        .sort(),
    );
  });

  it('echoes the CLAMPED value rather than the input (AC-13)', () => {
    const merged = updatePersistedConfig(applyFastConfigSet('fast.reviewMaxPerSession', '9999')!);
    expect(merged.fast.reviewMaxPerSession).toBe(500);
    expect(loadPersistedConfig().fast.reviewMaxPerSession).toBe(500);
  });
});

describe('the settings row round-trips (AC-H18 / hardening §4.4)', () => {
  // THE SILENT HALF OF ADDING A ROW IS THE SEED, NOT THE DESCRIPTOR. A row added
  // to `FIELDS` and `SettingsValues` alone compiles, renders and then writes the
  // clamp's default over the user's value on the next untouched save, because
  // `fastSettingsFrom` never put the persisted value in the field. That is why
  // this asserts the round trip rather than either half of it.
  it('seeds the persisted value and preserves it through an untouched save', () => {
    const fast = clampFastConfig({ ...DEFAULT_FAST_CONFIG, reviewMaxPerSession: 120 });
    const seeded = fastSettingsFrom(fast);
    expect(seeded.fastReviewBudget).toBe('120');

    const patch = readFastSettings(seeded);
    expect(patch.reviewMaxPerSession).toBe(120);
    expect(clampFastConfig({ ...fast, ...patch }).reviewMaxPerSession).toBe(120);
  });

  it('sends an out-of-range entry through the SAME clamp a hand-edited file gets', () => {
    const seeded = { ...fastSettingsFrom(DEFAULT_FAST_CONFIG), fastReviewBudget: '9999' };
    const patch = readFastSettings(seeded);
    // No second validation policy in the screen: the row hands the number over
    // and `REVIEW_SESSION_RANGE` decides, exactly as for `config.json`.
    expect(clampFastConfig({ ...DEFAULT_FAST_CONFIG, ...patch }).reviewMaxPerSession).toBe(500);
  });

  it('a typo changes NOTHING, the discipline the other text rows follow', () => {
    const seeded = { ...fastSettingsFrom(DEFAULT_FAST_CONFIG), fastReviewBudget: 'soon' };
    const patch = readFastSettings(seeded);
    expect(patch.reviewMaxPerSession).toBeUndefined();
    const merged = clampFastConfig({ ...DEFAULT_FAST_CONFIG, reviewMaxPerSession: 7, ...patch });
    expect(merged.reviewMaxPerSession).toBe(7);
  });
});

describe('resolveFastConfig - defaults > file > env > flags (§3.7)', () => {
  it('AC-8: `--no-fast` beats a config file that turned the tier on', () => {
    updatePersistedConfig({ fast: { enabled: true, model: 'haiku' } as never });
    expect(loadConfig({ cwd: HOME }).fast.enabled).toBe(true);
    // `!== undefined` on the flag is what makes this work (C-9): commander
    // materialises a lone `--no-fast` as `opts.fast = true` when ABSENT, so a
    // truthiness check could not tell the two apart.
    expect(loadConfig({ cwd: HOME, fast: false }).fast.enabled).toBe(false);
  });

  it('AC-8: `--fast` beats a config file with the tier off', () => {
    updatePersistedConfig({ fast: { enabled: false, model: 'haiku' } as never });
    expect(loadConfig({ cwd: HOME, fast: true }).fast.enabled).toBe(true);
  });

  it('AC-9: `ARAGON_FAST=1 ARAGON_FAST_MODEL=x` resolves with no flag and no file', () => {
    process.env.ARAGON_FAST = '1';
    process.env.ARAGON_FAST_MODEL = 'claude-haiku-4-5';
    const cfg = loadConfig({ cwd: HOME });
    expect(cfg.fast.enabled).toBe(true);
    expect(cfg.fast.model).toBe('claude-haiku-4-5');
  });

  it('the env section is ACCUMULATED AND ASSIGNED ONCE, so `enabled` survives', () => {
    // Two separate assignments would compile clean and drop `enabled` — the
    // P1-4 defect `env.ts` records for `todo`.
    process.env.ARAGON_FAST = '1';
    process.env.ARAGON_FAST_PROVIDER = 'openai';
    process.env.ARAGON_FAST_MODEL = 'gpt-5-mini';
    process.env.ARAGON_FAST_BASE_URL = 'https://gw.example';
    const cfg = loadConfig({ cwd: HOME });
    expect(cfg.fast).toMatchObject({
      enabled: true,
      provider: 'openai',
      model: 'gpt-5-mini',
      baseUrl: 'https://gw.example',
    });
  });

  it('`ARAGON_FAST=0` turns it off, by the POSITIVE list', () => {
    updatePersistedConfig({ fast: { enabled: true, model: 'h' } as never });
    process.env.ARAGON_FAST = '0';
    expect(loadConfig({ cwd: HOME }).fast.enabled).toBe(false);
  });

  it('`--fast-model` / `--fast-provider` reach the resolved config', () => {
    const cfg = loadConfig({ cwd: HOME, fastModel: 'haiku', fastProvider: 'anthropic' });
    expect(cfg.fast.model).toBe('haiku');
    expect(cfg.fast.provider).toBe('anthropic');
    // ...and imply nothing about `enabled`, which is the flag's documented
    // contract: pass `--fast` too, or set it in the file.
    expect(cfg.fast.enabled).toBe(false);
  });

  it('`--fast-review off` and `--fast-review <n>` map onto the two review keys', () => {
    expect(loadConfig({ cwd: HOME, fastReview: 'off' }).fast.review).toBe(false);
    const cfg = loadConfig({ cwd: HOME, fastReview: '9' });
    expect(cfg.fast.review).toBe(true);
    expect(cfg.fast.reviewEveryTurns).toBe(9);
  });

  it('an unparseable `--fast-review` changes NOTHING (the clamp discipline)', () => {
    updatePersistedConfig({ fast: { reviewEveryTurns: 7 } as never });
    const cfg = loadConfig({ cwd: HOME, fastReview: 'soon' });
    expect(cfg.fast.reviewEveryTurns).toBe(7);
    expect(cfg.fast.review).toBe(true);
  });

  // ── `--fast-delegate` / `--no-fast-delegate`
  //    (web-use-tier-cooperation-and-control-closure §4.1.5) ─────────────────

  it('`--fast-delegate` and `--no-fast-delegate` both reach `fast.delegate`', () => {
    expect(loadConfig({ cwd: HOME, fastDelegate: true }).fast.delegate).toBe(true);
    expect(loadConfig({ cwd: HOME, fastDelegate: false }).fast.delegate).toBe(false);
  });

  /**
   * THE REVERSE ASSERTION, AND IT IS THE ONE THAT MATTERS (invariant 4).
   *
   * `fast.delegate` is persisted and defaults to TRUE. If the option pair were
   * declared negative-first, commander would materialise `opts.fastDelegate` as
   * `true` on every run that passed no flag at all, `resolveFastConfig`'s
   * `!== undefined` would fire, and a user's stored `false` would be silently
   * overwritten on EVERY run — the exact failure `--update` and `--compaction`
   * each record. Only this direction catches it.
   */
  it('passing NEITHER form preserves a stored `delegate: false`', () => {
    updatePersistedConfig({ fast: { delegate: false } as never });
    expect(loadConfig({ cwd: HOME }).fast.delegate).toBe(false);
    // And an explicit positive still wins over the file, as the layer order says.
    expect(loadConfig({ cwd: HOME, fastDelegate: true }).fast.delegate).toBe(true);
  });
});

afterEach(() => {
  // Leave the file at defaults so the next case starts clean.
  updatePersistedConfig({ fast: DEFAULT_FAST_CONFIG });
});

process.on('exit', () => {
  rmSync(HOME, { recursive: true, force: true });
});
