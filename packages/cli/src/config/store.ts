/**
 * Config store — read/atomic-write the user config JSON and resolve OS-specific
 * paths via `env-paths`. The file may hold secrets, so it is written with
 * `0600` permissions on POSIX (spec §3.5 / §6.1).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import envPaths from 'env-paths';
import {
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  type PersistedConfig,
} from './schema.js';

const paths = envPaths('argon-agent');

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export function getConfigDir(): string {
  return paths.config;
}

export function getConfigPath(): string {
  return join(paths.config, 'config.json');
}

export function getSessionsDir(): string {
  return join(paths.data, 'sessions');
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read the persisted config file. Returns a partial config (only the keys the
 * user actually wrote) or `null` when the file is absent or unparseable.
 */
export function readConfigFile(): Partial<PersistedConfig> | null {
  const file = getConfigPath();
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as Partial<PersistedConfig>;
    }
    return null;
  } catch {
    // A corrupt config file must never crash the CLI — fall back to defaults.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write (atomic + 0600)
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Atomically write the persisted config: write a temp file in the same
 * directory, then rename over the target, then re-apply `0600` on POSIX.
 */
export function writeConfigFile(config: PersistedConfig): void {
  const file = getConfigPath();
  ensureDir(dirname(file));

  const tmp = `${file}.${process.pid}.tmp`;
  const json = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(tmp, json, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, file);

  // rename may not preserve mode on every platform; re-chmod on POSIX.
  if (process.platform !== 'win32') {
    try {
      chmodSync(file, 0o600);
    } catch {
      // Non-fatal: permission tightening is best-effort.
    }
  }
}

/**
 * Load the persisted config merged over defaults (a fully-populated object).
 * Unlike `readConfigFile`, this always returns a complete `PersistedConfig`.
 */
export function loadPersistedConfig(): PersistedConfig {
  const partial = readConfigFile() ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    version: CONFIG_VERSION,
    apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...(partial.apiKeys ?? {}) },
    recentModels: partial.recentModels ?? [],
    promptHistory: partial.promptHistory ?? [],
  };
}

/**
 * Read the persisted config, apply a patch, write it back atomically, and
 * return the merged result. This is the single write path used by the settings
 * screen and `argon config set` so env-provided keys never leak into the file.
 */
export function updatePersistedConfig(patch: Partial<PersistedConfig>): PersistedConfig {
  const current = loadPersistedConfig();
  const merged: PersistedConfig = {
    ...current,
    ...patch,
    version: CONFIG_VERSION,
    apiKeys: { ...current.apiKeys, ...(patch.apiKeys ?? {}) },
  };
  writeConfigFile(merged);
  return merged;
}
