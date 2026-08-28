/**
 * The registry check (cli-auto-update section 3.3).
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope (C-2 / C-3).
 *
 * One `GET`, one small JSON document, and NEVER A THROW. Transport rules follow
 * C-8 verbatim - `AbortController` timeout, `redirect: 'manual'` with the
 * allow-check repeated on every hop, a running byte ceiling, an injectable
 * `fetchImpl` so every test is offline.
 *
 * NO CREDENTIALS, EVER (D-13). An updater that reads `_authToken` out of
 * `.npmrc` and attaches it to a user-configurable URL is a credential
 * exfiltration primitive the moment `update.registry` is mis-set. Private
 * registry users point `update.registry` at a mirror they can read anonymously,
 * or set `update.mode: off`.
 */

import process from 'node:process';
import { UPDATE_LIMITS } from './limits.js';
import type { LatestManifest } from './types.js';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

export interface RegistryDeps {
  fetchImpl?: typeof fetch;
  /** `aragon-agent-cli/<version>`; identifies us to the registry's logs. */
  userAgent?: string;
  timeoutMs?: number;
}

/**
 * `config.update.registry` -> `ARAGON_UPDATE_REGISTRY` -> `npm_config_registry`
 * -> the default.
 *
 * A value that does not parse as `http(s):` FALLS BACK rather than throwing:
 * this runs on a background timer, and a typo in a config file must degrade to
 * "checks the public registry" and not to "the CLI reports an error it cannot
 * explain". `npm_config_registry` is read last and is what makes `aragon`
 * inherit an enterprise mirror with no configuration at all.
 */
export function resolveRegistryUrl(
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const candidates = [configured, env.ARAGON_UPDATE_REGISTRY, env.npm_config_registry];
  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (!text) continue;
    try {
      const url = new URL(text);
      // `http:` is accepted for a LAN mirror; nothing else is a registry.
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        return text.replace(/\/+$/, '');
      }
    } catch {
      // Fall through to the next candidate.
    }
  }
  return DEFAULT_REGISTRY;
}

/**
 * `<registry>/@scope%2Fname/<distTag>`.
 *
 * THE SCOPE SEPARATOR MUST BE PERCENT-ENCODED. `encodeURIComponent` does that
 * and also makes the name safe to interpolate, which matters because the name
 * comes from a manifest on disk rather than from a literal here (U-1).
 */
export function manifestUrl(registry: string, name: string, distTag: string): string {
  return `${registry.replace(/\/+$/, '')}/${encodeURIComponent(name)}/${encodeURIComponent(distTag)}`;
}

function isRegistryUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Read a response body, aborting as soon as it passes `maxBytes` (C-8). */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`registry response is ${declared} bytes (max ${maxBytes})`);
  }
  const body = response.body;
  // No stream (a mocked `Response`, or a 204): fall back to `text()`, which the
  // Content-Length gate above has already bounded when the header was honest.
  if (!body) {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error(`registry response exceeded ${maxBytes} bytes`);
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Content-Length is advisory; the running total is the real gate.
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`registry response exceeded ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
}

/**
 * Fetch the dist-tag document, or `null`.
 *
 * NEVER THROWS. Any non-2xx, any parse failure, any timeout, any redirect loop
 * and any oversize body all resolve to `null`, because every caller is a
 * background timer whose entire contract is that the user does not find out. The
 * caller counts a `null` as one consecutive failure and backs off.
 */
export async function fetchLatestManifest(
  registry: string,
  name: string,
  distTag: string,
  deps: RegistryDeps = {},
): Promise<LatestManifest | null> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? UPDATE_LIMITS.checkTimeoutMs;
  let current = manifestUrl(registry, name, distTag);

  try {
    for (let hop = 0; hop <= UPDATE_LIMITS.maxRedirects; hop += 1) {
      // Re-checked on EVERY hop: a registry that 302s to `file:` or to an
      // internal address would otherwise be a free SSRF (C-8).
      if (!isRegistryUrl(current)) return null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            'User-Agent': deps.userAgent ?? 'aragon-agent-cli',
          },
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return null;
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) return null;

      const text = await readCapped(response, UPDATE_LIMITS.manifestMaxBytes);
      const parsed = JSON.parse(text) as Partial<LatestManifest>;
      if (typeof parsed?.name !== 'string' || typeof parsed?.version !== 'string') return null;
      return {
        name: parsed.name,
        version: parsed.version,
        ...(parsed.engines && typeof parsed.engines === 'object'
          ? { engines: { ...(typeof parsed.engines.node === 'string'
              ? { node: parsed.engines.node }
              : {}) } }
          : {}),
        // Present ONLY when the version is deprecated. npm writes a string, but
        // `true` appears in the wild; both mean "do not auto-install this".
        ...(parsed.deprecated !== undefined
          ? { deprecated: String(parsed.deprecated) }
          : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}
