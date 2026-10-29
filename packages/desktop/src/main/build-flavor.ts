/**
 * Which build this is: `dev` (running from source), `e2e` (a packaged build the test harness may
 * drive), or `release` (what users install).
 *
 * The test switches (`--e2e`, `--e2e-fault`, `--e2e-feed`, the `e2e:*` IPC channels) exist ONLY in
 * the first two. A release build does not ignore them, it does not have them: the code that would
 * read them never runs (see `e2e-support.ts`), so there is no environment variable or command-line
 * flag an end user - or anything else that can start the app - can use to rewrite notifications,
 * inject write failures or point the update check at a loopback server.
 *
 * `BAKED_FLAVOR` is a placeholder in source (`null`). `scripts/build.mjs` replaces it in the
 * COMPILED `dist/main/build-flavor.js` (never in this file), so a source checkout can never carry a
 * baked value by accident. Unbaked, a packaged app is `release` and an unpackaged one is `dev`:
 * the unsafe direction (packaged and `e2e`) needs an explicit build step.
 */

export type BuildFlavor = 'dev' | 'e2e' | 'release';

/** Replaced in `dist/main/build-flavor.js` by the build script; `null` in source. */
export const BAKED_FLAVOR: BuildFlavor | null = null;

export function resolveFlavor(isPackaged: boolean, baked: BuildFlavor | null = BAKED_FLAVOR): BuildFlavor {
  if (baked !== null) return baked;
  return isPackaged ? 'release' : 'dev';
}

/** The test switches may be read in these flavors only. */
export function allowsTestSwitches(flavor: BuildFlavor): boolean {
  return flavor !== 'release';
}
