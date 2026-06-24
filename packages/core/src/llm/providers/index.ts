/**
 * Provider registry — manages all registered LLM providers and provides
 * convenience methods for streaming and completion.
 */

import type { AssistantMessage, ModelInfo, StreamEvent } from '../types.js';
import type { LLMProvider, LLMRequest } from '../provider.js';
import { LLMError } from '../provider.js';
import { consumeStream } from '../stream-utils.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

export class ProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();

  /** Register a provider. Overwrites any existing registration with the same id. */
  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Retrieve a provider by id. */
  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  /** Return all registered providers. */
  getAll(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  /** Check whether a provider is registered. */
  has(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * Convenience: stream a completion through the named provider.
   *
   * @throws {LLMError} if the provider is not registered.
   */
  stream(providerId: string, request: LLMRequest): AsyncIterableIterator<StreamEvent> {
    const provider = this.resolveProvider(providerId);
    return provider.stream(request);
  }

  /**
   * Convenience: non-streaming completion through the named provider.
   *
   * @throws {LLMError} if the provider is not registered.
   */
  async complete(providerId: string, request: LLMRequest): Promise<AssistantMessage> {
    const provider = this.resolveProvider(providerId);
    return provider.complete(request);
  }

  /**
   * Convenience: list models from the named provider.
   *
   * @throws {LLMError} if the provider is not registered.
   */
  async listModels(
    providerId: string,
    apiKey: string,
    baseUrl?: string,
  ): Promise<ModelInfo[]> {
    const provider = this.resolveProvider(providerId);
    return provider.listModels(apiKey, baseUrl);
  }

  /** Get the default base URL for a provider. */
  getDefaultBaseUrl(providerId: string): string {
    return this.providers.get(providerId)?.defaultBaseUrl ?? '';
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private resolveProvider(id: string): LLMProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new LLMError(
        `Unknown LLM provider: "${id}". Registered providers: ${Array.from(this.providers.keys()).join(', ')}`,
        id,
        'invalid_request',
        false,
      );
    }
    return provider;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and populate a {@link ProviderRegistry} with all built-in providers.
 * Call this once at server startup.
 */
export function initProviders(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new AnthropicProvider());
  registry.register(new OpenAIProvider());
  registry.register(new GoogleProvider());
  return registry;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _singleton: ProviderRegistry | undefined;

/**
 * Get (or lazily create) the global singleton provider registry.
 *
 * Prefer calling `initProviders()` explicitly at startup and passing the
 * registry around.  This singleton exists as a convenience for modules that
 * cannot easily receive the registry through dependency injection.
 */
export function getProviderRegistry(): ProviderRegistry {
  if (!_singleton) {
    _singleton = initProviders();
  }
  return _singleton;
}

/**
 * Replace the global singleton (useful for testing).
 */
export function setProviderRegistry(registry: ProviderRegistry): void {
  _singleton = registry;
}

// ---------------------------------------------------------------------------
// Top-level convenience functions (replacements for pi-ai helpers)
// ---------------------------------------------------------------------------

/**
 * Stream a completion — drop-in replacement for `pi-ai` `streamSimple`.
 *
 * Uses the global singleton registry.
 */
export function streamLLM(
  providerId: string,
  request: LLMRequest,
): AsyncIterableIterator<StreamEvent> {
  return getProviderRegistry().stream(providerId, request);
}

/**
 * Non-streaming completion — drop-in replacement for `pi-ai` `completeSimple`.
 *
 * Uses the global singleton registry.
 */
export async function completeLLM(
  providerId: string,
  request: LLMRequest,
): Promise<AssistantMessage> {
  return getProviderRegistry().complete(providerId, request);
}
