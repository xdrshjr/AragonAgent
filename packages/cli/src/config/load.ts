/**
 * Layered config resolution: defaults › user file › env/.env › CLI flags.
 *
 * Also enforces the timeout invariant (spec §3.8 / R1): after merging all
 * layers, `idleTimeout` is re-derived to be strictly ≥ `toolTimeout` so a
 * legitimately long single tool run can never be watchdog-killed.
 */

import process from 'node:process';
import {
  DEFAULT_CONFIG,
  IDLE_TIMEOUT_MARGIN_MS,
  clampTheme,
  clampThinkingLevel,
  coerceMaxTokens,
  coercePositiveInt,
  type CliConfig,
  type PersistedConfig,
  type ThemeName,
} from './schema.js';
import { loadDotenv, readEnvConfig } from './env.js';
import { readConfigFile } from './store.js';
import { detectCapabilities } from '../ui/capabilities.js';

/** Interpret a boolean-ish env value (`1/true/on/yes`) as `true`. */
function envFlagTrue(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

// ---------------------------------------------------------------------------
// CLI flags (already parsed by commander)
// ---------------------------------------------------------------------------

export interface CliFlags {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  thinking?: string;
  maxTokens?: string | number;
  cwd?: string;
  theme?: string;
  color?: boolean;
  confirm?: boolean;
  toolTimeout?: string | number;
  idleTimeout?: string | number;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

function pick<T>(...vals: (T | undefined | null)[]): T | undefined {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * Resolve the effective config by merging all layers, then derive the runtime
 * (non-persisted) fields and enforce the timeout invariant.
 */
export function loadConfig(flags: CliFlags = {}): CliConfig {
  const cwd = flags.cwd ? flags.cwd : process.cwd();

  // `.env` must be loaded before reading env overrides.
  loadDotenv(cwd);

  const file: Partial<PersistedConfig> = readConfigFile() ?? {};
  const env = readEnvConfig();

  const provider =
    pick(flags.provider, env.partial.provider, file.provider) ?? DEFAULT_CONFIG.provider;
  const model = pick(flags.model, env.partial.model, file.model) ?? DEFAULT_CONFIG.model;
  const baseUrl = pick<string>(
    flags.baseUrl,
    env.partial.baseUrl ?? undefined,
    file.baseUrl ?? undefined,
  );

  const thinkingLevel = clampThinkingLevel(
    pick(flags.thinking, env.partial.thinkingLevel, file.thinkingLevel),
    DEFAULT_CONFIG.thinkingLevel,
  );

  const maxTokens = coerceMaxTokens(
    pick(flags.maxTokens, env.partial.maxTokens, file.maxTokens),
  );

  const theme: ThemeName = clampTheme(
    pick(flags.theme, env.partial.theme, file.theme),
    DEFAULT_CONFIG.theme,
  );

  const confirmTools =
    flags.confirm !== undefined ? flags.confirm : file.confirmTools ?? DEFAULT_CONFIG.confirmTools;

  const toolTimeoutMs = coercePositiveInt(
    pick(flags.toolTimeout, file.toolTimeoutMs),
    DEFAULT_CONFIG.toolTimeoutMs,
  );

  let idleTimeoutMs = coercePositiveInt(
    pick(flags.idleTimeout, file.idleTimeoutMs),
    DEFAULT_CONFIG.idleTimeoutMs,
  );

  // Timeout invariant (R1): idle must be strictly greater than the tool ceiling
  // so a long single tool run is never aborted by the idle watchdog.
  idleTimeoutMs = Math.max(idleTimeoutMs, toolTimeoutMs + IDLE_TIMEOUT_MARGIN_MS);

  // Resolve API keys: config-file key wins over the provider env var.
  const fileKeys = file.apiKeys ?? {};
  const apiKeys: Record<string, string | undefined> = {};
  const providerSet = new Set([
    ...Object.keys(env.apiKeys),
    ...Object.keys(fileKeys),
    provider,
  ]);
  for (const prov of providerSet) {
    const fileKey = fileKeys[prov];
    apiKeys[prov] =
      fileKey && fileKey.trim().length > 0 ? fileKey.trim() : env.apiKeys[prov];
  }

  const color = flags.color !== undefined ? flags.color : !process.env.NO_COLOR;

  // `--no-color` implies calmer chrome; env / file may also opt in explicitly.
  const reducedMotion =
    envFlagTrue(process.env.ARGON_REDUCED_MOTION) ||
    (file.reducedMotion ?? DEFAULT_CONFIG.reducedMotion) ||
    !color;

  // Detect terminal capabilities once; force monochrome when color is disabled.
  const caps = detectCapabilities(process.env, process.stdout);
  const colorLevel: 0 | 1 | 2 | 3 = color ? caps.colorLevel : 0;

  return {
    provider,
    model,
    baseUrl,
    thinkingLevel,
    maxTokens,
    theme,
    reducedMotion,
    confirmTools,
    toolTimeoutMs,
    idleTimeoutMs,
    apiKeys,
    recentModels: file.recentModels ?? [],
    promptHistory: file.promptHistory ?? [],
    cwd,
    color,
    colorLevel,
    unicode: caps.unicode,
    apiKeyOverride: flags.apiKey && flags.apiKey.trim().length > 0 ? flags.apiKey.trim() : undefined,
  };
}

/**
 * Build the `getApiKey(providerId)` resolver the core `Agent` consumes.
 * The one-shot `--api-key` override wins, but only for the active provider.
 */
export function makeGetApiKey(config: CliConfig): (providerId: string) => string | undefined {
  return (providerId: string) => {
    if (config.apiKeyOverride && providerId === config.provider) {
      return config.apiKeyOverride;
    }
    return config.apiKeys[providerId];
  };
}
