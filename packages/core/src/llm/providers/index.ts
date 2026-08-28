/**
 * Provider registry — manages all registered LLM providers and provides
 * convenience methods for streaming and completion.
 */

import type { AssistantMessage, ModelInfo, StreamEvent } from '../types.js';
import type { LLMProvider, LLMRequest } from '../provider.js';
import { LLMError } from '../provider.js';
import { DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from '../retry.js';
import { consumeStream } from '../stream-utils.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

export interface ProviderRegistryOptions {
  /**
   * Retry policy for `stream()` and (through it) `complete()`.
   *
   * `undefined` and `null` MEAN DIFFERENT THINGS, exactly as they do for
   * `PersistedConfig.maxTokens`: absent means "the product default"
   * (`DEFAULT_RETRY_POLICY`), explicit `null` means "the user said no".
   */
  retryPolicy?: RetryPolicy | null;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();
  private retryPolicy: RetryPolicy | null;

  constructor(options: ProviderRegistryOptions = {}) {
    this.retryPolicy =
      options.retryPolicy === undefined ? DEFAULT_RETRY_POLICY : options.retryPolicy;
  }

  /** Register a provider. Overwrites any existing registration with the same id. */
  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  /**
   * Install a retry policy live, or `null` to opt out entirely.
   *
   * A METHOD RATHER THAN A CONSTRUCTOR-ONLY CONCERN because the CLI's `/retry
   * off` has to take effect in the running session: persisting the setting and
   * changing nothing until the next launch is the failure users report as "the
   * setting does nothing".
   */
  setRetryPolicy(policy: RetryPolicy | null): void {
    this.retryPolicy = policy;
  }

  getRetryPolicy(): RetryPolicy | null {
    return this.retryPolicy;
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
   * Convenience: stream a completion through the named provider, WITH RETRY.
   *
   * THIS IS THE SEAM THE WHOLE RETRY FEATURE HANGS ON (llm-api-retry-backoff
   * §5.2). Wrapping here rather than inside each adapter is what lets the retry
   * see the commit point, the abort signal and the whole event stream at once,
   * and it is why the lead agent, every subagent and `completeLLM` all inherit
   * retry with zero call-site changes.
   *
   * The thunk captures `request` WHOLE, so every attempt sends the same body —
   * including any `max_tokens` that `sendWithOutputLimitRecovery` repaired on the
   * way through, because that repair lives inside `provider.stream()` and re-runs
   * per attempt.
   *
   * `maxRetries <= 0` returns the adapter's iterator DIRECTLY rather than a
   * wrapper that happens to never retry: an opted-out caller is then byte- and
   * allocation-identical to a pre-feature build.
   *
   * @throws {LLMError} if the provider is not registered.
   */
  stream(providerId: string, request: LLMRequest): AsyncIterableIterator<StreamEvent> {
    const provider = this.resolveProvider(providerId);
    const policy = this.retryPolicy;
    if (!policy || policy.maxRetries <= 0) return provider.stream(request);
    return withRetry(() => provider.stream(request), {
      policy,
      providerId,
      modelId: request.model,
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }

  /**
   * Convenience: non-streaming completion through the named provider.
   *
   * ROUTED THROUGH `this.stream()`, NOT `provider.complete()`, and that is not
   * optional (§5.4). All three adapters implement `complete` as exactly
   * `consumeStream(this.stream(request))`, so this is behaviour-preserving — the
   * only difference is that the registry's version is now the RETRYING one.
   * Calling `provider.complete()` here would leave `completeLLM` as the one
   * public entry point with no retry at all, which is exactly the kind of hole
   * that gets discovered in production.
   *
   * @throws {LLMError} if the provider is not registered.
   */
  async complete(providerId: string, request: LLMRequest): Promise<AssistantMessage> {
    return consumeStream(this.stream(providerId, request));
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
 *
 * `options` is additive and source-compatible: every existing `initProviders()`
 * call site compiles unchanged and gets `DEFAULT_RETRY_POLICY`.
 */
export function initProviders(options?: ProviderRegistryOptions): ProviderRegistry {
  const registry = new ProviderRegistry(options);
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
 *
 * IT IS A SEPARATE REGISTRY AND IT KEEPS THE PRODUCT DEFAULT RETRY POLICY
 * (llm-api-retry-backoff §5.3). It is built here with `initProviders()` and no
 * arguments, and a host that constructs its own registry (the CLI does) never
 * installs it — so `streamLLM` / `completeLLM` retry with
 * `DEFAULT_RETRY_POLICY` and do NOT observe that host's `/retry off` equivalent.
 * Harmless while nothing calls those two helpers, and deliberately not "fixed"
 * by having a UI mutate process-wide state. An embedder that wants one policy
 * everywhere calls `setProviderRegistry(initProviders({ retryPolicy }))` once at
 * startup.
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
