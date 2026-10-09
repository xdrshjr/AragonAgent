/**
 * The `compaction` config section: BOTH merge halves, `config set`, and the four
 * resolution layers (context-auto-compaction §4.2 / §4.3 / C-13 / P1-5).
 *
 * THE ROUND TRIP THROUGH `updatePersistedConfig` IS THE POINT. `store.ts` merges
 * nested sections BY HAND in TWO places, and omitting the write half is silent:
 * `/compact threshold 0.8` sends `{ compaction: { threshold: 0.8 } }`, a shallow
 * top-level spread replaces the whole section, `enabled` is written absent, and a
 * user who deliberately turned compaction OFF finds it back on tomorrow. This
 * package has paid for that three times already — `todo` P0-1, `retry` R-9 and
 * `fast` R-10 — so a fourth feature adding a section without this test would be
 * repeating a known, named bug.
 *
 * THE FLAG ASSERTIONS ARE THE OTHER HALF, AND THEY ARE A SHIPPING CONDITION
 * (C-13 / P1-5). `compaction.enabled` is PERSISTED and defaults to `true`, so
 * declaring only `--no-compaction` would make commander default
 * `opts.compaction` to `true` — indistinguishable from silence — and silently
 * overwrite a stored `false` on EVERY run that passed no flag at all. That is a
 * kill switch for a feature that spends money on the user's behalf, un-setting
 * itself. Manual-test row 9 is the same check by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../commands/registry.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const HOME = mkdtempSync(join(tmpdir(), 'aragon-compaction-config-'));
process.env.ARAGON_HOME = HOME;

const { formatCompactionStatus, runCompactCommand } = await import('../compaction/command.js');

const { DEFAULT_COMPACTION_CONFIG } = await import('../config/schema.js');
const { applyCompactionConfigSet, COMPACTION_CONFIG_SET_KEYS } = await import(
  '../config/cli-commands.js'
);
const { loadPersistedConfig, updatePersistedConfig, writeConfigFile } = await import(
  '../config/store.js'
);
const { loadConfig } = await import('../config/load.js');

const ENV_KEYS = [
  'ARAGON_COMPACTION',
  'ARAGON_COMPACTION_THRESHOLD',
  'ARAGON_COMPACTION_KEEP_TURNS',
  'ARAGON_COMPACTION_SUBAGENTS',
  'ARAGON_COMPACTION_ARCHIVE',
];

describe('precise compaction command feedback', () => {
  function context(args = '') {
    return {
      args, notify: vi.fn(), toast: vi.fn(), persistConfig: vi.fn(),
      state: { status: 'idle', entries: [] },
      controller: {
        isCompactionRegistered: () => true, isCompactionEnabled: () => true,
        getCompactionConfig: () => ({ ...DEFAULT_COMPACTION_CONFIG, onFailure: 'truncate' }),
        getCompactionSnapshot: () => ({ live: true, model: 'model', compactions: 0,
          generation: 0, usage: { inputTokens: 0, outputTokens: 0 }, tokensReclaimed: 0,
          pressure: { occupied: 89999, contextWindow: 100000, ratio: 0.89999,
            source: 'usage', deltaTokens: 0, windowKnown: true } }),
        getCompactionSummarizerRef: () => null, getCompactionRunId: () => null,
        compactNow: vi.fn(async () => ({ ok: false, reason: 'protected_budget_exceeded' })),
        queueCompaction: vi.fn(),
        isCompactionBusy: () => false,
        setCompactionConfig: vi.fn((patch: object) => ({ ...DEFAULT_COMPACTION_CONFIG, ...patch })),
        setCompactionEnabled: vi.fn(),
      },
    };
  }

  it('shows raw tokens, exact threshold and preservation for legacy truncate', () => {
    const text = formatCompactionStatus(context() as unknown as CommandContext);
    expect(text).toContain('89999 / 100000');
    expect(text).toContain('90.00%');
    expect(text).toContain('90000 tokens');
    expect(text).toContain('Automatic trigger: occupancy >=');
    expect(text).toContain('legacy truncate configured; preserving history');
    expect(text).not.toContain('headroom drops');
  });

  it('reports the accumulated call cost without repricing it using current preferences', () => {
    const ctx = context();
    const snapshot = ctx.controller.getCompactionSnapshot();
    ctx.controller.getCompactionSnapshot = () => ({ ...snapshot, costUsd: 1.25 });
    expect(formatCompactionStatus(ctx as unknown as CommandContext)).toContain('$1.25');
  });

  it.each(['idle', 'running'])('rejects oversized instructions while %s without replacing a request', async (status) => {
    const ctx = context('x'.repeat(4001));
    ctx.state.status = status;
    await runCompactCommand(ctx as unknown as CommandContext);
    expect(ctx.controller.compactNow).not.toHaveBeenCalled();
    expect(ctx.controller.queueCompaction).not.toHaveBeenCalled();
    expect(ctx.notify).toHaveBeenCalledWith('warn', expect.stringContaining('4000'));
  });

  it.each(['status', 'history', 'show 1', 'on', 'off', 'threshold 80%', 'keep 2'])(
    'never queues or starts a summary for %s', async (args) => {
      const ctx = context(args);
      await runCompactCommand(ctx as unknown as CommandContext);
      expect(ctx.controller.compactNow).not.toHaveBeenCalled();
      expect(ctx.controller.queueCompaction).not.toHaveBeenCalled();
    },
  );

  it('accepts the instruction limit and reports preservation on refusal', async () => {
    const ctx = context('x'.repeat(4000));
    await runCompactCommand(ctx as unknown as CommandContext);
    expect(ctx.controller.compactNow).toHaveBeenCalledWith('x'.repeat(4000));
    expect(ctx.notify).toHaveBeenCalledWith('warn',
      'History preserved: protected_budget_exceeded.');
  });

  it('does not announce another queued operation while compaction is busy', async () => {
    const ctx = context('focus on failures');
    ctx.state.status = 'running';
    ctx.controller.isCompactionBusy = () => true;
    await runCompactCommand(ctx as unknown as CommandContext);
    expect(ctx.controller.queueCompaction).not.toHaveBeenCalled();
    expect(ctx.controller.compactNow).not.toHaveBeenCalled();
    expect(ctx.notify).toHaveBeenCalledWith('info', 'Compaction is already running.');
  });

  it('does not queue a manual request during an in-loop summary', async () => {
    const ctx = context();
    ctx.state.status = 'running';
    const snapshot = ctx.controller.getCompactionSnapshot();
    ctx.controller.getCompactionSnapshot = () => ({ ...snapshot, inFlight: true });
    await runCompactCommand(ctx as unknown as CommandContext);
    expect(ctx.controller.queueCompaction).not.toHaveBeenCalled();
    expect(ctx.notify).toHaveBeenCalledWith('info', 'Compaction is already running.');
  });
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  writeConfigFile(loadPersistedConfig());
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  rmSync(join(HOME, 'config.json'), { force: true });
});

describe('both store.ts merges know about the section', () => {
  it('preserves history by default and still reads legacy truncate configuration', () => {
    expect(DEFAULT_COMPACTION_CONFIG.onFailure).toBe('stop');
    updatePersistedConfig({ compaction: { onFailure: 'truncate' } as never });
    expect(loadConfig({}).compaction.onFailure).toBe('truncate');
  });
  it('READ half: a config file with no `compaction` key still resolves the section', () => {
    // Without it `config.compaction.enabled` reads `undefined`, which is FALSY —
    // so a feature that is `true` by default would arrive OFF for every existing
    // user, which is the one direction this default must never fail in.
    writeConfigFile({ provider: 'anthropic' } as never);
    expect(loadPersistedConfig().compaction).toEqual(DEFAULT_COMPACTION_CONFIG);
  });

  it('WRITE half: changing one key does not reset the rest of the section', () => {
    updatePersistedConfig({
      compaction: { enabled: false, keepRecentTurns: 9 } as never,
    });
    const merged = updatePersistedConfig({ compaction: { threshold: 0.8 } as never });
    expect(merged.compaction.threshold).toBe(0.8);
    // The two settings the user changed a moment ago are still there.
    expect(merged.compaction.enabled).toBe(false);
    expect(merged.compaction.keepRecentTurns).toBe(9);
  });

  it('clamps on the WRITE path, not only on the read one', () => {
    // Hardening only the read path leaves a bad value on disk that reverts to
    // the default on every launch, which presents as "my setting won't stick".
    const merged = updatePersistedConfig({ compaction: { threshold: 4 } as never });
    expect(merged.compaction.threshold).toBe(0.95);
    expect(loadPersistedConfig().compaction.threshold).toBe(0.95);
  });
});

describe('applyCompactionConfigSet', () => {
  it('accepts every advertised key and rejects anything else', () => {
    for (const key of COMPACTION_CONFIG_SET_KEYS) {
      expect(applyCompactionConfigSet(key, 'false'), key).not.toBeNull();
    }
    expect(applyCompactionConfigSet('compaction.nope', 'x')).toBeNull();
    expect(applyCompactionConfigSet('fast.model', 'x')).toBeNull();
  });

  it('advertises exactly the six keys the section has', () => {
    // A key in the section but not here is a key `config list` shows and
    // `config set` refuses — visible in one command and unreachable in the next.
    expect([...COMPACTION_CONFIG_SET_KEYS].sort()).toEqual(
      Object.keys(DEFAULT_COMPACTION_CONFIG)
        .map((k) => `compaction.${k}`)
        .sort(),
    );
  });

  it('accepts a percentage for both thresholds', () => {
    expect(applyCompactionConfigSet('compaction.threshold', '85%')).toEqual({
      compaction: { threshold: 0.85 },
    });
    expect(applyCompactionConfigSet('compaction.threshold', '0.85')).toEqual({
      compaction: { threshold: 0.85 },
    });
  });

  it('clamps rather than rejects, so the caller can echo the STORED value', () => {
    const patch = applyCompactionConfigSet('compaction.threshold', '0.2')!;
    const merged = updatePersistedConfig(patch);
    expect(merged.compaction.threshold).toBe(0.5);
  });

  it('leaves the setting alone when the value is not a ratio at all', () => {
    // "A typo changes nothing" — the discipline every other key in this file
    // follows. `parseThresholdInput` returns null and the clamp keeps the
    // default rather than resolving garbage to something plausible.
    updatePersistedConfig({ compaction: { threshold: 0.7 } as never });
    const patch = applyCompactionConfigSet('compaction.threshold', 'banana')!;
    expect(patch).toEqual({ compaction: { threshold: DEFAULT_COMPACTION_CONFIG.threshold } });
  });

  it('parses the two booleans', () => {
    expect(applyCompactionConfigSet('compaction.enabled', 'false')).toEqual({
      compaction: { enabled: false },
    });
    expect(applyCompactionConfigSet('compaction.enabled', 'true')).toEqual({
      compaction: { enabled: true },
    });
    expect(applyCompactionConfigSet('compaction.useFastTier', '0')).toEqual({
      compaction: { useFastTier: false },
    });
  });
});

describe('C-13 / P1-5 — the persisted kill switch survives a flagless run', () => {
  it('a stored `enabled: false` is still false with NO flags at all', () => {
    // THE FAILING VERSION OF THIS TEST is the one where only `--no-compaction` is
    // declared: commander materialises `opts.compaction = true` when the flag is
    // absent, the resolver cannot tell that from an explicit `--compaction`, and
    // the stored `false` is overwritten on every single run.
    updatePersistedConfig({ compaction: { enabled: false } as never });
    expect(loadConfig({}).compaction.enabled).toBe(false);
  });

  it('`--compaction` overrides a stored false', () => {
    updatePersistedConfig({ compaction: { enabled: false } as never });
    expect(loadConfig({ compaction: true }).compaction.enabled).toBe(true);
  });

  it('`--no-compaction` overrides a stored true', () => {
    updatePersistedConfig({ compaction: { enabled: true } as never });
    expect(loadConfig({ compaction: false }).compaction.enabled).toBe(false);
  });

  it('the resolver reads `!== undefined`, never truthiness', () => {
    // `false` is a MEANINGFUL flag value here, so a truthiness check would drop
    // `--no-compaction` on the floor. Asserted through the same public entry the
    // CLI uses rather than by inspecting the resolver.
    updatePersistedConfig({ compaction: { enabled: true } as never });
    expect(loadConfig({ compaction: undefined }).compaction.enabled).toBe(true);
    expect(loadConfig({ compaction: false }).compaction.enabled).toBe(false);
  });
});

describe('the four resolution layers (defaults > file > env > flags)', () => {
  it('the file beats the defaults', () => {
    updatePersistedConfig({ compaction: { threshold: 0.7 } as never });
    expect(loadConfig({}).compaction.threshold).toBe(0.7);
  });

  it('the env beats the file', () => {
    updatePersistedConfig({ compaction: { threshold: 0.7, enabled: true } as never });
    process.env.ARAGON_COMPACTION_THRESHOLD = '80%';
    process.env.ARAGON_COMPACTION = '0';
    const config = loadConfig({});
    expect(config.compaction.threshold).toBe(0.8);
    expect(config.compaction.enabled).toBe(false);
  });

  it('the flags beat the env', () => {
    process.env.ARAGON_COMPACTION = '0';
    process.env.ARAGON_COMPACTION_THRESHOLD = '80%';
    const config = loadConfig({ compaction: true, compactionThreshold: '60%' });
    expect(config.compaction.enabled).toBe(true);
    expect(config.compaction.threshold).toBe(0.6);
  });

  it('a bad env threshold falls THROUGH to the file rather than masking it', () => {
    // Left absent on a bad value rather than clamped to a default, so a typo in
    // a container's environment does not silently pin the setting for the
    // session.
    updatePersistedConfig({ compaction: { threshold: 0.7 } as never });
    process.env.ARAGON_COMPACTION_THRESHOLD = 'banana';
    expect(loadConfig({}).compaction.threshold).toBe(0.7);
  });

  it('ARAGON_COMPACTION_KEEP_TURNS resolves and clamps', () => {
    process.env.ARAGON_COMPACTION_KEEP_TURNS = '7';
    expect(loadConfig({}).compaction.keepRecentTurns).toBe(7);
    process.env.ARAGON_COMPACTION_KEEP_TURNS = '999';
    expect(loadConfig({}).compaction.keepRecentTurns).toBe(20);
  });

  it('an env section with only ONE key does not drop the others', () => {
    // The accumulate-and-assign-once shape: three `if` blocks each assigning
    // `partial.compaction` would compile clean and silently drop `enabled`.
    updatePersistedConfig({ compaction: { enabled: false } as never });
    process.env.ARAGON_COMPACTION_THRESHOLD = '75%';
    const config = loadConfig({});
    expect(config.compaction.threshold).toBe(0.75);
    expect(config.compaction.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The two hardening keys (context-auto-compaction-hardening §4.2 / test 32)
// ---------------------------------------------------------------------------

describe('AC-H19: compaction.subagents and compaction.archive, in all eight places', () => {
  it('both default to true, so the hardening is on out of the box', () => {
    expect(DEFAULT_COMPACTION_CONFIG.subagents).toBe(true);
    expect(DEFAULT_COMPACTION_CONFIG.archive).toBe(true);
    expect(loadConfig({}).compaction.subagents).toBe(true);
    expect(loadConfig({}).compaction.archive).toBe(true);
  });

  it('`config set` accepts them and the round trip survives the store merge', () => {
    expect(COMPACTION_CONFIG_SET_KEYS).toContain('compaction.subagents');
    expect(COMPACTION_CONFIG_SET_KEYS).toContain('compaction.archive');

    const patch = applyCompactionConfigSet('compaction.subagents', 'false');
    expect(patch).toEqual({ compaction: { subagents: false } });
    updatePersistedConfig(patch!);
    // AND THE REST OF THE SECTION SURVIVES: a shallow top-level spread would have
    // written `enabled` absent.
    expect(loadConfig({}).compaction.subagents).toBe(false);
    expect(loadConfig({}).compaction.enabled).toBe(true);

    updatePersistedConfig(applyCompactionConfigSet('compaction.archive', 'false')!);
    expect(loadConfig({}).compaction.archive).toBe(false);
    expect(loadConfig({}).compaction.subagents).toBe(false);
  });

  it('the env vars turn each of them off for the process', () => {
    process.env.ARAGON_COMPACTION_SUBAGENTS = '0';
    process.env.ARAGON_COMPACTION_ARCHIVE = 'false';
    const config = loadConfig({});
    expect(config.compaction.subagents).toBe(false);
    expect(config.compaction.archive).toBe(false);
    // The other keys are untouched, which is the accumulate-and-assign-once rule
    // again with two more contributors.
    expect(config.compaction.enabled).toBe(true);
  });

  it('an unparseable value resolves to the default rather than throwing', () => {
    // The clamp discipline every other key in this file follows.
    process.env.ARAGON_COMPACTION_SUBAGENTS = 'banana';
    expect(loadConfig({}).compaction.subagents).toBe(false);
    expect(applyCompactionConfigSet('compaction.archive', 'nonsense')).toEqual({
      compaction: { archive: false },
    });
  });
});
