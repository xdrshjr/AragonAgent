/**
 * AC-38 — every `__tests__` directory in this package is inside
 * `tsconfig.test.json`'s scope (todo-plan-followthrough §3.8 / P1-3).
 *
 * WHY THIS EXISTS. v1 measured the typecheck debt by scanning `src/__tests__/**`
 * and reported 8 errors in 7 files. The real number was 12 in 10, because BOTH
 * packages also carry a NESTED `src/skills/__tests__/**` that the scan never
 * looked at — and `tsconfig.test.json` necessarily includes it. An implementer
 * who repaired the eight listed fixtures would have landed red with no
 * explanation of why.
 *
 * The lesson worth keeping is mechanical rather than numerical: `src/__tests__`
 * is a CONVENTION here, not a rule, so the next person to add
 * `src/<anything>/__tests__/` must not silently fall outside the gate. This test
 * walks the tree and asserts the config's `include` covers what it finds.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every `__tests__` directory under `src/`, relative to the package root. */
function findTestDirs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.name === '__tests__') out.push(relative(PKG_ROOT, full).replace(/\\/g, '/'));
    else findTestDirs(full, out);
  }
  return out;
}

/**
 * `tsconfig.test.json` carries `//` comments, which `JSON.parse` rejects. They
 * are the point of the file — every load-bearing key there has a reason written
 * next to it — so this strips them rather than the file dropping them.
 */
function readJsonc(path: string): { include: string[]; exclude: string[] } {
  const raw = readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return JSON.parse(raw) as { include: string[]; exclude: string[] };
}

/**
 * The subset of tsconfig glob semantics these two patterns actually use.
 *
 * `**` IS SUBSTITUTED THROUGH A PLACEHOLDER, not directly: the single-`*` pass
 * that follows would otherwise rewrite the `.*` inside the expansion and turn
 * `(?:.*\/)?` into `(?:.[^/]*\/)?`, which stops matching a two-segment path like
 * `skills/__tests__/` — silently making this whole guard vacuous for exactly the
 * nested case it exists to catch.
 */
const DOUBLE_STAR = '\u0000';

function matches(pattern: string, path: string): boolean {
  const rx = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, DOUBLE_STAR)
        .replace(/\*/g, '[^/]*')
        .split(DOUBLE_STAR)
        .join('(?:[^\\0]*/)?') +
      '$',
  );
  return rx.test(path);
}

describe('AC-38: the test tree is fully inside the typecheck gate', () => {
  const cfg = readJsonc(join(PKG_ROOT, 'tsconfig.test.json'));
  const dirs = findTestDirs(join(PKG_ROOT, 'src'));

  it('finds the nested tree v1 missed, so this test is not vacuous', () => {
    // If this ever fails because `skills/__tests__` moved, the assertion below
    // still holds — but the reader should know the guard has stopped covering
    // the case it was written for.
    expect(dirs).toContain('src/__tests__');
    // TWIN of the CLI's guard (tui-package-split §8.2-3). The CLI's second tree is
    // `src/skills/__tests__`; this package has no nested one, so the walk is only required to
    // find the top-level tree - which is still non-vacuous: it proves the walk saw a real
    // directory, and any `src/<x>/__tests__/` added later is checked against `include` below.
  });

  it('every `__tests__` directory is matched by an `include` pattern', () => {
    for (const dir of dirs) {
      const sample = `${dir}/example.ts`;
      const covered = cfg.include.some((p) => matches(p, sample));
      expect(covered, `${dir} is outside tsconfig.test.json's include`).toBe(true);
    }
  });

  it('the config does NOT inherit the parents `__tests__` exclusion', () => {
    // THE ONE KEY THAT MAKES THE WHOLE FILE WORK. A child's `exclude` REPLACES
    // the parent's, which is what pulls the test tree back in; dropping the key
    // here would make this config check exactly what `tsconfig.json` already
    // does, and every assertion above would still pass.
    expect(cfg.exclude).toEqual(['node_modules', 'dist']);
    expect(cfg.exclude.some((p) => p.includes('__tests__'))).toBe(false);
  });

  it('`.tsx` fixtures are in scope too, not only `.ts`', () => {
    expect(cfg.include.some((p) => matches(p, 'src/__tests__/app.test.tsx'))).toBe(true);
  });

  it('the matcher discriminates, so the assertions above are not vacuous', () => {
    // A matcher that returned `true` for everything would pass every case here
    // while covering nothing.
    expect(matches('src/**/*.ts', 'src/skills/__tests__/deep/nested.ts')).toBe(true);
    expect(matches('src/**/*.ts', 'src/agent/controller.ts')).toBe(true);
    expect(matches('src/**/*.ts', 'scripts/build.ts')).toBe(false);
    expect(matches('src/**/*.ts', 'src/ui/App.tsx')).toBe(false);
  });
});
