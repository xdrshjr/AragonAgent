import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

// Redirect env-paths to a throwaway temp location by pointing the platform base
// dirs at it BEFORE importing the config modules — so the tests never touch the
// developer's real config file. env-paths reads these at module load.
const TMP = mkdtempSync(join(tmpdir(), 'argon-cli-cfg-'));
process.env.APPDATA = TMP;
process.env.LOCALAPPDATA = TMP;
process.env.XDG_CONFIG_HOME = join(TMP, 'config');
process.env.XDG_DATA_HOME = join(TMP, 'data');

const { loadConfig, makeGetApiKey } = await import('../config/load.js');
const { updatePersistedConfig, loadPersistedConfig, getConfigPath, getConfigDir } = await import(
  '../config/store.js'
);
const { maskSecret, clampDensity } = await import('../config/schema.js');

const CWD = TMP; // has no .env

function clearEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ARGON_') || key.endsWith('_API_KEY')) delete process.env[key];
  }
}

beforeEach(() => {
  clearEnv();
  rmSync(getConfigDir(), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('secret masking', () => {
  it('never reveals the full secret', () => {
    const key = 'sk-ant-0123456789abcdef';
    const masked = maskSecret(key);
    expect(masked).not.toContain('0123456789');
    expect(masked).toContain('...');
    expect(masked.length).toBeLessThan(key.length);
  });

  it('fully redacts short/empty keys', () => {
    expect(maskSecret('')).toBe('(not set)');
    expect(maskSecret('short')).toBe('****');
  });

  it('defaults to ASCII so a legacy console shows dots, not question marks', () => {
    // This module has no terminal capabilities to consult and its output is
    // rendered in the settings screen, so the DEFAULT has to be the safe one
    // (spec 4.1 tier B). The UI passes its resolved glyphs explicitly.
    expect(maskSecret('short')).not.toMatch(/[^\x00-\x7f]/);
    expect(maskSecret('sk-ant-0123456789abcdef')).not.toMatch(/[^\x00-\x7f]/);
  });

  it('accepts caller-supplied glyphs for a Unicode-capable terminal', () => {
    expect(maskSecret('short', { maskChar: '•' })).toBe('••••');
    expect(maskSecret('sk-ant-0123456789abcdef', { ellipsis: '…' })).toContain('…');
  });
});

describe('config precedence: defaults < env < flags', () => {
  it('uses defaults when nothing else is set', () => {
    const cfg = loadConfig({ cwd: CWD });
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('claude-sonnet-4-5-20250929');
    expect(cfg.maxTokens).toBe(64_000);
  });

  it('env overrides defaults', () => {
    process.env.ARGON_MODEL = 'env-model';
    const cfg = loadConfig({ cwd: CWD });
    expect(cfg.model).toBe('env-model');
  });

  it('flags override env', () => {
    process.env.ARGON_MODEL = 'env-model';
    const cfg = loadConfig({ cwd: CWD, model: 'flag-model' });
    expect(cfg.model).toBe('flag-model');
  });

  it('resolves maximum-token settings with flags taking precedence', () => {
    updatePersistedConfig({ maxTokens: 4_096 });
    process.env.ARGON_MAX_TOKENS = '8192';
    const flags = {
      cwd: CWD,
      maxTokens: '16384',
    };

    expect(loadConfig(flags).maxTokens).toBe(16_384);
  });
});

describe('getApiKey precedence', () => {
  it('prefers the config-file key over the env var', () => {
    updatePersistedConfig({ apiKeys: { anthropic: 'file-key' } });
    process.env.ANTHROPIC_API_KEY = 'env-key';
    const cfg = loadConfig({ cwd: CWD });
    expect(makeGetApiKey(cfg)('anthropic')).toBe('file-key');
  });

  it('falls back to the env var when no file key exists', () => {
    process.env.OPENAI_API_KEY = 'env-openai';
    const cfg = loadConfig({ cwd: CWD });
    expect(makeGetApiKey(cfg)('openai')).toBe('env-openai');
  });

  it('a one-shot --api-key override wins for the active provider', () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    const cfg = loadConfig({ cwd: CWD, provider: 'anthropic', apiKey: 'override' });
    expect(makeGetApiKey(cfg)('anthropic')).toBe('override');
  });
});

describe('timeout invariant (R1)', () => {
  it('raises idleTimeout to >= toolTimeout + 30s', () => {
    const cfg = loadConfig({ cwd: CWD, toolTimeout: '100000', idleTimeout: '50000' });
    expect(cfg.toolTimeoutMs).toBe(100_000);
    expect(cfg.idleTimeoutMs).toBe(130_000);
  });
});

describe('additive config keys (R-12: no migration, no version bump)', () => {
  it('loads a config file written before the keys existed', () => {
    // Simulates a v0.2.0 file: none of the full-screen keys are present.
    updatePersistedConfig({ model: 'legacy-model' });
    const cfg = loadConfig({ cwd: CWD });
    expect(cfg.model).toBe('legacy-model');
    // Absent ⇒ no explicit opinion, so the auto-downgrade heuristics stay live.
    expect(cfg.fullscreen).toBeUndefined();
    expect(cfg.exitTranscript).toBe(true);
    expect(cfg.transcriptWindow).toBe(300);
  });

  it('treats a persisted `fullscreen: true` as the default, not as a force', () => {
    updatePersistedConfig({ fullscreen: true });
    expect(loadConfig({ cwd: CWD }).fullscreen).toBeUndefined();
  });

  it('honors an opt-out from the config file and a force from the flag', () => {
    updatePersistedConfig({ fullscreen: false });
    expect(loadConfig({ cwd: CWD }).fullscreen).toBe(false);
    expect(loadConfig({ cwd: CWD, fullscreen: true }).fullscreen).toBe(true);
  });

  it('lets ARGON_FULLSCREEN override the file but lose to the flag', () => {
    updatePersistedConfig({ fullscreen: false });
    process.env.ARGON_FULLSCREEN = '1';
    expect(loadConfig({ cwd: CWD }).fullscreen).toBe(true);
    expect(loadConfig({ cwd: CWD, fullscreen: false }).fullscreen).toBe(false);
  });

  it('clamps transcriptWindow into [50, 2000]', () => {
    updatePersistedConfig({ transcriptWindow: 5 });
    expect(loadConfig({ cwd: CWD }).transcriptWindow).toBe(50);
    updatePersistedConfig({ transcriptWindow: 99_999 });
    expect(loadConfig({ cwd: CWD }).transcriptWindow).toBe(2000);
  });
});

describe('atomic write round-trip', () => {
  it('persists and reloads a config value', () => {
    updatePersistedConfig({ model: 'persisted-model' });
    const reloaded = loadPersistedConfig();
    expect(reloaded.model).toBe('persisted-model');
    expect(existsSync(getConfigPath())).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('applies 0600 permissions on POSIX', () => {
    updatePersistedConfig({ model: 'perm-check' });
    const mode = statSync(getConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('density / hints / submitCount (v0.4.0 fields)', () => {
  it('defaults to comfortable density with hints on', () => {
    const cfg = loadConfig({ cwd: CWD });
    expect(cfg.density).toBe('comfortable');
    expect(cfg.hints).toBe(true);
    expect(cfg.submitCount).toBe(0);
  });

  it('honours the tri-state --compact / --hints flags', () => {
    expect(loadConfig({ cwd: CWD, compact: true }).density).toBe('compact');
    expect(loadConfig({ cwd: CWD, compact: false }).density).toBe('comfortable');
    expect(loadConfig({ cwd: CWD, hints: false }).hints).toBe(false);
    expect(loadConfig({ cwd: CWD, hints: true }).hints).toBe(true);
    // Absent means "no opinion", which is what lets the config layer win.
    expect(loadConfig({ cwd: CWD }).density).toBe('comfortable');
  });

  it('clamps a nonsense density rather than throwing', () => {
    expect(clampDensity('sideways', 'comfortable')).toBe('comfortable');
    expect(clampDensity('compact', 'comfortable')).toBe('compact');
  });
});
