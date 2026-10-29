import process from 'node:process';
import type { TermCapabilities } from './capabilities.js';

/** Ink 5 caches CI detection at import time and otherwise paints only on exit. */
async function loadInk(): Promise<typeof import('ink')> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return import('ink');

  const originalCi = process.env.CI;
  try {
    // A real interactive terminal always needs live frames and resize events.
    // `0` also overrides CI_* / CONTINUOUS_INTEGRATION in Ink's detector.
    process.env.CI = '0';
    return await import('ink');
  } finally {
    // Commands, subprocesses and the updater must see the original environment.
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
  }
}

export const { render } = await loadInk();
// Keep asynchronous dependency resolution after Ink's CI initialization. A
// static import here would let sibling UI modules load Ink before CI is reset.
const { useTuiColors } = await import('./color-runtime.js');

/** Mount the TUI with its resolved colors, restoring all renderers on exit. */
export function renderTui(
  node: Parameters<typeof render>[0],
  options: Parameters<typeof render>[1],
  caps: TermCapabilities,
): ReturnType<typeof render> {
  const restore = useTuiColors(caps.colorLevel);
  try {
    // Ink creates its exit promise lazily and does not replay earlier exits.
    // Mount the host first, then subscribe before application render or layout
    // effects can fail or call useApp().exit().
    const instance = render(null, options);
    void instance.waitUntilExit().then(restore, restore);
    instance.rerender(node);
    return {
      ...instance,
      unmount() {
        try { instance.unmount(); } finally { restore(); }
      },
    };
  } catch (error) {
    restore();
    throw error;
  }
}
