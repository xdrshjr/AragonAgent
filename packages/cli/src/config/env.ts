/**
 * Environment + `.env` loading and mapping to config fields.
 *
 * Recognized keys (spec §3.5):
 *   - Provider secrets: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY /
 *     GEMINI_API_KEY.
 *   - Overrides: ARGON_PROVIDER, ARGON_MODEL, ARGON_BASE_URL, ARGON_THINKING,
 *     ARGON_MAX_TOKENS, ARGON_THEME.
 */

import { join } from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import {
  clampTheme,
  clampThinkingLevel,
  coerceMaxTokens,
  type PersistedConfig,
} from './schema.js';

/**
 * Load a project `.env` from the given directory into `process.env` (existing
 * process env wins — dotenv never overrides already-set variables).
 */
export function loadDotenv(cwd: string): void {
  dotenv.config({ path: join(cwd, '.env') });
}

/** Provider -> the env vars that may carry its key (first non-empty wins). */
const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
};

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name];
    if (v && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

export interface EnvConfig {
  /** Non-secret overrides sourced from ARGON_* env vars. */
  partial: Partial<PersistedConfig>;
  /** Resolved provider -> key from provider env vars. */
  apiKeys: Record<string, string | undefined>;
}

/**
 * Read ARGON_* overrides and provider secrets from the current environment.
 * Must be called after `loadDotenv()` so `.env` values are visible.
 */
export function readEnvConfig(): EnvConfig {
  const partial: Partial<PersistedConfig> = {};

  const provider = process.env.ARGON_PROVIDER?.trim();
  if (provider) partial.provider = provider;

  const model = process.env.ARGON_MODEL?.trim();
  if (model) partial.model = model;

  const baseUrl = process.env.ARGON_BASE_URL?.trim();
  if (baseUrl) partial.baseUrl = baseUrl;

  if (process.env.ARGON_THINKING) {
    partial.thinkingLevel = clampThinkingLevel(process.env.ARGON_THINKING.trim(), 'off');
  }

  if (process.env.ARGON_MAX_TOKENS) {
    const mt = coerceMaxTokens(process.env.ARGON_MAX_TOKENS);
    partial.maxTokens = mt ?? null;
  }

  if (process.env.ARGON_THEME) {
    partial.theme = clampTheme(process.env.ARGON_THEME.trim(), 'auto');
  }

  const apiKeys: Record<string, string | undefined> = {};
  for (const [prov, names] of Object.entries(PROVIDER_ENV_KEYS)) {
    apiKeys[prov] = firstEnv(names);
  }

  return { partial, apiKeys };
}
