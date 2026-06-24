/**
 * LLM Provider interface, request types, and error classification.
 */

import type {
  AssistantMessage,
  Message,
  ModelInfo,
  StreamEvent,
  ThinkingLevel,
  ToolDefinition,
} from './types.js';

// ---------------------------------------------------------------------------
// LLMRequest
// ---------------------------------------------------------------------------

export interface LLMRequest {
  /** Model identifier, e.g. 'claude-sonnet-4-5-20250929'. */
  model: string;

  /** Conversation messages. */
  messages: Message[];

  /** System prompt — injected provider-appropriately (system field, system message, etc.). */
  systemPrompt?: string;

  /** Tool schemas the model may invoke. */
  tools?: ToolDefinition[];

  /** Provider API key. */
  apiKey: string;

  /** Override the default API base URL. */
  baseUrl?: string;

  /** Abort signal for cancellation. */
  signal?: AbortSignal;

  // -- Optional generation parameters --

  temperature?: number;
  maxTokens?: number;

  /** Anthropic extended thinking level. Ignored by non-Anthropic providers. */
  thinkingLevel?: ThinkingLevel;

  /** Explicit thinking budget (tokens).  Overrides thinkingLevel if both are set. */
  thinkingBudget?: number;

  stopSequences?: string[];
}

// ---------------------------------------------------------------------------
// LLMProvider interface
// ---------------------------------------------------------------------------

export interface LLMProvider {
  /** Unique provider identifier, e.g. 'anthropic', 'openai', 'google'. */
  readonly id: string;

  /** Human-readable display name. */
  readonly displayName: string;

  /** Default base URL for this provider's API. */
  readonly defaultBaseUrl: string;

  /**
   * Stream a completion from the model.
   *
   * The returned iterator yields {@link StreamEvent} items and MUST terminate
   * with either a `done` or an `error` event.
   */
  stream(request: LLMRequest): AsyncIterableIterator<StreamEvent>;

  /**
   * Non-streaming completion — internally consumes the stream and returns the
   * final assembled {@link AssistantMessage}.
   */
  complete(request: LLMRequest): Promise<AssistantMessage>;

  /**
   * List models available under the given API key.
   *
   * Implementations should apply a reasonable timeout (15 s) and return an
   * empty array on failure rather than throwing.
   */
  listModels(apiKey: string, baseUrl?: string): Promise<ModelInfo[]>;
}

// ---------------------------------------------------------------------------
// LLMError
// ---------------------------------------------------------------------------

export type LLMErrorType =
  | 'auth_error'          // 401 — invalid or expired API key
  | 'rate_limit'          // 429 — throttled
  | 'overloaded'          // 529 — provider overloaded
  | 'invalid_request'     // 400 — malformed request
  | 'context_overflow'    // model-specific context length exceeded
  | 'network_error'       // fetch failed (DNS, TLS, etc.)
  | 'timeout'             // request timed out
  | 'server_error'        // 5xx (except 529)
  | 'unknown';

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly errorType: LLMErrorType,
    public readonly retryable: boolean,
    public readonly statusCode?: number,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/**
 * Classify an HTTP status code into an {@link LLMErrorType} and determine
 * whether the request is retryable.
 */
export function classifyHttpError(
  statusCode: number,
  body: string,
  provider: string,
): LLMError {
  let errorType: LLMErrorType;
  let retryable: boolean;

  switch (statusCode) {
    case 400:
      // Check for context overflow indicators
      if (/context|token|length/i.test(body)) {
        errorType = 'context_overflow';
        retryable = false;
      } else {
        errorType = 'invalid_request';
        retryable = false;
      }
      break;
    case 401:
    case 403:
      errorType = 'auth_error';
      retryable = false;
      break;
    case 429:
      errorType = 'rate_limit';
      retryable = true;
      break;
    case 529:
      errorType = 'overloaded';
      retryable = true;
      break;
    default:
      if (statusCode >= 500) {
        errorType = 'server_error';
        retryable = true;
      } else {
        errorType = 'unknown';
        retryable = false;
      }
  }

  // Truncate body for the error message to avoid huge payloads
  const truncated = body.length > 300 ? body.slice(0, 300) + '...' : body;
  return new LLMError(
    `${provider} API error ${statusCode}: ${truncated}`,
    provider,
    errorType,
    retryable,
    statusCode,
    body,
  );
}

/**
 * Wrap a network-level fetch error (DNS, TLS, abort, etc.) into an LLMError.
 */
export function wrapFetchError(err: unknown, provider: string): LLMError {
  if (err instanceof LLMError) return err;

  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof Error && err.name === 'AbortError') {
    return new LLMError(
      `${provider} request aborted: ${message}`,
      provider,
      'timeout',
      true,
    );
  }

  return new LLMError(
    `${provider} network error: ${message}`,
    provider,
    'network_error',
    true,
    undefined,
    err,
  );
}
