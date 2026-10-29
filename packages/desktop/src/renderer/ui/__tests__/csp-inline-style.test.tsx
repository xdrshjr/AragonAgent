/**
 * The production CSP is `style-src 'self' <hashes>`: no 'unsafe-inline'. Radix Dialog injects a <style>
 * element (scroll lock) at run time, so the hash of exactly that text is allowed - without it every
 * dialog logs a CSP violation in the shipped app.
 *
 * What this file can and cannot check: the shape of the policy. It CANNOT hash the real element, because
 * the text react-remove-scroll builds depends on the browser (jsdom produces different CSS from
 * Chromium). The real guard is the end-to-end suite: `test/e2e/lifecycle.e2e.ts` opens dialogs in the
 * packaged-style window, and the harness fails any test whose renderer reports a console error, with the
 * correct hash in the message when a dependency upgrade changes the injected text.
 */
import { describe, expect, it } from 'vitest';
import { INLINE_STYLE_HASHES, buildCsp } from '../../../shared/csp.js';

describe('production CSP style-src', () => {
  it('allows exactly the listed inline-style hashes, and never unsafe-inline', () => {
    const csp = buildCsp(null);
    const style = csp.split('; ').find((directive) => directive.startsWith('style-src '));
    expect(style).toBe(`style-src 'self' ${INLINE_STYLE_HASHES.join(' ')}`);
    expect(csp).not.toContain('unsafe-inline');
  });

  it('every hash is a well-formed sha256 source expression', () => {
    expect(INLINE_STYLE_HASHES.length).toBeGreaterThan(0);
    for (const hash of INLINE_STYLE_HASHES) expect(hash).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
  });

  it('the dev server policy is unchanged: unsafe-inline for styles there only', () => {
    expect(buildCsp('http://localhost:5273')).toContain("style-src 'self' http://localhost:5273 'unsafe-inline'");
  });
});
