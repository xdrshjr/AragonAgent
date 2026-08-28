/**
 * Model registry — static builtin model metadata + runtime API discovery with
 * caching.
 *
 * The builtin lists are migrated from `src/lib/model-options.ts` and the
 * discovery logic mirrors `server/services/model-detection.ts`, but uses the
 * new LLMProvider interface for API queries.
 */

import type { ModelInfo } from './types.js';
import type { ProviderRegistry } from './providers/index.js';
import { DEFAULT_MAX_OUTPUT_TOKENS, learnModelCeiling } from './output-limits.js';

// ---------------------------------------------------------------------------
// Discovery cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  models: ModelInfo[];
  timestamp: number;
}

/** Cache TTL: 5 minutes. */
const CACHE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// ModelRegistry
// ---------------------------------------------------------------------------

export class ModelRegistry {
  /** Static/builtin models keyed by provider id. */
  private readonly builtinModels = new Map<string, ModelInfo[]>();

  /** API-discovered models cache keyed by `${providerId}:${baseUrl}`. */
  private readonly discoveryCache = new Map<string, CacheEntry>();

  /** Optional reference to the provider registry for API discovery. */
  private providerRegistry: ProviderRegistry | undefined;

  constructor(providerRegistry?: ProviderRegistry) {
    this.providerRegistry = providerRegistry;
    this.registerDefaults();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Register (or replace) the builtin model list for a provider. */
  registerBuiltinModels(providerId: string, models: ModelInfo[]): void {
    this.builtinModels.set(providerId, models);
  }

  /** Retrieve the static builtin models for a provider. */
  getModels(providerId: string): ModelInfo[] {
    return this.builtinModels.get(providerId) || [];
  }

  /** Look up a specific model by provider + model id. */
  getModel(providerId: string, modelId: string): ModelInfo | undefined {
    const models = this.builtinModels.get(providerId);
    return models?.find((m) => m.id === modelId);
  }

  /**
   * Discover models from the provider's API.  Results are cached for 5 min.
   *
   * Falls back to an empty array on failure — never throws.
   */
  async discoverModels(
    providerId: string,
    apiKey: string,
    baseUrl?: string,
  ): Promise<ModelInfo[]> {
    const cacheKey = `${providerId}:${baseUrl || ''}`;
    const cached = this.discoveryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.models;
    }

    if (!this.providerRegistry) return [];

    const provider = this.providerRegistry.get(providerId);
    if (!provider) return [];

    try {
      const models = await provider.listModels(apiKey, baseUrl);
      // Discovery outranks the static table (§4.1.2). The adapters that can
      // report a REAL ceiling already learn it themselves; this feeds anything
      // reached through the registry, including third-party providers.
      //
      // A ceiling that is EXACTLY the product default is skipped, because that
      // is precisely what `listModels` returns when it has nothing to report —
      // neither the Anthropic nor the OpenAI models endpoint carries an output
      // ceiling, so both fall back to it (see the notes in their adapters).
      // Learning it here at `'discovery'` rank would launder that placeholder
      // into an assertion that outranks the static table, and would collapse the
      // distinction `staticCeilingFor`'s `undefined` return exists to keep:
      // "unknown" would become "capped at 64000", silently clamping an explicit
      // larger request the user is entitled to make against a proxy. Skipping it
      // costs nothing — AUTO tops out at the default anyway, and a genuinely
      // over-large request is repaired by `output-limit-recovery.ts`.
      for (const model of models) {
        if (model.maxOutputTokens === DEFAULT_MAX_OUTPUT_TOKENS) continue;
        learnModelCeiling(providerId, model.id, model.maxOutputTokens, 'discovery');
      }
      this.discoveryCache.set(cacheKey, { models, timestamp: Date.now() });
      return models;
    } catch {
      return [];
    }
  }

  /** Invalidate the discovery cache for a provider (or all). */
  clearCache(providerId?: string): void {
    if (providerId) {
      for (const key of this.discoveryCache.keys()) {
        if (key.startsWith(`${providerId}:`)) {
          this.discoveryCache.delete(key);
        }
      }
    } else {
      this.discoveryCache.clear();
    }
  }

  /**
   * Build a runtime ModelInfo for a model that isn't in the registry.
   *
   * Uses sensible defaults — callers can override specific fields.
   */
  buildRuntimeModel(
    providerId: string,
    modelId: string,
    overrides?: Partial<ModelInfo>,
  ): ModelInfo {
    return {
      id: modelId,
      name: modelId,
      provider: providerId,
      contextWindow: 128_000,
      // The PRODUCT DEFAULT, not a private guess. An unknown model that claims a
      // ceiling nothing else agrees with is how one part of the system clamps
      // output the rest of it never asked for.
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      supportsThinking: false,
      supportsTools: true,
      supportsImages: false,
      cost: { input: 0, output: 0 },
      ...overrides,
    };
  }

  /** Set or replace the provider registry reference. */
  setProviderRegistry(registry: ProviderRegistry): void {
    this.providerRegistry = registry;
  }

  // -----------------------------------------------------------------------
  // Default builtin models (migrated from src/lib/model-options.ts)
  // -----------------------------------------------------------------------

  private registerDefaults(): void {
    this.builtinModels.set('anthropic', ANTHROPIC_MODELS);
    this.builtinModels.set('openai', OPENAI_MODELS);
    this.builtinModels.set('google', GOOGLE_MODELS);
    this.builtinModels.set('xai', XAI_MODELS);
    this.builtinModels.set('groq', GROQ_MODELS);

    // Seed the shared ceiling cache at the LOWEST rank, so discovery and
    // recovery both override it. Without this the catalog's per-model knowledge
    // is never consulted when a request body is built — the table is read by the
    // model picker and by nothing else.
    for (const models of this.builtinModels.values()) {
      for (const model of models) {
        learnModelCeiling(model.provider, model.id, model.maxOutputTokens, 'catalog');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Builtin model lists
//
// `maxOutputTokens` here MUST agree with `CEILING_TABLE` in `output-limits.ts`.
// The two are consulted by different code paths — this one by the model picker,
// that one when a request body is built — and a disagreement shows up as
// "the picker says 64000 but my answers stop at 8192", which is unattributable
// from a transcript.
// ---------------------------------------------------------------------------

const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    supportsTools: true,
    supportsImages: true,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    supportsTools: true,
    supportsImages: true,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsThinking: true,
    supportsTools: true,
    supportsImages: true,
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },
];

const OPENAI_MODELS: ModelInfo[] = [
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsThinking: false,
    supportsTools: true,
    supportsImages: true,
    cost: { input: 2.5, output: 10 },
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsThinking: false,
    supportsTools: true,
    supportsImages: true,
    cost: { input: 0.15, output: 0.6 },
  },
  {
    id: 'o1',
    name: 'o1',
    provider: 'openai',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsThinking: false,
    supportsTools: true,
    supportsImages: true,
    cost: { input: 15, output: 60 },
  },
  {
    id: 'o1-mini',
    name: 'o1 Mini',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 65_536,
    supportsThinking: false,
    supportsTools: true,
    supportsImages: false,
    cost: { input: 3, output: 12 },
  },
];

const GOOGLE_MODELS: ModelInfo[] = [
  {
    id: 'gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    provider: 'google',
    contextWindow: 2_097_152,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsImages: true,
    cost: { input: 1.25, output: 5 },
  },
  {
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    provider: 'google',
    contextWindow: 1_048_576,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsImages: true,
    cost: { input: 0.075, output: 0.3 },
  },
];

const XAI_MODELS: ModelInfo[] = [
  {
    id: 'grok-2',
    name: 'Grok-2',
    provider: 'xai',
    contextWindow: 131_072,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsImages: false,
    cost: { input: 2, output: 10 },
  },
];

const GROQ_MODELS: ModelInfo[] = [
  {
    id: 'llama-3.1-70b-versatile',
    name: 'Llama 3.1 70B',
    provider: 'groq',
    contextWindow: 131_072,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsImages: false,
    cost: { input: 0.59, output: 0.79 },
  },
  {
    id: 'mixtral-8x7b-32768',
    name: 'Mixtral 8x7B',
    provider: 'groq',
    contextWindow: 32_768,
    maxOutputTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsImages: false,
    cost: { input: 0.24, output: 0.24 },
  },
];

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _singleton: ModelRegistry | undefined;

/**
 * Get (or lazily create) the global singleton model registry.
 */
export function getModelRegistry(): ModelRegistry {
  if (!_singleton) {
    _singleton = new ModelRegistry();
  }
  return _singleton;
}

/**
 * Replace the global singleton (useful for testing or re-initialization
 * with a provider registry reference).
 */
export function setModelRegistry(registry: ModelRegistry): void {
  _singleton = registry;
}
