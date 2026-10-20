import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const TMP = mkdtempSync(join(tmpdir(), 'aragon-cli-scroll-'));
process.env.ARAGON_HOME = TMP;

const { loadConfig } = await import('../config/load.js');
const { updatePersistedConfig, loadPersistedConfig } = await import('../config/store.js');
const { clampScrollMode, DEFAULT_SCROLL_MODE } = await import('../config/schema.js');

afterEach(() => {
  vi.unstubAllEnvs();
  updatePersistedConfig({ scrollMode: 'native' });
});

describe('scrollMode config', () => {
  it('defaults to native', () => {
    expect(DEFAULT_SCROLL_MODE).toBe('native');
    expect(loadConfig({ cwd: TMP }).scrollMode).toBe('native');
  });

  it('resolves flags > env > file > default', () => {
    updatePersistedConfig({ scrollMode: 'app' });
    expect(loadConfig({ cwd: TMP }).scrollMode).toBe('app');
    vi.stubEnv('ARAGON_SCROLL_MODE', 'native');
    expect(loadConfig({ cwd: TMP }).scrollMode).toBe('native');
    expect(loadConfig({ cwd: TMP, scrollMode: 'app' }).scrollMode).toBe('app');
  });

  it('ignores invalid ARAGON_SCROLL_MODE and is case-insensitive', () => {
    updatePersistedConfig({ scrollMode: 'app' });
    vi.stubEnv('ARAGON_SCROLL_MODE', 'bogus');
    expect(loadConfig({ cwd: TMP }).scrollMode).toBe('app');
    vi.stubEnv('ARAGON_SCROLL_MODE', ' NATIVE ');
    expect(loadConfig({ cwd: TMP }).scrollMode).toBe('native');
  });

  it('round-trips through the config file', () => {
    updatePersistedConfig({ scrollMode: 'app' });
    expect(loadPersistedConfig().scrollMode).toBe('app');
  });

  it('clamps junk to the fallback', () => {
    expect(clampScrollMode('app', 'native')).toBe('app');
    expect(clampScrollMode('APP', 'native')).toBe('app');
    expect(clampScrollMode('x', 'native')).toBe('native');
    expect(clampScrollMode(3, 'app')).toBe('app');
  });
});
