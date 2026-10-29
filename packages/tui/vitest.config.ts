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
 * A BUDGET, NOT A RELAXED ASSERTION (release-gate I-12), and here is why the
 * default had to go.
 *
 * Vitest's default is 5000 ms per test, and this suite runs 6000+ of them on a dev
 * machine that the release shares with everything else. The 2026-10-22 release run
 * measured what a loaded host costs: total 381 s against the usual 197-242 s, and
 * import time 484 s against 130-170 s - roughly 3.7x - and four files reported
 * `Test timed out in 5000ms` whose cases measure 0.49 s, 0.54 s, 1.58 s and 5.36 s
 * on an idle machine. The failing set DRIFTS between releases (job-mirror,
 * model-profile-runtime, glyphs, controller-prompt-boundary,
 * model-profile-connection-test, todo-app-layout across the stored logs), so this
 * is the default being too tight under load, not one sick test.
 *
 * WHY THE SLOW CASES NEVER SHOWED IT: a timeout timer is a `setTimeout` on the same
 * thread, so a synchronous CPU-bound case (the 73 s and 35 s ones in this suite)
 * cannot be preempted and passes however long it runs; only an await-heavy case,
 * like these Ink/App ones, ever yields and gets killed. That asymmetry is exactly
 * backwards from what a 5 s wall clock is meant to protect.
 *
 * WHY IT IS A SHARED OBJECT AND NO LONGER TWO NUMBERS ON THE ROOT. It used to sit on
 * the root `test` block, and that was silently a NO-OP: as soon as `test.projects` is
 * a non-empty array each project is its own config and does NOT inherit the root's
 * `testTimeout`, so every case in this package kept running on the 5000 ms default
 * while the file looked like it had said otherwise. The 2026-10-23 release proved it
 * (`tools.test.ts > grep finds a seeded pattern`: `Test timed out in 5000ms`).
 * `test-pool-config.test.ts` therefore asserts the EFFECTIVE budget
 * (`ctx.task.timeout`) instead of this file's text - the text was already correct
 * while the behaviour was not. Spread into EVERY project: a project that forgets the
 * spread is the same bug back, one release later.
 *
 * Nothing is hidden: a hung test still FAILS, just 25 s later, and `retry`,
 * `--passWithNoTests` and exclusions stay banned by I-12. `hookTimeout` gets the
 * same number because a hook that starts real child processes has already reported
 * `Hook timed out in 10000ms` once. A case that needs a TIGHTER or a LARGER budget
 * keeps declaring it in place (bash-jobs 20 s, proc-supervisor 20-60 s,
 * powershell-script-parse 30 s) - an explicit per-test budget wins over this one.
 */
const WALL_CLOCK_BUDGET = { testTimeout: 30_000, hookTimeout: 30_000 } as const;

/**
 * The files that need a separate PROCESS, and the reason this is not a step back to
 * forks for everything: `experimental.fsModuleCache` gives the forks pool a cache path,
 * and the `%TEMP%/<nanoid>/<env>` module mirror is only written when that path is null.
 * So these files keep real isolation WITHOUT re-creating the directory whose deletion
 * produced hundreds of import-time ENOENTs.
 */
const environmentProject = {
  test: {
    ...WALL_CLOCK_BUDGET,
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
    ...WALL_CLOCK_BUDGET,
    name: 'main',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: environmentTests,
    pool: 'threads' as const,
    maxWorkers,
    // Different maxWorkers requires a distinct groupOrder (vitest enforces it).
    sequence: { groupOrder: 1 },
  },
};

// Self-contained vitest config for @aragon-agent/tui so `npm test` here does not
// inherit the host repo's root vitest.config.ts. This package ships React/Ink
// components (.tsx); every source/test file imports React, so the default JSX
// transform works under either the oxc or esbuild pipeline.
//
// A SAME-SHAPE COPY OF packages/cli/vitest.config.ts in the private repository these packages
// ship from, on purpose (tui-package-split §4.4): the two packages have the same pool, budget
// and environment-isolation needs, and a shared import would couple the packages' test tooling.
// The parity check that used to keep the two literals equal lives with the CLI, so the guards
// below are what hold THIS copy in place.
//
// `testTimeout` / `hookTimeout` are deliberately NOT repeated here: when `projects`
// is non-empty the root `test` block is the runner's own config and its per-test
// options are not inherited by any project, so a number written here would be a
// comment that cannot fail. `WALL_CLOCK_BUDGET` above is the single source.
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
