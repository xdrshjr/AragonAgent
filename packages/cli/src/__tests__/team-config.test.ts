import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

// Point the user-state root at a throwaway temp directory BEFORE importing the
// config modules — `app-paths.ts` resolves it once, at module load, so this
// suite never touches the developer's real `~/.aragon-agent`.
const TMP = mkdtempSync(join(tmpdir(), 'aragon-team-cfg-'));
process.env.ARAGON_HOME = TMP;

const { loadConfig } = await import('../config/load.js');
const { updatePersistedConfig, loadPersistedConfig, getConfigPath } = await import(
  '../config/store.js'
);
const {
  clampTeamConfig,
  DEFAULT_FAST_CONFIG,
  DEFAULT_TEAM_CONFIG,
  HARD_MAX_SUBAGENTS,
  LEGACY_TEAM_CEILING_DEFAULTS,
  legacyTeamCeilingPatch,
} = await import('../config/schema.js');
const { applyTeamConfigSet, TEAM_CONFIG_SET_KEYS } = await import('../config/cli-commands.js');
const { CommandRegistry } = await import('../commands/registry.js');
type CommandContext = import('../commands/registry.js').CommandContext;
const { registerBuiltinCommands } = await import('../commands/builtins.js');
const { resolveSubagentModel } = await import('../team/model.js');
type CliConfig = import('../config/schema.js').CliConfig;
type TeamConfigShape = ReturnType<typeof clampTeamConfig>;
type AgentController = import('../agent/controller.js').AgentController;

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

function writeConfig(team: Record<string, unknown>): void {
  writeFileSync(getConfigPath(), JSON.stringify({ team }), 'utf-8');
}

describe('clampTeamConfig', () => {
  it('AC-2: with no config file, team mode is ON (R-b)', () => {
    expect(loadConfig({ cwd: TMP }).team.enabled).toBe(true);
    expect(loadConfig({ cwd: TMP }).team.maxSubagents).toBe(5);
  });

  it('AC-7: a hand-edited maxSubagents of 40 resolves to 10, not 40 (R-g)', () => {
    // The requirement caps the fan-out at 10, so a config file must not be able
    // to raise it. `normalizeSubagentSpecs` enforces the same ceiling again on
    // what the model asks for.
    writeConfig({ maxSubagents: 40 });
    expect(loadConfig({ cwd: TMP }).team.maxSubagents).toBe(HARD_MAX_SUBAGENTS);
    expect(clampTeamConfig({ maxSubagents: 999 }).maxSubagents).toBe(HARD_MAX_SUBAGENTS);
    expect(clampTeamConfig({ maxSubagents: 11 }).maxSubagents).toBe(HARD_MAX_SUBAGENTS);
    expect(clampTeamConfig({ maxSubagents: 1 }).maxSubagents).toBe(1);
    // `0` and negatives read as "not set" rather than as a floor, because every
    // numeric field in this file goes through `coercePositiveInt`. A `0` that
    // resolved to 1 would be a second, silent way to spell "one subagent".
    expect(clampTeamConfig({ maxSubagents: 0 }).maxSubagents).toBe(
      DEFAULT_TEAM_CONFIG.maxSubagents,
    );
    expect(clampTeamConfig({ maxSubagents: -3 }).maxSubagents).toBe(
      DEFAULT_TEAM_CONFIG.maxSubagents,
    );
  });

  it('caps maxConcurrent at maxSubagents', () => {
    // A pool wider than the population it draws from is meaningless, and letting
    // them disagree makes the panel's `n/m` readout confusing for no gain.
    expect(clampTeamConfig({ maxSubagents: 2, maxConcurrent: 9 }).maxConcurrent).toBe(2);
    expect(clampTeamConfig({ maxSubagents: 8, maxConcurrent: 3 }).maxConcurrent).toBe(3);
  });

  it('keeps an explicit 0: the documented off switch for each ceiling', () => {
    // Main-agent parity: 0 means NO limit, and a clamp that folds 0 back to
    // the old default is the `scrollResumeMs` trap - "my setting won't stick".
    const zeroed = clampTeamConfig({
      subagentTimeoutMs: 0,
      dispatchTimeoutMs: 0,
      maxTurnsPerSubagent: 0,
    });
    expect(zeroed.subagentTimeoutMs).toBe(0);
    expect(zeroed.dispatchTimeoutMs).toBe(0);
    expect(zeroed.maxTurnsPerSubagent).toBe(0);
  });

  it('clamps the timeout range and the turn cap from ABOVE only', () => {
    const low = clampTeamConfig({
      subagentTimeoutMs: 5_000,
      dispatchTimeoutMs: 10_000,
      maxTurnsPerSubagent: 2,
    });
    expect(low.subagentTimeoutMs).toBe(5_000);
    expect(low.dispatchTimeoutMs).toBe(10_000);
    expect(low.maxTurnsPerSubagent).toBe(2);

    const high = clampTeamConfig({
      subagentTimeoutMs: 99_000_000,
      dispatchTimeoutMs: 99_000_000,
      maxTurnsPerSubagent: 9999,
    });
    expect(high.subagentTimeoutMs).toBe(1_800_000);
    expect(high.dispatchTimeoutMs).toBe(3_600_000);
    expect(high.maxTurnsPerSubagent).toBe(100);
  });

  it('falls back to the defaults for junk rather than throwing', () => {
    for (const junk of [undefined, null, 'nope', 42, []]) {
      expect(clampTeamConfig(junk)).toEqual(DEFAULT_TEAM_CONFIG);
    }
  });
});

describe('the team section is deep-merged on write (§3.10)', () => {
  it('a partial patch does not wipe the rest of the section', () => {
    // The symptom of a shallow merge would be "changing the fan-out width
    // silently reverted every timeout", with nothing anywhere explaining it —
    // the same failure `/skills disable` records for the skills section.
    updatePersistedConfig({ team: { ...DEFAULT_TEAM_CONFIG, subagentTimeoutMs: 600_000 } });
    updatePersistedConfig({ team: { maxSubagents: 4 } as never });
    const stored = loadPersistedConfig().team;
    expect(stored.maxSubagents).toBe(4);
    expect(stored.subagentTimeoutMs).toBe(600_000);
  });

  it('clamps on the WRITE path too, so a bad value never reaches disk', () => {
    // Hardening only the read path leaves a bad value on disk that reverts on
    // every launch, which presents as "my setting won't stick".
    updatePersistedConfig({ team: { maxSubagents: 40 } as never });
    expect(loadPersistedConfig().team.maxSubagents).toBe(HARD_MAX_SUBAGENTS);
  });
});

describe('resolution order: defaults > file > env > flags', () => {
  it('P1-4: --team, --no-team and "not passed" are THREE distinct outcomes', () => {
    // A truthiness check cannot tell `--no-team` from silence, so `--no-team`
    // would resolve to the config file's value and the off switch would not be
    // off. `cli.tsx` records this exact failure for `--no-mouse`.
    writeConfig({ enabled: true });
    expect(loadConfig({ cwd: TMP }).team.enabled).toBe(true);
    expect(loadConfig({ cwd: TMP, team: false }).team.enabled).toBe(false);

    writeConfig({ enabled: false });
    expect(loadConfig({ cwd: TMP }).team.enabled).toBe(false);
    expect(loadConfig({ cwd: TMP, team: true }).team.enabled).toBe(true);
  });

  it('ARAGON_TEAM uses the POSITIVE list, matching ARAGON_FULLSCREEN / ARAGON_PLAN', () => {
    // The negative-list `envBool` in the same file disagrees on
    // `ARAGON_TEAM=disable`; copying the wrong reader ships a documented-but-dead
    // env var, which `load.ts` already records for `ARAGON_MOUSE`.
    for (const on of ['1', 'true', 'on', 'yes']) {
      process.env.ARAGON_TEAM = on;
      expect(loadConfig({ cwd: TMP }).team.enabled, on).toBe(true);
    }
    for (const off of ['0', 'false', 'off', 'no', 'disable', 'anything-else']) {
      process.env.ARAGON_TEAM = off;
      expect(loadConfig({ cwd: TMP }).team.enabled, off).toBe(false);
    }
  });

  it('a flag beats the env var, which beats the file', () => {
    writeConfig({ enabled: true, maxSubagents: 7 });
    process.env.ARAGON_TEAM = '0';
    expect(loadConfig({ cwd: TMP }).team.enabled).toBe(false);
    expect(loadConfig({ cwd: TMP, team: true }).team.enabled).toBe(true);

    process.env.ARAGON_TEAM_MAX = '2';
    expect(loadConfig({ cwd: TMP }).team.maxSubagents).toBe(2);
    expect(loadConfig({ cwd: TMP, teamMax: '9' }).team.maxSubagents).toBe(9);
    // ...and the flag is still clamped.
    expect(loadConfig({ cwd: TMP, teamMax: '40' }).team.maxSubagents).toBe(HARD_MAX_SUBAGENTS);
  });

  it('an unparseable ARAGON_TEAM_MAX is left ABSENT so the file can still win', () => {
    writeConfig({ maxSubagents: 7 });
    process.env.ARAGON_TEAM_MAX = 'lots';
    expect(loadConfig({ cwd: TMP }).team.maxSubagents).toBe(7);
  });

  it('the other four keys are file-only tuning knobs', () => {
    writeConfig({ maxConcurrent: 2, subagentTimeoutMs: 45_000 });
    const resolved = loadConfig({ cwd: TMP }).team;
    expect(resolved.maxConcurrent).toBe(2);
    expect(resolved.subagentTimeoutMs).toBe(45_000);
  });
});

describe('aragon config set team.*', () => {
  it('covers every key in TEAM_CONFIG_SET_KEYS, with no unhandled member', () => {
    // A key present in the membership set but absent from the translator falls
    // through, writes nothing, and still prints `Set team.enabled = false` —
    // exactly what happened to `density` / `hints` (P1-2 in cli.tsx).
    for (const key of TEAM_CONFIG_SET_KEYS) {
      expect(applyTeamConfigSet(key, '3'), key).not.toBeNull();
    }
    expect(applyTeamConfigSet('team.nope', '3')).toBeNull();
    expect(applyTeamConfigSet('log.level', 'debug')).toBeNull();
  });

  it('produces a PARTIAL section that the store deep-merges', () => {
    const patch = applyTeamConfigSet('team.maxConcurrent', '2');
    expect(patch).toEqual({ team: { maxConcurrent: 2 } });
  });

  it('parses booleans the same way every other config set key does', () => {
    expect(applyTeamConfigSet('team.enabled', 'true')).toEqual({ team: { enabled: true } });
    expect(applyTeamConfigSet('team.enabled', '1')).toEqual({ team: { enabled: true } });
    expect(applyTeamConfigSet('team.enabled', 'false')).toEqual({ team: { enabled: false } });
  });

  it('sets team.overseer - the shell surface the /team command also writes (team-overseer)', () => {
    // The slash command is the interactive surface; `config set` is the one
    // scripts and dotfile edits use. A supervisor key reachable from only
    // one of the two presents as "my setting won't stick" - the exact
    // failure the TEAM_CONFIG_SET_KEYS membership test above exists for.
    expect(applyTeamConfigSet('team.overseer', 'false')).toEqual({ team: { overseer: false } });
    expect(applyTeamConfigSet('team.overseer', 'true')).toEqual({ team: { overseer: true } });
    expect(applyTeamConfigSet('team.overseer', '1')).toEqual({ team: { overseer: true } });
  });
});

describe('team.overseer (team-overseer)', () => {
  it('defaults ON, and a hand-edited value round-trips through the clamp', () => {
    expect(DEFAULT_TEAM_CONFIG.overseer).toBe(true);
    expect(clampTeamConfig({}).overseer).toBe(true);
    expect(clampTeamConfig({ overseer: false }).overseer).toBe(false);
    expect(clampTeamConfig({ overseer: true }).overseer).toBe(true);
    // A non-boolean reads as not set (the `bool` helper rule), never as false:
    // a typo must not silently disarm the supervisor.
    expect(clampTeamConfig({ overseer: 'yes' }).overseer).toBe(true);
  });

  it('loads from disk with the default when the key is absent', () => {
    writeConfig({ maxSubagents: 3 });
    expect(loadConfig({ cwd: TMP }).team.overseer).toBe(true);
    writeConfig({ overseer: false });
    expect(loadConfig({ cwd: TMP }).team.overseer).toBe(false);
  });
});

describe('team.overseerIntervalMs (subagent-overseer-v2 D-8)', () => {
  it('defaults to 0 = the structural cadence, and 0 survives the clamp', () => {
    expect(DEFAULT_TEAM_CONFIG.overseerIntervalMs).toBe(0);
    expect(clampTeamConfig({}).overseerIntervalMs).toBe(0);
    expect(clampTeamConfig({ overseerIntervalMs: 0 }).overseerIntervalMs).toBe(0);
  });

  it('clamps from above at one hour, like dispatchTimeoutMs', () => {
    expect(clampTeamConfig({ overseerIntervalMs: 5_000 }).overseerIntervalMs).toBe(5_000);
    expect(clampTeamConfig({ overseerIntervalMs: 99_000_000 }).overseerIntervalMs).toBe(3_600_000);
    // A non-numeric reads as not set, never as a scary small interval.
    expect(clampTeamConfig({ overseerIntervalMs: 'soon' }).overseerIntervalMs).toBe(0);
  });

  it('loads from disk and survives a round-trip through the store', () => {
    writeConfig({ overseerIntervalMs: 600_000 });
    expect(loadConfig({ cwd: TMP }).team.overseerIntervalMs).toBe(600_000);
  });

  it('is reachable from `aragon config set`, clamped by the same gate', () => {
    expect(applyTeamConfigSet('team.overseerIntervalMs', '120000')).toEqual({
      team: { overseerIntervalMs: 120_000 },
    });
    expect(applyTeamConfigSet('team.overseerIntervalMs', '999999999')).toEqual({
      team: { overseerIntervalMs: 3_600_000 },
    });
    // 0 must stick: it is the documented "use the structural default".
    expect(applyTeamConfigSet('team.overseerIntervalMs', '0')).toEqual({
      team: { overseerIntervalMs: 0 },
    });
  });
});

describe('team.model / team.modelProfileId (subagent-model D-2 / matrix 18/26)', () => {
  it('defaults to main / null, and an absent key reads as the default (AC-1)', () => {
    expect(DEFAULT_TEAM_CONFIG.model).toBe('main');
    expect(DEFAULT_TEAM_CONFIG.modelProfileId).toBeNull();
    expect(clampTeamConfig({}).model).toBe('main');
    expect(clampTeamConfig({}).modelProfileId).toBeNull();
    writeConfig({ maxSubagents: 3 });
    expect(loadConfig({ cwd: TMP }).team.model).toBe('main');
    expect(loadConfig({ cwd: TMP }).team.modelProfileId).toBeNull();
  });

  it('an illegal enum falls back to main (typo changes nothing), legal values stick', () => {
    expect(clampTeamConfig({ model: 'fats' }).model).toBe('main');
    expect(clampTeamConfig({ model: 7 }).model).toBe('main');
    expect(clampTeamConfig({ model: 'fast' }).model).toBe('fast');
    expect(clampTeamConfig({ model: 'profile' }).model).toBe('profile');
  });

  it('a bad id is nulled, a legal id round-trips, and the budget is 128 codepoints', () => {
    expect(clampTeamConfig({ modelProfileId: 42 }).modelProfileId).toBeNull();
    expect(clampTeamConfig({ modelProfileId: 'p1' }).modelProfileId).toBe('p1');
    expect(clampTeamConfig({ modelProfileId: 'x'.repeat(128) }).modelProfileId)
      .toBe('x'.repeat(128));
    expect(clampTeamConfig({ modelProfileId: 'x'.repeat(129) }).modelProfileId).toBeNull();
  });

  it('loads from disk and survives a round-trip through the store', () => {
    writeConfig({ model: 'profile', modelProfileId: 'p1' });
    const loaded = loadConfig({ cwd: TMP });
    expect(loaded.team.model).toBe('profile');
    expect(loaded.team.modelProfileId).toBe('p1');
    updatePersistedConfig({ team: { maxSubagents: 2 } as never });
    const after = loadConfig({ cwd: TMP });
    // A partial write merges rather than wiping the section.
    expect(after.team.model).toBe('profile');
    expect(after.team.modelProfileId).toBe('p1');
    expect(after.team.maxSubagents).toBe(2);
  });

  it('is reachable from `aragon config set`, clamped by the same gate (V-3)', () => {
    expect(applyTeamConfigSet('team.model', 'fast')).toEqual({ team: { model: 'fast' } });
    expect(applyTeamConfigSet('team.model', 'profile')).toEqual({ team: { model: 'profile' } });
    expect(applyTeamConfigSet('team.model', 'main')).toEqual({ team: { model: 'main' } });
    // An illegal mode is clamped to main, never rejected.
    expect(applyTeamConfigSet('team.model', 'FATS')).toEqual({ team: { model: 'main' } });
    expect(applyTeamConfigSet('team.modelProfileId', '9f3c')).toEqual({
      team: { modelProfileId: '9f3c' },
    });
    expect(applyTeamConfigSet('team.modelProfileId', '')).toEqual({ team: { modelProfileId: null } });
    // A 129-codepoint id is nulled by the same 128 budget as the read path.
    expect(applyTeamConfigSet('team.modelProfileId', 'x'.repeat(129))).toEqual({
      team: { modelProfileId: null },
    });
  });
});

describe('/team model (subagent-model V-2 / AC-11)', () => {
  const profiles = { version: 1 as const, entries: [
    { id: 'p-upper', name: 'GPT-Fast', provider: 'openai', model: 'gpt-5-mini',
      baseUrl: null, apiKey: 'entry-key', contextWindow: null },
    { id: 'p-lower', name: 'gpt-fast', provider: 'google', model: 'gemini',
      baseUrl: null, apiKey: null, contextWindow: null },
  ], mainId: null, fastId: null };

  function harness(over: Record<string, unknown> = {}) {
    const applied: Array<Record<string, unknown>> = [];
    const persisted: Array<Record<string, unknown>> = [];
    const config = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      apiKeys: { anthropic: 'k', openai: 'k' },
      team: { ...DEFAULT_TEAM_CONFIG },
      fast: { ...DEFAULT_FAST_CONFIG },
      modelProfiles: profiles,
      ...over,
    } as unknown as CliConfig;
    const controller = {
      getConfig: () => config,
      getTeamConfig: () => config.team,
      setTeamConfig: (patch: Partial<TeamConfigShape>) => {
        config.team = clampTeamConfig({ ...config.team, ...patch });
        applied.push(patch as Record<string, unknown>);
        return config.team;
      },
      hasApiKey: () => true,
      isTeamRegistered: () => true,
      isTeamEnabled: () => true,
      isTeamBusy: () => false,
      getTeamSnapshot: () => null,
      subagentModelResolution: () => resolveSubagentModel(config, () => true),
    } as unknown as AgentController;
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const notify = vi.fn();
    const toast = vi.fn();
    const run = async (args: string): Promise<void> => {
      const ctx = { controller, args, notify, toast,
        persistConfig: (patch: unknown) => persisted.push(patch as Record<string, unknown>)
      } as unknown as CommandContext;
      await registry.get('team')!.run(ctx);
    };
    return { run, applied, persisted, notify, toast };
  }

  it('status appends the subagent model summary line', async () => {
    const view = harness();
    await view.run('status');
    expect(view.notify).toHaveBeenCalledTimes(1);
    expect(view.notify.mock.calls[0]![1]).toContain('Subagent model: Same as main');
  });

  it('bare /team model reports the mode and the effective connection', async () => {
    const view = harness({ team: { ...DEFAULT_TEAM_CONFIG, model: 'profile',
      modelProfileId: 'p-upper' } });
    await view.run('model');
    expect(view.notify.mock.calls[0]![1]).toContain('GPT-Fast');
    expect(view.notify.mock.calls[0]![1]).toContain('openai:gpt-5-mini');
    expect(view.notify.mock.calls[0]![1]).toContain('Children run on openai:gpt-5-mini');
  });

  it('25: a profile NAME matches case-sensitively even through the lowercased args', async () => {
    // `GPT-Fast` and `gpt-fast` are TWO entries; the raw token must pick the
    // former while the verb pair stays case-insensitive.
    const view = harness();
    await view.run('model GPT-Fast');
    expect(view.applied[0]).toEqual({ model: 'profile', modelProfileId: 'p-upper' });
    expect(view.persisted[0]).toEqual({ team: { model: 'profile', modelProfileId: 'p-upper' } });
    expect(view.toast).toHaveBeenCalledTimes(1);

    const miss = harness();
    await miss.run('model GPT-FAST');
    expect(miss.applied).toEqual([]);
    expect(miss.notify.mock.calls[0]![1]).toContain('No profile named "GPT-FAST"');
    expect(miss.notify.mock.calls[0]![1]).toContain('GPT-Fast, gpt-fast');
  });

  it('model MAIN / fast are verbs: case-insensitive, clamped, persisted', async () => {
    const view = harness();
    await view.run('model FAST');
    expect(view.applied[0]).toEqual({ model: 'fast' });
    expect(view.persisted[0]).toEqual({ team: { model: 'fast' } });
    // The tier is disabled in this fixture: the fallback is disclosed, never silent.
    expect(view.notify.mock.calls[0]![1]).toContain('fall back to the main model');

    const back = harness({ team: { ...DEFAULT_TEAM_CONFIG, model: 'fast' } });
    await back.run('model main');
    expect(back.applied[0]).toEqual({ model: 'main' });
    expect(back.persisted[0]).toEqual({ team: { model: 'main' } });
  });
});

describe("the legacy ceiling migration (F-8 A'4)", () => {
  it('legacyTeamCeilingPatch matches EXACT equality only', () => {
    // The whole migration is an equality test; these are its edges.
    expect(legacyTeamCeilingPatch(null)).toBeNull();
    expect(legacyTeamCeilingPatch({})).toBeNull();
    expect(legacyTeamCeilingPatch({ subagentTimeoutMs: 299_999 })).toBeNull();
    expect(legacyTeamCeilingPatch({ subagentTimeoutMs: 300_000, maxTurnsPerSubagent: 2 }))
      .toEqual({ subagentTimeoutMs: 0 });
    expect(legacyTeamCeilingPatch({ ...LEGACY_TEAM_CEILING_DEFAULTS })).toEqual({
      subagentTimeoutMs: 0,
      dispatchTimeoutMs: 0,
      maxTurnsPerSubagent: 0,
    });
  });

  it('a file carrying the legacy triple resolves 0 AND is rewritten on disk', () => {
    // The user-visible bug: cli <= 0.6.16 persisted its own defaults as the
    // user config, and no later default change ever reached them. The load
    // path migrates the file layer and persists through the single write
    // path, so this launch and every next one run with no ceilings.
    writeConfig({ ...LEGACY_TEAM_CEILING_DEFAULTS, overseer: true });
    const resolved = loadConfig({ cwd: TMP }).team;
    expect(resolved.subagentTimeoutMs).toBe(0);
    expect(resolved.dispatchTimeoutMs).toBe(0);
    expect(resolved.maxTurnsPerSubagent).toBe(0);
    const onDisk = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
    expect(onDisk.team.subagentTimeoutMs).toBe(0);
    expect(onDisk.team.dispatchTimeoutMs).toBe(0);
    expect(onDisk.team.maxTurnsPerSubagent).toBe(0);
    expect(onDisk.team.overseer).toBe(true);
  });

  it('is idempotent: a second load writes the same zeros and nothing else', () => {
    writeConfig({ ...LEGACY_TEAM_CEILING_DEFAULTS, maxSubagents: 4 });
    loadConfig({ cwd: TMP });
    loadConfig({ cwd: TMP });
    const onDisk = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
    // The write path persists the WHOLE normalized section (the clamp fills
    // every key), with the legacy triple at 0 and the user maxSubagents
    // intact - and a second load leaves exactly that on disk.
    expect(onDisk.team).toEqual({
      ...DEFAULT_TEAM_CONFIG,
      subagentTimeoutMs: 0,
      dispatchTimeoutMs: 0,
      maxTurnsPerSubagent: 0,
      maxSubagents: 4,
    });
  });

  it('custom ceiling values survive untouched', () => {
    // Exact-default equality is the whole test: a user who chose 600 s
    // keeps it (and under supervision it is a cadence hint, not a kill).
    writeConfig({ subagentTimeoutMs: 600_000, dispatchTimeoutMs: 1_800_000,
      maxTurnsPerSubagent: 30 });
    const resolved = loadConfig({ cwd: TMP }).team;
    expect(resolved.subagentTimeoutMs).toBe(600_000);
    expect(resolved.dispatchTimeoutMs).toBe(1_800_000);
    expect(resolved.maxTurnsPerSubagent).toBe(30);
  });
});
