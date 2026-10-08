/**
 * Pure mapping from a model profile to the environment variables the
 * `aragon exec` child reads (see `packages/cli/src/config/env.ts`):
 *
 *   ARAGON_PROVIDER / ARAGON_MODEL / ARAGON_THINKING / ARAGON_BASE_URL
 *   ANTHROPIC_API_KEY | OPENAI_API_KEY
 *
 * `custom` means "OpenAI-compatible endpoint": it runs as provider `openai`
 * with a mandatory base URL - that is exactly what an OpenAI-shaped gateway
 * needs and it keeps the provider set adapter-backed.
 */

import type { ModelProfile } from '../../shared/protocol.js';

export interface ProfileEnvInput {
  mode: ModelProfile['mode'];
  model: string;
  baseUrl: string;
  thinking: string;
  /** Decrypted API key; null means "inherit whatever the parent env has". */
  apiKey: string | null;
}

/** The provider id the CLI should resolve to for each desktop mode. */
export function providerForMode(mode: ModelProfile['mode']): 'anthropic' | 'openai' {
  return mode === 'anthropic' ? 'anthropic' : 'openai';
}

/**
 * Build ONLY the variables this profile owns. The caller merges them over the
 * parent environment; variables absent here are inherited untouched, so a user
 * with ANTHROPIC_API_KEY already exported keeps working.
 */
export function buildProfileEnv(input: ProfileEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    ARAGON_PROVIDER: providerForMode(input.mode),
    ARAGON_MODEL: input.model,
  };
  if (input.thinking && input.thinking !== 'off') {
    env.ARAGON_THINKING = input.thinking;
  } else {
    env.ARAGON_THINKING = 'off';
  }
  if (input.baseUrl.length > 0) {
    env.ARAGON_BASE_URL = input.baseUrl;
  }
  const keyVar = input.mode === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  if (input.apiKey && input.apiKey.length > 0) {
    env[keyVar] = input.apiKey;
  }
  return env;
}
