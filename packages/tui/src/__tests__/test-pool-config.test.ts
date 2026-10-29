/**
 * The test-runner configuration itself is part of the release gate
 * (release-gate-and-native-panels AC-4 / R-8 / IF-4).
 *
 * THE FAILURE THIS PREVENTS is not a code defect, which is why no ordinary test can
 * catch it: `pool: 'forks'` mirrors every transformed module into
 * `%TEMP%/<nanoid>/<environment>/`, creates that directory once and never re-checks it,
 * so a directory that disappears mid-run turns hundreds of files into import-time
 * ENOENTs that all pass in isolation. Restoring the default pool "for performance" is a
 * one-line change that no assertion would otherwise notice until a release fails.
 *
 * The second half guards the opposite direction: the files that mutate `process.env`
 * need a separate PROCESS (threads share the environment), and they must keep that
 * isolation WITHOUT re-creating the mirror - which only holds while they run on forks
 * with `experimental.fsModuleCache` enabled.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(TESTS_DIR, '..');
const PACKAGE_ROOT = resolve(SRC, '..');
const CONFIG = readFileSync(join(PACKAGE_ROOT, 'vitest.config.ts'), 'utf8');

/** Every test file that assigns to `process.env.<SOMETHING>`. */
function environmentMutatingTests(): string[] {
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
        found.push(relative(PACKAGE_ROOT, absolutePath).replace(/\\/g, '/'));
      }
    }
  };
  walk(SRC);
  return found;
}

/**
 * TWIN of `packages/cli/src/__tests__/test-pool-config.test.ts` (tui-package-split §8.2-3).
 * Same guards, run against THIS package's `vitest.config.ts`. Two intended differences:
 *  - the CLI asserts that at least one test file mutates `process.env`, because its
 *    `env-isolated` project is live; the TUI has none today, so that project is dormant and the
 *    assertion becomes "if any such file appears, the config still defines the project";
 *  - nothing else. The config text, the pool, and the wall-clock budget are held to the same bar.
 */
describe('vitest.config.ts is a release gate in its own right', () => {
  it('keeps the default pool off the module-mirror path (AC-4 / R-8)', () => {
    expect(CONFIG).toContain("pool: 'threads'");
    // The three words the comment must keep saying, so the reason survives a rewrite
    // that only reads the code: which pool, which flag, and which directory.
    for (const word of ['forks', 'cacheFs', '%TEMP%']) expect(CONFIG).toContain(word);
  });

  it('gives the environment-mutating files their own process, without the mirror', () => {
    const files = environmentMutatingTests();
    // A file that assigns `process.env` and runs in a thread can corrupt another file's
    // environment; this is the measured cross-test failure that put it in its own
    // project, so the project must exist as long as such a file does.
    // (The CLI also requires `files.length > 0`; this package has no such file yet, and the
    // project definition must stay in the config so the first one that appears is isolated.)
    expect(files.length).toBeGreaterThanOrEqual(0);
    expect(CONFIG).toContain("name: 'env-isolated'");
    expect(CONFIG).toContain("pool: 'forks'");
    expect(CONFIG).toContain('fsModuleCache: true');
    // Different `maxWorkers` per project is only legal with distinct group orders.
    expect(CONFIG).toContain('groupOrder: 0');
    expect(CONFIG).toContain('groupOrder: 1');
  });

  it('discovers the isolated files instead of hardcoding a list that drifts', () => {
    // `environmentMutatingTests` in the config scans for the same pattern, so the
    // config contains no file names: a hardcoded census stops matching the tree and
    // then silently protects nothing, which is the trap `glyphs.test.ts` records as
    // this package's most repeated defect.
    expect(CONFIG).not.toMatch(/__tests__\/[a-z0-9-]+\.test\.tsx?'/);
  });

  /**
   * The wall-clock budget, guarded for the same reason the pool is.
   *
   * A default of 5000 ms is what four files reported as `Test timed out in 5000ms` on
   * the 2026-10-22 release run, on a host whose import time was 3.7x the usual - while
   * those same cases measure 0.49 s, 0.54 s, 1.58 s and 5.36 s on an idle machine.
   * Deleting the budget is a one-line "performance" change that no behavioural test can
   * notice until the next release fails, exactly like a return to `pool: 'forks'`.
   *
   * THE ASSERTION IS ON THE EFFECTIVE NUMBER, NOT ON THE FILE TEXT, and that is the
   * whole lesson of the 2026-10-23 release. `testTimeout: 30_000` was already written
   * in this config - on the root `test` block - and it was literally inert: as soon as
   * `test.projects` is a non-empty array, each project carries its own config and does
   * NOT inherit the root's per-test options. `expect(CONFIG).toContain(
   * 'testTimeout: 30_000')` was therefore GREEN for a full release cycle while every
   * case still ran on the 5000 ms default, and the release died on
   * `tools.test.ts > grep finds a seeded pattern: Test timed out in 5000ms`.
   *
   * A source-text guard cannot catch that, because the text was already right.
   * `ctx.task.timeout` is the number the runner will actually enforce for a real test
   * in a real project, so it follows the spread, the merge and any project override: a
   * project that loses its budget goes red HERE, on this machine, before a release does.
   */
  it('the budget this very test runs under is a loaded machine\'s budget (AC-4 / I-12)', (ctx) => {
    // This file runs in `main`, so this is `main`'s effective per-test budget.
    expect(ctx.task.timeout).toBeGreaterThanOrEqual(30_000);
    // ...and the other project must carry it too, not just the one running this file.
    expect(CONFIG).toMatch(/env-isolated[\s\S]*?\.\.\.WALL_CLOCK_BUDGET/);
  });

  it('pins the budget as ONE value spread into every project', () => {
    // A single definition spread everywhere; two literal pairs would let one project
    // drift back to 5 s while the guard above stayed green on the other.
    expect(CONFIG).toMatch(/const WALL_CLOCK_BUDGET = \{[\s\S]*?testTimeout: 30_000[\s\S]*?\}/);
    expect(CONFIG).toContain('hookTimeout: 30_000');
    // Assert on the CODE, not on the file text: the comments name `retry` and
    // `--passWithNoTests` in order to say they stay banned, and a guard that reads
    // prose would trip over its own explanation.
    const code = CONFIG.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\bretry\s*:/);
    expect(code).not.toContain('passWithNoTests');
    // A per-test budget in the ROOT `test` block is the exact no-op that cost a
    // release: under `projects` it reaches no test at all. Guard its absence so the
    // "just put it back on the root" repair cannot pass review green.
    const rootBlock = code.slice(code.indexOf('defineConfig('));
    expect(rootBlock).not.toMatch(/testTimeout\s*:/);
  });
});
