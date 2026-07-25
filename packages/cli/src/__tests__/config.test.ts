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
const { maskSecret } = await import('../config/schema.js');

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
    expect(masked).toContain('…');
    expect(masked.length).toBeLessThan(key.length);
  });

  it('fully redacts short/empty keys', () => {
    expect(maskSecret('')).toBe('(not set)');
    expect(maskSecret('short')).toBe('••••');
  });
});

describe('config precedence: defaults < env < flags', () => {
  it('uses defaults when nothing else is set', () => {
    const cfg = loadConfig({ cwd: CWD });
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('claude-sonnet-4-5-20250929');
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
