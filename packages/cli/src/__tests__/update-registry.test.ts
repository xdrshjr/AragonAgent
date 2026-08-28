/**
 * The registry check (cli-auto-update §3.3 / §8.1).
 *
 * FULLY OFFLINE: every call goes through an injected `fetchImpl`, so this file
 * opens no socket and depends on no network.
 *
 * THE ONE PROPERTY WORTH PINNING IS THAT NOTHING THROWS. Every caller of
 * `fetchLatestManifest` is a background timer whose entire contract is that the
 * user does not find out, so a 500, a redirect loop, an HTML error page, an
 * oversize body and an aborted request must all resolve to `null` and be counted
 * as one consecutive failure — never propagate out of a `setTimeout` callback,
 * where an unhandled rejection would take the whole TUI down.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REGISTRY,
  fetchLatestManifest,
  manifestUrl,
  resolveRegistryUrl,
} from '../update/registry.js';
import { UPDATE_LIMITS } from '../update/limits.js';

const NAME = '@aragon-agent/cli';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('manifestUrl', () => {
  it('percent-encodes the scope separator', () => {
    // The documented registry path form for a scoped package. A literal `/`
    // here asks for a package named `cli` under a directory named
    // `@aragon-agent`, which the registry answers with a 404.
    expect(manifestUrl('https://registry.npmjs.org', NAME, 'latest')).toBe(
      'https://registry.npmjs.org/%40aragon-agent%2Fcli/latest',
    );
  });

  it('tolerates a trailing slash on the registry', () => {
    expect(manifestUrl('https://mirror.example.com/', NAME, 'next')).toBe(
      'https://mirror.example.com/%40aragon-agent%2Fcli/next',
    );
  });
});

describe('resolveRegistryUrl — config › ARAGON_UPDATE_REGISTRY › npm_config_registry', () => {
  it('prefers the configured value', () => {
    expect(
      resolveRegistryUrl('https://a.example.com', {
        ARAGON_UPDATE_REGISTRY: 'https://b.example.com',
        npm_config_registry: 'https://c.example.com',
      }),
    ).toBe('https://a.example.com');
  });

  it('falls through to the env vars in order', () => {
    expect(
      resolveRegistryUrl('', {
        ARAGON_UPDATE_REGISTRY: 'https://b.example.com',
        npm_config_registry: 'https://c.example.com',
      }),
    ).toBe('https://b.example.com');
    // This one is what makes `aragon` inherit an enterprise mirror with no
    // configuration at all.
    expect(resolveRegistryUrl('', { npm_config_registry: 'https://c.example.com' })).toBe(
      'https://c.example.com',
    );
  });

  it('accepts an http: LAN mirror but nothing else', () => {
    expect(resolveRegistryUrl('http://npm.internal', {})).toBe('http://npm.internal');
    // A background timer must degrade to "checks the public registry", never to
    // an error the user cannot see the cause of.
    for (const bad of ['file:///etc/passwd', 'ftp://x', 'not a url', '   ']) {
      expect(resolveRegistryUrl(bad, {}), bad).toBe(DEFAULT_REGISTRY);
    }
  });

  it('strips a trailing slash so the URL never doubles it', () => {
    expect(resolveRegistryUrl('https://mirror.example.com/', {})).toBe(
      'https://mirror.example.com',
    );
  });
});

describe('fetchLatestManifest — never throws (§3.3)', () => {
  it('returns the parsed manifest on 200', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        name: NAME,
        version: '0.6.0',
        engines: { node: '>=18' },
        dist: { tarball: 'https://x/y.tgz' },
      }),
    );
    const manifest = await fetchLatestManifest(DEFAULT_REGISTRY, NAME, 'latest', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(manifest).toEqual({ name: NAME, version: '0.6.0', engines: { node: '>=18' } });
  });

  it('carries `deprecated` through, whatever type the registry used', async () => {
    // npm writes a string, but `true` appears in the wild; both mean "do not
    // auto-install this", and the decision gate only tests for presence.
    for (const value of ['use 0.7 instead', true]) {
      const manifest = await fetchLatestManifest(DEFAULT_REGISTRY, NAME, 'latest', {
        fetchImpl: (async () =>
          jsonResponse({ name: NAME, version: '0.6.0', deprecated: value })) as never,
      });
      expect(manifest?.deprecated).toBe(String(value));
    }
  });

  it('sends Accept and a versioned User-Agent, and NO credentials (D-13)', async () => {
    // An updater that attaches a token to a user-configurable URL is a
    // credential-exfiltration primitive the moment `update.registry` is mis-set.
    const seen: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init);
      return jsonResponse({ name: NAME, version: '0.6.0' });
    });
    await fetchLatestManifest(DEFAULT_REGISTRY, NAME, 'latest', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      userAgent: 'aragon-agent-cli/0.5.9',
    });
    const init = seen[0] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json');
    expect(headers['User-Agent']).toBe('aragon-agent-cli/0.5.9');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(init.redirect).toBe('manual');
  });

  it('returns null for 404, 500 and a body that is not a manifest', async () => {
    const cases: [string, () => Response][] = [
      ['404', () => new Response('not found', { status: 404 })],
      ['500', () => new Response('boom', { status: 500 })],
      ['html', () => new Response('<html>proxy login</html>', { status: 200 })],
      ['json without version', () => jsonResponse({ name: NAME })],
      ['json without name', () => jsonResponse({ version: '0.6.0' })],
      ['json array', () => jsonResponse([1, 2, 3])],
    ];
    for (const [label, make] of cases) {
      const manifest = await fetchLatestManifest(DEFAULT_REGISTRY, NAME, 'latest', {
        fetchImpl: (async () => make()) as never,
      });
      expect(manifest, label).toBeNull();
    }
  });

  it('returns null when the transport throws or aborts', async () => {
    const manifest = await fetchLatestManifest(DEFAULT_REGISTRY, NAME, 'latest', {
      fetchImpl: (async () => {
        throw new Error('ENOTFOUND registry.npmjs.org');
      }) as never,
    });
    expect(manifest).toBeNull();
  });

  it('aborts on the timeout rather than hanging the check', async () => {
    // The one failure a background timer cannot survive is one that never ends:
    // the service would sit in `checking` forever and never schedule again.
    const manifest = await fetchLatestManifest(DEFAULT_REGISTRY, NAME, 'latest', {
      timeoutMs: 5,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as never,
    });
    expect(manifest).toBeNull();
  });

  it('follows redirects, re-checking the scheme on EVERY hop', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      if (seen.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://mirror.example.com/pkg' },
        });
      }
      return jsonResponse({ name: NAME, version: '0.6.0' });
    }) as never;
    const manifest = await fetchLatestManifest(DEFAULT_REGISTRY, NAME, 'latest', { fetchImpl });
    expect(manifest?.version).toBe('0.6.0');
    expect(seen[1]).toBe('https://mirror.example.com/pkg');
  });

  it('refuses a redirect that leaves http(s) — a free SSRF otherwise', async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'file:///etc/passwd' },
      })) as never;
    expect(await fetchLatestManifest(DEFAULT_REGISTRY, NAME, 'latest', { fetchImpl })).toBeNull();
  });

  it('gives up on a redirect loop rather than spinning', async () => {
    let hops = 0;
    const fetchImpl = (async () => {
      hops += 1;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://registry.npmjs.org/loop' },
      });
    }) as never;
    expect(await fetchLatestManifest(DEFAULT_REGISTRY, NAME, 'latest', { fetchImpl })).toBeNull();
    expect(hops).toBeLessThanOrEqual(UPDATE_LIMITS.maxRedirects + 1);
  });

  it('refuses a redirect with no Location header', async () => {
    const fetchImpl = (async () => new Response(null, { status: 302 })) as never;
    expect(await fetchLatestManifest(DEFAULT_REGISTRY, NAME, 'latest', { fetchImpl })).toBeNull();
  });

  it('rejects an oversize body by its declared length AND by the running total', async () => {
    // Content-Length is advisory, so both gates are needed: a lying header would
    // otherwise stream an unbounded body into memory.
    const declared = (async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(UPDATE_LIMITS.manifestMaxBytes + 1) },
      })) as never;
    expect(await fetchLatestManifest(DEFAULT_REGISTRY, NAME, 'latest', { fetchImpl: declared }))
      .toBeNull();

    const huge = 'x'.repeat(UPDATE_LIMITS.manifestMaxBytes + 10);
    const streamed = (async () => new Response(huge, { status: 200 })) as never;
    expect(await fetchLatestManifest(DEFAULT_REGISTRY, NAME, 'latest', { fetchImpl: streamed }))
      .toBeNull();
  });
});
