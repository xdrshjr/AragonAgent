/**
 * The todo config section (AC-35, AC-44).
 *
 * AC-35 IS THE MOST IMPORTANT TEST IN THIS FEATURE, and it is worth saying why.
 * `config/store.ts` merges its nested sections BY HAND, once on the read path
 * and once on the write path. Omit the write-path line and `/todo panel off`
 * sends `{ todo: { panel: false } }`, the shallow top-level spread REPLACES the
 * whole section, `enabled` is written to disk as ABSENT — and on the next launch
 * `todo_write` is not registered at all, because the user turned a *panel* off.
 * No crash, no log line, no notice. Both directions are asserted separately
 * because they are two separate merges.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

// Point the user-state root at a throwaway temp directory BEFORE importing the
// config modules — `app-paths.ts` resolves it once, at module load.
const TMP = mkdtempSync(join(tmpdir(), 'aragon-todo-cfg-'));
process.env.ARAGON_HOME = TMP;

const { loadConfig } = await import('../config/load.js');
const { updatePersistedConfig, loadPersistedConfig, getConfigPath } = await import(
  '../config/store.js'
);
const { clampTodoConfig, DEFAULT_TODO_CONFIG } = await import('../config/schema.js');

function clearEnv(): void {
  for (const key of Object.keys(process.env)) {
    // ARAGON_HOME IS EXEMPT AND MUST STAY EXEMPT: it is this file's only
    // isolation mechanism.
    if (key === 'ARAGON_HOME') continue;
    if (key.startsWith('ARAGON_') || key.endsWith('_API_KEY')) delete process.env[key];
  }
}

beforeEach(() => {
  clearEnv();
  rmSync(getConfigPath(), { force: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function writeConfig(todo: Record<string, unknown>): void {
  writeFileSync(getConfigPath(), JSON.stringify({ todo }), 'utf-8');
}

describe('clampTodoConfig', () => {
  it('defaults both keys to ON, and falls back for junk rather than throwing', () => {
    expect(loadConfig({ cwd: TMP }).todo).toEqual(DEFAULT_TODO_CONFIG);
    for (const junk of [undefined, null, 'nope', 42, []]) {
      expect(clampTodoConfig(junk)).toEqual(DEFAULT_TODO_CONFIG);
    }
  });

  it('keeps the two keys INDEPENDENT (D-16)', () => {
    // A screen-reader user wants the planning discipline without the column, and
    // that is the whole reason `panel` is not folded into `enabled`.
    expect(clampTodoConfig({ enabled: true, panel: false })).toEqual({
      enabled: true,
      panel: false,
      followThrough: 'notify',
    });
    expect(clampTodoConfig({ enabled: false, panel: true })).toEqual({
      enabled: false,
      panel: true,
      followThrough: 'notify',
    });
  });
});

describe('AC-35: BOTH hand-written merges know about the todo section (P0-1)', () => {
  it('the WRITE path: a panel-only patch does not wipe `enabled`', () => {
    updatePersistedConfig({ todo: { enabled: true, panel: true, followThrough: 'notify' } });
    const merged = updatePersistedConfig({ todo: { panel: false } as never });
    // The THIRD key rides the same merge, which is the point of keeping this
    // section flat and scalars-only (todo-plan-followthrough §4.1 / AC-6).
    expect(merged.todo).toEqual({ enabled: true, panel: false, followThrough: 'notify' });
    expect(loadPersistedConfig().todo).toEqual({
      enabled: true,
      panel: false,
      followThrough: 'notify',
    });
  });

  it('the READ path: a file holding only `panel` still resolves `enabled: true`', () => {
    // This is the launch after `/todo panel off`. Without the read-path merge,
    // `config.todo.enabled` is `undefined`, `todoRegistered` is false, and the
    // tool silently disappears.
    writeFileSync(getConfigPath(), JSON.stringify({ todo: { panel: false } }), 'utf-8');
    const expected = { enabled: true, panel: false, followThrough: 'notify' };
    expect(loadPersistedConfig().todo).toEqual(expected);
    expect(loadConfig({ cwd: TMP }).todo).toEqual(expected);
  });

  it('clamps on the WRITE path too, so a bad value never reaches disk', () => {
    updatePersistedConfig({ todo: { enabled: 'yes' } as never });
    expect(loadPersistedConfig().todo.enabled).toBe(DEFAULT_TODO_CONFIG.enabled);
  });
});

describe('AC-44: resolution order, defaults > file > env > flags', () => {
  it('--todo, --no-todo and "not passed" are THREE distinct outcomes', () => {
    writeConfig({ enabled: true });
    expect(loadConfig({ cwd: TMP }).todo.enabled).toBe(true);
    expect(loadConfig({ cwd: TMP, todo: false }).todo.enabled).toBe(false);

    writeConfig({ enabled: false });
    expect(loadConfig({ cwd: TMP }).todo.enabled).toBe(false);
    expect(loadConfig({ cwd: TMP, todo: true }).todo.enabled).toBe(true);
  });

  it('a stored `panel: false` SURVIVES a run that passed no flag at all (P1-8)', () => {
    // `commander` materializes a lone `--no-x` as `opts.x = true` when the flag
    // is absent, so a truthiness test would overwrite the user's stored
    // preference on every single run. This is the assertion that pins the pair.
    writeConfig({ panel: false });
    expect(loadConfig({ cwd: TMP }).todo.panel).toBe(false);
    expect(loadConfig({ cwd: TMP, todoPanel: true }).todo.panel).toBe(true);
    expect(loadConfig({ cwd: TMP, todoPanel: false }).todo.panel).toBe(false);
  });

  it('ARAGON_TODO uses the POSITIVE list, matching ARAGON_TEAM / ARAGON_PLAN', () => {
    // The negative-list `envBool` in the same file disagrees on
    // `ARAGON_TODO=disable`; copying the wrong reader ships a
    // documented-but-dead env var.
    for (const on of ['1', 'true', 'on', 'yes']) {
      process.env.ARAGON_TODO = on;
      expect(loadConfig({ cwd: TMP }).todo.enabled, on).toBe(true);
    }
    for (const off of ['0', 'false', 'off', 'no', 'disable', 'anything-else']) {
      process.env.ARAGON_TODO = off;
      expect(loadConfig({ cwd: TMP }).todo.enabled, off).toBe(false);
    }
  });

  it('a flag beats the env var, which beats the file', () => {
    writeConfig({ enabled: true });
    process.env.ARAGON_TODO = '0';
    expect(loadConfig({ cwd: TMP }).todo.enabled).toBe(false);
    expect(loadConfig({ cwd: TMP, todo: true }).todo.enabled).toBe(true);
  });

  it('the env var never touches `panel`, so the display preference stays local', () => {
    writeConfig({ panel: false });
    process.env.ARAGON_TODO = '1';
    expect(loadConfig({ cwd: TMP }).todo).toEqual({
      enabled: true,
      panel: false,
      followThrough: 'notify',
    });
  });
});

describe('followThrough (todo-plan-followthrough §4.1 / §4.2)', () => {
  it('AC-4: a config file written before this round loads with `notify`', () => {
    // The whole of D-2: this round changes nothing for anyone who does not ask
    // for it, and that is assertable rather than asserted.
    writeConfig({ enabled: true, panel: true });
    expect(loadConfig({ cwd: TMP }).todo.followThrough).toBe('notify');
  });

  it('AC-5: an unrecognized value is CLAMPED to the default, never rejected', () => {
    for (const junk of ['garbage', '', 'AUTO', 42, null, {}]) {
      expect(clampTodoConfig({ followThrough: junk }).followThrough).toBe('notify');
    }
    process.env.ARAGON_TODO_FOLLOW = 'garbage';
    expect(() => loadConfig({ cwd: TMP })).not.toThrow();
    expect(loadConfig({ cwd: TMP }).todo.followThrough).toBe('notify');
  });

  it('accepts all three real modes from the file', () => {
    for (const mode of ['notify', 'auto', 'off'] as const) {
      writeConfig({ followThrough: mode });
      expect(loadConfig({ cwd: TMP }).todo.followThrough).toBe(mode);
    }
  });

  it('AC-39 (P1-4): ARAGON_TODO and ARAGON_TODO_FOLLOW ACCUMULATE', () => {
    // The defect this pins: `env.ts` used to end its todo block with
    // `partial.todo = { enabled } as PersistedConfig['todo']`, and THE CAST IS
    // WHAT MAKES A SECOND ASSIGNMENT SILENT — it compiles clean and drops
    // `enabled`, so this exact pair would quietly re-enable the tool the user
    // turned off.
    process.env.ARAGON_TODO = '0';
    process.env.ARAGON_TODO_FOLLOW = 'auto';
    const both = loadConfig({ cwd: TMP }).todo;
    expect(both.enabled).toBe(false);
    expect(both.followThrough).toBe('auto');
  });

  it('AC-39: each var alone resolves the other key from the defaults', () => {
    process.env.ARAGON_TODO_FOLLOW = 'off';
    const followOnly = loadConfig({ cwd: TMP }).todo;
    expect(followOnly.followThrough).toBe('off');
    expect(followOnly.enabled).toBe(true);

    delete process.env.ARAGON_TODO_FOLLOW;
    process.env.ARAGON_TODO = '0';
    const todoOnly = loadConfig({ cwd: TMP }).todo;
    expect(todoOnly.enabled).toBe(false);
    expect(todoOnly.followThrough).toBe('notify');
  });

  it('the env var does not clobber a file value the user did not override', () => {
    writeConfig({ panel: false, followThrough: 'auto' });
    process.env.ARAGON_TODO = '1';
    const cfg = loadConfig({ cwd: TMP }).todo;
    expect(cfg.panel).toBe(false);
    expect(cfg.followThrough).toBe('auto');
  });

  it('`--todo-follow` beats the env var, which beats the file', () => {
    writeConfig({ followThrough: 'off' });
    expect(loadConfig({ cwd: TMP }).todo.followThrough).toBe('off');
    process.env.ARAGON_TODO_FOLLOW = 'notify';
    expect(loadConfig({ cwd: TMP }).todo.followThrough).toBe('notify');
    expect(loadConfig({ cwd: TMP, todoFollow: 'auto' }).todo.followThrough).toBe('auto');
  });

  it('AC-6: `/todo panel off` round-trips all THREE keys through both merges', () => {
    updatePersistedConfig({ todo: { enabled: true, panel: true, followThrough: 'auto' } });
    updatePersistedConfig({ todo: { panel: false } as never });
    expect(loadPersistedConfig().todo).toEqual({
      enabled: true,
      panel: false,
      followThrough: 'auto',
    });
    expect(loadConfig({ cwd: TMP }).todo.followThrough).toBe('auto');
  });

  it('clamps on the WRITE path too, so a bad mode never reaches disk', () => {
    updatePersistedConfig({ todo: { followThrough: 'sideways' } as never });
    expect(loadPersistedConfig().todo.followThrough).toBe('notify');
  });
});
