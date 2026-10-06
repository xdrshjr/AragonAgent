import process from 'node:process';

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
