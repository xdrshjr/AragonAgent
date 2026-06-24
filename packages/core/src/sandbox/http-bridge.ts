/**
 * CodeAct Sandbox — HTTP Bridge
 *
 * Provides a domain-whitelisted `fetch` function inside the isolated-vm
 * sandbox. All HTTP requests are proxied through the host process using
 * Node.js native fetch, with configurable timeout and response size limits.
 */

import ivm from 'isolated-vm';

/** Configuration for the HTTP bridge. */
export interface HttpBridgeConfig {
  /** Allowed hostnames. Requests to unlisted hosts are rejected. */
  allowedHosts: string[];

  /** Per-request timeout in milliseconds. Default: 10_000. */
  timeout?: number;

  /** Maximum response body size in bytes. Default: 1_048_576 (1 MB). */
  maxResponseSize?: number;
}

/** Default request timeout (10 seconds). */
const DEFAULT_TIMEOUT = 10_000;

/** Default maximum response body size (1 MB). */
const DEFAULT_MAX_RESPONSE_SIZE = 1_048_576;

/**
 * Simplified response object returned to sandbox code.
 * Mirrors the shape expected by callers: `{ status, statusText, headers, body }`.
 */
interface SandboxFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * HttpBridge injects a `globalThis.fetch` function into the sandbox that
 * proxies requests through the host with domain whitelisting.
 */
export class HttpBridge {
  private readonly allowedHosts: Set<string>;
  private readonly timeout: number;
  private readonly maxResponseSize: number;

  constructor(config: HttpBridgeConfig) {
    this.allowedHosts = new Set(config.allowedHosts.map((h) => h.toLowerCase()));
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.maxResponseSize = config.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
  }

  /**
   * Inject the `fetch` global async function into the given context.
   * Sandbox signature: `async function fetch(url, options?) => { status, statusText, headers, body }`
   */
  async inject(context: ivm.Context): Promise<void> {
    const fetchRef = new ivm.Reference(
      async (requestJson: string): Promise<string> => {
        const { url, options } = JSON.parse(requestJson) as {
          url: string;
          options?: { method?: string; headers?: Record<string, string>; body?: string };
        };

        // --- Domain whitelist check ---
        const hostname = this.extractHostname(url);
        if (!this.allowedHosts.has(hostname.toLowerCase())) {
          throw new Error(
            `HTTP request blocked: hostname "${hostname}" is not in the allowed hosts list`,
          );
        }

        // --- Execute host-side fetch with timeout ---
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        try {
          const response = await fetch(url, {
            method: options?.method ?? 'GET',
            headers: options?.headers,
            body: options?.body,
            signal: controller.signal,
            // SECURITY: Do not follow redirects automatically.
            // A whitelisted domain could redirect to an internal service (SSRF).
            redirect: 'manual',
          });

          // Read body with size limit enforcement.
          const body = await this.readBodyWithLimit(response);

          // Collect response headers into a plain object.
          const headers: Record<string, string> = {};
          response.headers.forEach((value, key) => {
            headers[key] = value;
          });

          const result: SandboxFetchResponse = {
            status: response.status,
            statusText: response.statusText,
            headers,
            body,
          };

          return JSON.stringify(result);
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            throw new Error(`HTTP request timed out after ${this.timeout}ms`);
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
    );

    // Register fetch in the sandbox. The sandbox function serializes
    // arguments to JSON, sends to host, and deserializes the response.
    await context.evalClosure(
      `globalThis.fetch = async function(url, options) {
        const requestJson = JSON.stringify({ url, options });
        const responseJson = await $0.apply(undefined, [requestJson], { result: { promise: true } });
        return JSON.parse(responseJson);
      }`,
      [fetchRef],
      { arguments: { reference: true } },
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Allowed URL protocols. Blocks file://, data://, etc. */
  private static readonly ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

  /**
   * Extract hostname from a URL string and validate protocol.
   * Throws if the URL is malformed or uses a disallowed protocol.
   */
  private extractHostname(url: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: "${url}"`);
    }

    // SECURITY: Only allow http/https to prevent file://, data://, etc.
    if (!HttpBridge.ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw new Error(
        `Blocked URL protocol "${parsed.protocol}" — only http: and https: are allowed`,
      );
    }

    return parsed.hostname;
  }

  /**
   * Read the response body as text, enforcing the maximum size limit.
   * If the body exceeds the limit, it is truncated and a warning appended.
   *
   * NOTE: We always stream-read to enforce the limit, regardless of
   * Content-Length header (which can be spoofed by the remote server).
   */
  private async readBodyWithLimit(response: Response): Promise<string> {
    // Stream-read with size enforcement.
    const reader = response.body?.getReader();
    if (!reader) {
      return '';
    }

    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalBytes += value.byteLength;
        if (totalBytes > this.maxResponseSize) {
          // Decode what we have so far and truncate.
          chunks.push(decoder.decode(value, { stream: false }));
          chunks.push(`\n\n[Response truncated at ${this.maxResponseSize} bytes]`);
          break;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }

    return chunks.join('');
  }
}
