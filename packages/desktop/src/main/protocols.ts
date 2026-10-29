/**
 * How the renderer is loaded and what it may do (spec 3.8).
 *
 * The page is served from the custom `app://` scheme rather than `file://`: under `file://`
 * every page is its own origin, `'self'` in a CSP is unreliable, and `fetch`/`Worker` are
 * restricted. `registerSchemes()` MUST run before `app.ready` (Electron rejects a late
 * registration), which is why `main/index.ts` calls it at module scope.
 *
 * Pure helpers (`resolveRendererFile`, `buildCsp`, `isAllowedNavigation`, `isSafeExternalUrl`)
 * are exported separately and unit-tested; the Electron glue below only wires them up.
 */

import { existsSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, net, protocol, session } from 'electron';
import type { Asset } from './asset-resolver.js';

export const APP_SCHEME = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://renderer`;
export const ASSET_SCHEME = 'aragon-asset';

import { buildCsp } from '../shared/csp.js';

export { INLINE_STYLE_HASHES, buildCsp } from '../shared/csp.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.map': 'application/json',
};

/** Must be called before `app.whenReady()`. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: ASSET_SCHEME, privileges: { secure: true } },
  ]);
}

/**
 * Map a request path to a file under `root`, or null. Containment is a PATH-SEGMENT check
 * (`relative` must not start with `..`): a prefix test would accept `/dist/renderer-evil`
 * as "inside" `/dist/renderer`. A path with no extension is a client-side route and falls
 * back to `index.html`; one WITH an extension that does not exist is a real 404.
 */
export function resolveRendererFile(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const target = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  const rel = relative(root, target);
  if (rel.startsWith('..') || resolve(root, rel) !== target || rel.split(sep).includes('..')) return null;
  if (existsSync(target) && statSync(target).isFile()) return target;
  if (extname(decoded) === '') {
    const index = join(root, 'index.html');
    return existsSync(index) ? index : null;
  }
  return null;
}

/** The only origins a window may navigate to: the app itself (and the dev server). */
export function isAllowedNavigation(url: string, devServer: string | null): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === `${APP_SCHEME}:`) return parsed.host === 'renderer';
    return devServer !== null && parsed.origin === new URL(devServer).origin;
  } catch {
    return false;
  }
}

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** Whether `shell.openExternal` may be given this URL: allow-listed scheme, no credentials. */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (!EXTERNAL_SCHEMES.has(parsed.protocol)) return false;
    return parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

/**
 * Response headers for a workspace asset. The type is fixed by us (never sniffed), `sandbox`
 * keeps even a directly navigated SVG from running script, and nothing is cached because the
 * file belongs to a directory the agent may be rewriting right now.
 */
export function assetHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'no-store',
  };
}

export interface ProtocolOptions {
  rendererRoot: string;
  devServer: string | null;
  /** Resolve an `aragon-asset://<sessionId>/<relative path>` request to image bytes, or null. */
  resolveAsset(sessionId: string, relPath: string): Promise<Asset | null>;
}

/** Register the handlers and the CSP header. Call after `app.whenReady()`. */
export function installProtocols(options: ProtocolOptions): void {
  const csp = buildCsp(options.devServer);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'renderer') return new Response('Not found', { status: 404 });
    const file = resolveRendererFile(options.rendererRoot, url.pathname);
    if (!file) return new Response('Not found', { status: 404 });
    const upstream = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(upstream.headers);
    headers.set('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
    headers.set('Content-Security-Policy', csp);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(upstream.body, { status: upstream.status, headers });
  });
  protocol.handle(ASSET_SCHEME, async (request) => {
    const url = new URL(request.url);
    let relPath: string;
    try {
      relPath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const asset = request.method === 'GET' ? await options.resolveAsset(url.host, relPath) : null;
    if (!asset) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(asset.body), { status: 200, headers: assetHeaders(asset.contentType) });
  });
  // The dev server does not go through `protocol.handle`, so the policy is attached to its
  // responses here; for `app://` it is already on the response above.
  if (options.devServer) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
    });
  }
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event: { preventDefault(): void }, url: string): void => {
      if (!isAllowedNavigation(url, options.devServer)) event.preventDefault();
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
