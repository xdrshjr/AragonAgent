/**
 * The page's trust boundary: which files `app://` serves, what the CSP allows, where a window
 * may navigate and which links may be handed to the OS. Each case is an attack that has a real
 * counterpart (path traversal, prefix confusion, a `javascript:` link in model output).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCsp, isAllowedNavigation, isSafeExternalUrl, resolveRendererFile } from '../protocols.js';

let root: string;
let sibling: string;

beforeAll(() => {
  const base = mkdtempSync(join(os.tmpdir(), 'aragon-protocols-'));
  root = join(base, 'renderer');
  sibling = join(base, 'renderer-evil');
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<html></html>');
  writeFileSync(join(root, 'assets', 'app.js'), 'x');
  writeFileSync(join(sibling, 'secret.txt'), 'secret');
});
afterAll(() => { rmSync(join(root, '..'), { recursive: true, force: true }); });

describe('resolveRendererFile', () => {
  it('serves files that exist under the root', () => {
    expect(resolveRendererFile(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'));
    expect(resolveRendererFile(root, '/index.html')).toBe(join(root, 'index.html'));
  });

  it('falls back to index.html for an extension-less route but 404s a missing asset', () => {
    expect(resolveRendererFile(root, '/settings/models')).toBe(join(root, 'index.html'));
    expect(resolveRendererFile(root, '/assets/missing.js')).toBeNull();
  });

  it('refuses path traversal in every encoding', () => {
    for (const path of ['/../renderer-evil/secret.txt', '/%2e%2e/renderer-evil/secret.txt', '/assets/../../renderer-evil/secret.txt', '/..%2frenderer-evil/secret.txt']) {
      expect(resolveRendererFile(root, path), path).toBeNull();
    }
  });

  it('is not fooled by a sibling directory that merely shares the root as a prefix', () => {
    // `/dist/renderer-evil` starts with `/dist/renderer`; a startsWith check would serve it.
    expect(resolveRendererFile(root, `/../${'renderer-evil'}/secret.txt`)).toBeNull();
  });

  it('refuses NUL bytes and malformed escapes', () => {
    expect(resolveRendererFile(root, '/index.html%00.png')).toBeNull();
    expect(resolveRendererFile(root, '/%E0%A4%A')).toBeNull();
  });
});

describe('buildCsp', () => {
  it('is strict in production: self only, no unsafe-inline anywhere, no objects, no framing', () => {
    const csp = buildCsp(null);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it('only loosens style/script for the dev server origin', () => {
    const csp = buildCsp('http://localhost:5273');
    expect(csp).toContain('http://localhost:5273');
    expect(csp).toContain('ws://localhost:5273');
    expect(csp).not.toContain('unsafe-eval');
  });
});

describe('isAllowedNavigation', () => {
  it('allows only the app origin (and the dev server when configured)', () => {
    expect(isAllowedNavigation('app://renderer/index.html', null)).toBe(true);
    expect(isAllowedNavigation('app://other/index.html', null)).toBe(false);
    expect(isAllowedNavigation('https://evil.example', null)).toBe(false);
    expect(isAllowedNavigation('file:///etc/passwd', null)).toBe(false);
    expect(isAllowedNavigation('http://localhost:5273/', 'http://localhost:5273')).toBe(true);
    expect(isAllowedNavigation('http://localhost:9999/', 'http://localhost:5273')).toBe(false);
    expect(isAllowedNavigation('not a url', null)).toBe(false);
  });
});

describe('isSafeExternalUrl', () => {
  it('accepts http, https and mailto only, without credentials', () => {
    expect(isSafeExternalUrl('https://example.com/a?b=1')).toBe(true);
    expect(isSafeExternalUrl('http://example.com')).toBe(true);
    expect(isSafeExternalUrl('mailto:a@example.com')).toBe(true);
  });

  it('refuses script, file, custom-scheme and credentialed URLs', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id', 'vscode://x', 'https://user:pass@example.com', 'https://user@example.com', '']) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });
});
