import { defineConfig } from 'vitest/config';

// Self-contained vitest config for @aragon-agent/core so `npm test` here does not
// inherit the host repo's root vitest.config.ts (which wires a frontend
// setupFile). Keeps the package's smoke suite (AC7) runnable in isolation.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The forks pool mirrors every transformed module into
    // `%TEMP%/<nanoid>/<environment>/` and creates that directory ONCE, never
    // re-checking it (vitest 4.1.x `ModuleFetcher.tmpDirectories`). Its only
    // deleter - `project.close() -> clearTmpDir()` - does not synchronise with
    // in-flight imports, so a directory that disappears mid-run turns every
    // not-yet-fetched module into an import-time ENOENT and the suite reports
    // hundreds of "failed files" that all pass in isolation. Threads has no
    // `cacheFs`, so no mirror is written at all (verified: no `%TEMP%/<nanoid>`
    // project directory exists during a threads run).
    //
    // Boundary: the threads pool does not support `process.chdir()`. This repo has
    // zero `process.chdir` call sites. If a future test genuinely needs it, give
    // that one test its own `pool: 'forks'` project - do NOT move the whole repo
    // back to forks.
    pool: 'threads',
  },
});
