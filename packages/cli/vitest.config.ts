import { readdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const availableProcessors = os.availableParallelism?.() ?? os.cpus().length;
const maxWorkers = Math.min(4, Math.max(1, availableProcessors - 1));
/**
 * The PACKAGE root, taken from this file's own location rather than `process.cwd()`.
 * npm sets the cwd to the workspace today, but a config that scans `./src` from whatever
 * directory happened to launch vitest (a `--config` from the repository root, an editor
 * integration) would throw `ENOENT` at startup instead of running the suite.
 */
const packageRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Test files that MUTATE `process.env` at import time.
 *
 * Under the threads pool every worker of one process shares `process.env`, so two of
 * these files running concurrently overwrite each other's `ARAGON_HOME` and the loser
 * fails on a config file that belongs to the other test (measured: a profile-window
 * save returned `{ ok: false }` in a full run and passed in isolation). They get their
 * own project on the forks pool, where each file has its own process - the isolation
 * the forks pool always provided and the threads pool never did.
 *
 * The list is DISCOVERED rather than hardcoded: a hardcoded census is exactly the kind
 * of list that stops matching the tree and silently stops protecting anything.
 */
function environmentMutatingTests(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!/\.test\.tsx?$/.test(entry.name)) continue;
      if (/process\.env\.[A-Z_]+\s*=/.test(readFileSync(absolutePath, 'utf8'))) {
        found.push(relative(root, absolutePath).replace(/\\/g, '/'));
      }
    }
  };
  walk(join(root, 'src'));
  return found.sort();
}

const environmentTests = environmentMutatingTests(packageRoot);

/**
 * The files that need a separate PROCESS, and the reason this is not a step back to
 * forks for everything: `experimental.fsModuleCache` gives the forks pool a cache path,
 * and the `%TEMP%/<nanoid>/<env>` module mirror is only written when that path is null.
 * So these files keep real isolation WITHOUT re-creating the directory whose deletion
 * produced hundreds of import-time ENOENTs.
 */
const environmentProject = {
  test: {
    name: 'env-isolated',
    include: environmentTests,
    pool: 'forks' as const,
    isolate: true,
    maxWorkers: Math.min(2, maxWorkers),
    sequence: { groupOrder: 0 },
    experimental: { fsModuleCache: true },
  },
};

const mainProject = {
  test: {
    name: 'main',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: environmentTests,
    pool: 'threads' as const,
    maxWorkers,
    // Different maxWorkers requires a distinct groupOrder (vitest enforces it).
    sequence: { groupOrder: 1 },
  },
};

// Self-contained vitest config for @aragon-agent/cli so `npm test` here does not
// inherit the host repo's root vitest.config.ts. The CLI ships React/Ink
// components (.tsx); every source/test file imports React, so the default JSX
// transform works under either the oxc or esbuild pipeline.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    maxWorkers,
    // THE DEFAULT POOL IS THREADS, AND THAT IS THE FIX FOR THE RELEASE GATE.
    //
    // The forks pool mirrors every transformed module into
    // `%TEMP%/<nanoid>/<environment>/` and creates that directory ONCE, never
    // re-checking it (vitest 4.1.x `ModuleFetcher.tmpDirectories`). Its only deleter -
    // `project.close() -> clearTmpDir()` - does not synchronise with in-flight imports,
    // so a directory that disappears mid-run turns every not-yet-fetched module into an
    // import-time ENOENT and the suite reports hundreds of "failed files" that all pass
    // in isolation. Threads has no `cacheFs`, so no mirror is written at all (verified:
    // no `%TEMP%/<nanoid>` project directory exists during a threads run).
    //
    // Boundary: the threads pool does not support `process.chdir()`. This repo has zero
    // `process.chdir` call sites. A test that needs one belongs in a `pool: 'forks'`
    // project, never in a return of the whole repository to forks.
    pool: 'threads',
    projects: environmentTests.length > 0 ? [environmentProject, mainProject] : [mainProject],
  },
});
