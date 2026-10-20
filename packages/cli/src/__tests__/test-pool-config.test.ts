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
    expect(files.length).toBeGreaterThan(0);
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
});
