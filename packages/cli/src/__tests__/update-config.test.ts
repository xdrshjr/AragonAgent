/**
 * The `update` config section: clamp, BOTH merge halves, and the four
 * resolution layers (cli-auto-update §4.1 / §4.2 / AC-20).
 *
 * THE ROUND TRIP THROUGH `updatePersistedConfig` IS THE POINT (C-4 / R-10).
 * `store.ts` merges nested sections BY HAND in TWO places, and omitting the
 * write half is silent: `config set update.mode notify` sends
 * `{ update: { mode: 'notify' } }`, a shallow top-level spread replaces the
 * whole section, and the enterprise mirror the user configured last month is
 * gone with no error anywhere. This package has paid for that twice already —
 * `todo` P0-1 and `fast` R-10 — so a third feature adding a section without this
 * test would be repeating a known, named bug.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const HOME = mkdtempSync(join(tmpdir(), 'aragon-update-config-'));
process.env.ARAGON_HOME = HOME;

const { clampUpdateConfig, DEFAULT_UPDATE_CONFIG } = await import('../config/schema.js');
const { applyUpdateConfigSet, UPDATE_CONFIG_SET_KEYS } = await import(
  '../config/cli-commands.js'
);
const { loadPersistedConfig, updatePersistedConfig, writeConfigFile } = await import(
  '../config/store.js'
);
const { loadConfig } = await import('../config/load.js');

const ENV_KEYS = ['ARAGON_UPDATE', 'ARAGON_UPDATE_REGISTRY', 'npm_config_registry'];

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  writeConfigFile(loadPersistedConfig());
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  rmSync(join(HOME, 'config.json'), { force: true });
});

describe('clampUpdateConfig — one gate for both directions', () => {
  it('supplies every default from an empty object', () => {
    expect(clampUpdateConfig({})).toEqual(DEFAULT_UPDATE_CONFIG);
    expect(clampUpdateConfig(undefined)).toEqual(DEFAULT_UPDATE_CONFIG);
    expect(clampUpdateConfig('nonsense')).toEqual(DEFAULT_UPDATE_CONFIG);
  });

  it('accepts the three modes and clamps anything else to the default', () => {
    for (const mode of ['auto', 'notify', 'off'] as const) {
      expect(clampUpdateConfig({ mode }).mode).toBe(mode);
    }
    // Clamped rather than rejected, like `theme` and `skills.integrity`:
    // hardening only the read path leaves a bad value on disk that reverts on
    // every launch, which presents as "my setting won't stick".
    expect(clampUpdateConfig({ mode: 'disabled' }).mode).toBe('auto');
    expect(clampUpdateConfig({ mode: 42 }).mode).toBe('auto');
  });

  it('clamps the interval to [15 minutes, 7 days]', () => {
    expect(clampUpdateConfig({ checkIntervalMs: 5 }).checkIntervalMs).toBe(900_000);
    expect(clampUpdateConfig({ checkIntervalMs: 999_999_999_999 }).checkIntervalMs).toBe(
      604_800_000,
    );
    expect(clampUpdateConfig({ checkIntervalMs: 3_600_000 }).checkIntervalMs).toBe(3_600_000);
  });

  it('empties a registry that is not an http(s) URL', () => {
    // `''` means "derive it" (§3.3), which is the safe reading of a typo: the
    // alternative is a background timer that throws on a value the user cannot
    // see it reading.
    expect(clampUpdateConfig({ registry: 'https://mirror.example.com' }).registry).toBe(
      'https://mirror.example.com',
    );
    expect(clampUpdateConfig({ registry: 'http://npm.internal' }).registry).toBe(
      'http://npm.internal',
    );
    for (const bad of ['file:///etc/passwd', 'ftp://x', 'registry.npmjs.org', '  ']) {
      expect(clampUpdateConfig({ registry: bad }).registry, bad).toBe('');
    }
  });

  it('rejects a dist-tag that is not one', () => {
    expect(clampUpdateConfig({ distTag: 'next' }).distTag).toBe('next');
    for (const bad of ['a/b', 'has space', '@scope', '', '-leading']) {
      expect(clampUpdateConfig({ distTag: bad }).distTag, JSON.stringify(bad)).toBe('latest');
    }
  });
});

describe('AC-20: BOTH halves of store.ts merge and clamp the section', () => {
  it('a partial patch does not erase the rest of the section (the WRITE half)', () => {
    // The half that bites. Without it, changing the mode silently reverts the
    // interval, the mirror and the dist-tag.
    updatePersistedConfig({
      update: {
        mode: 'auto',
        checkIntervalMs: 3_600_000,
        registry: 'https://mirror.example.com',
        distTag: 'next',
      },
    });
    updatePersistedConfig({ update: { mode: 'notify' } as never });

    const stored = loadPersistedConfig().update;
    expect(stored.mode).toBe('notify');
    expect(stored.checkIntervalMs).toBe(3_600_000);
    expect(stored.registry).toBe('https://mirror.example.com');
    expect(stored.distTag).toBe('next');
  });

  it('a config file with NO update key still resolves a full section (the READ half)', () => {
    // Which is every user whose `config.json` predates this feature. Without the
    // read merge `config.update.mode` is `undefined`, and the §3.8 gate tests
    // `!== 'off'` — so the feature would be ON for a reason nobody could point at.
    const raw = loadPersistedConfig();
    const withoutUpdate = { ...raw } as Record<string, unknown>;
    delete withoutUpdate.update;
    writeConfigFile(withoutUpdate as never);
    expect(loadPersistedConfig().update).toEqual(DEFAULT_UPDATE_CONFIG);
  });

  it('writes the CLAMPED value, not the typed one', () => {
    updatePersistedConfig({ update: { checkIntervalMs: 5 } as never });
    expect(loadPersistedConfig().update.checkIntervalMs).toBe(900_000);
  });
});

describe('applyUpdateConfigSet', () => {
  it('produces a patch for every advertised key and null for anything else', () => {
    for (const key of UPDATE_CONFIG_SET_KEYS) {
      // Membership in the set only decides that the key is NOT REJECTED; the
      // setter is what builds the patch, and a key present in one and absent
      // from the other writes nothing while still printing `Set update.x = y`.
      expect(applyUpdateConfigSet(key, 'notify'), key).not.toBeNull();
    }
    expect(applyUpdateConfigSet('update.nope', 'x')).toBeNull();
    expect(applyUpdateConfigSet('fast.model', 'x')).toBeNull();
  });

  it('clamps through the same gate, so config set cannot store an out-of-range value', () => {
    const patch = applyUpdateConfigSet('update.checkIntervalMs', '5');
    expect((patch?.update as { checkIntervalMs: number }).checkIntervalMs).toBe(900_000);
  });

  it('names exactly the four keys of §4.1 — no more (D-16)', () => {
    expect([...UPDATE_CONFIG_SET_KEYS].sort()).toEqual([
      'update.checkIntervalMs',
      'update.distTag',
      'update.mode',
      'update.registry',
    ]);
  });
});

describe('resolution: defaults › file › env › flags (§4.2)', () => {
  it('the config file wins over the default', () => {
    updatePersistedConfig({ update: { mode: 'notify' } as never });
    expect(loadConfig({}).update.mode).toBe('notify');
  });

  it('ARAGON_UPDATE beats the file, in all three directions', () => {
    updatePersistedConfig({ update: { mode: 'auto' } as never });
    for (const [value, expected] of [
      ['0', 'off'],
      ['off', 'off'],
      ['false', 'off'],
      ['no', 'off'],
      ['notify', 'notify'],
      ['1', 'auto'],
      ['on', 'auto'],
      ['true', 'auto'],
      ['yes', 'auto'],
    ] as const) {
      process.env.ARAGON_UPDATE = value;
      expect(loadConfig({}).update.mode, value).toBe(expected);
    }
  });

  it('an UNRECOGNISED ARAGON_UPDATE is left ABSENT, so the file still wins', () => {
    // The invariant `config/env.ts` states three times over. For a KILL SWITCH
    // it is the worst possible failure to get wrong: `ARAGON_UPDATE=disabled`
    // must not read as "on" while the user believes they turned it off, and it
    // must not read as a permanently-supplied default that masks the file.
    updatePersistedConfig({ update: { mode: 'notify' } as never });
    for (const junk of ['disable', 'disabled', 'maybe', 'OFFF']) {
      process.env.ARAGON_UPDATE = junk;
      expect(loadConfig({}).update.mode, junk).toBe('notify');
    }
  });

  it('--no-update beats everything, and --update beats a stored off', () => {
    updatePersistedConfig({ update: { mode: 'auto' } as never });
    process.env.ARAGON_UPDATE = '1';
    expect(loadConfig({ update: false }).update.mode).toBe('off');

    updatePersistedConfig({ update: { mode: 'off' } as never });
    delete process.env.ARAGON_UPDATE;
    expect(loadConfig({ update: true }).update.mode).toBe('auto');
  });

  it('NO FLAG leaves a stored `off` alone (C-11 — the pair is why)', () => {
    // Commander materialises a lone `--no-update` as `opts.update = true` when
    // the flag is ABSENT, so a truthiness check in `resolveUpdateConfig` could
    // not tell `--no-update` from "not passed" and would silently re-enable a
    // subsystem the user turned off, on every run that passed no flag at all.
    updatePersistedConfig({ update: { mode: 'off' } as never });
    expect(loadConfig({}).update.mode).toBe('off');
  });

  it('the registry env vars do NOT enter the config layer (§3.3 precedence)', () => {
    // They sit BELOW `config.update.registry`, which is the opposite of the
    // env-beats-file rule this layer implements — so they are resolved by
    // `resolveRegistryUrl` instead. Writing them here would silently invert the
    // order and make a config-file mirror unreachable on any machine where npm
    // exports its own registry, which is every machine npm runs a script on.
    process.env.ARAGON_UPDATE_REGISTRY = 'https://env.example.com';
    process.env.npm_config_registry = 'https://npm.example.com';
    updatePersistedConfig({ update: { registry: 'https://file.example.com' } as never });
    expect(loadConfig({}).update.registry).toBe('https://file.example.com');
  });
});
