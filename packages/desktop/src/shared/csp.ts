/**
 * The renderer's Content-Security-Policy. Electron-free so it can be unit-tested together with the DOM
 * (see `renderer/ui/__tests__/csp-inline-style.test.tsx`); `main/protocols.ts` re-exports it.
 */

const ASSET_SCHEME_NAME = 'aragon-asset';

/**
 * Hashes of the inline <style> elements the UI libraries create at run time. Radix Dialog's scroll lock
 * (react-remove-scroll via react-style-singleton) appends one when a modal opens, and `style-src 'self'`
 * blocks it - a console error on EVERY dialog, found by the first end-to-end run that opened one while
 * checking for renderer errors. The fix is to allow exactly that content, not to loosen the policy to
 * 'unsafe-inline'. The hash is of the text react-remove-scroll builds in Chromium for this app's layout (no
 * document scrollbar); a dependency upgrade can change it, and the end-to-end suite - which opens dialogs
 * and fails on any renderer console error - then reports the new hash. jsdom builds different CSS, so a unit
 * test cannot do this check (see csp-inline-style.test.tsx).
 */
export const INLINE_STYLE_HASHES: readonly string[] = ["'sha256-nzTgYzXYDNe6BAHiiI7NNlfK8n/auuOAhh2t92YvuXo='"];

/** The Content-Security-Policy sent with every renderer response. */
export function buildCsp(devServer: string | null): string {
  const self = devServer ? `'self' ${devServer}` : "'self'";
  const connect = devServer ? `'self' ${devServer} ws://${new URL(devServer).host}` : "'self'";
  const script = devServer ? `${self} 'unsafe-inline'` : "'self'";
  return [
    `default-src ${self}`,
    `script-src ${script}`,
    // Styles are compiled out at build time. Inline `style=""` attributes (React's style prop
    // goes through the CSSOM and is unaffected) need 'unsafe-inline' for styles only in dev,
    // where Vite injects <style> tags.
    devServer ? `style-src ${self} 'unsafe-inline'` : `style-src 'self' ${INLINE_STYLE_HASHES.join(' ')}`,
    `img-src ${self} data: ${ASSET_SCHEME_NAME}:`,
    `font-src ${self} data:`,
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
