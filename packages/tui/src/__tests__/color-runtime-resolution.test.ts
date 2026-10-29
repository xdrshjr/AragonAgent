import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';
import { syntaxColorLevel, useTuiColors } from '../ui/color-runtime.js';

/**
 * Guard for the one module whose BEHAVIOUR depends on where it lives
 * (tui-package-split §4.1 "position-dependent members", review P1-4 / R16).
 *
 * `ui/color-runtime.ts` resolves `ink` and `cli-highlight` with `createRequire(import.meta.url)`
 * and then asks each of them for the `chalk` THEY will use, so that `useTuiColors()` can pin the
 * colour level of every instance that will actually paint - even when npm nests a second chalk
 * under one of them. Moving the file changes the point the resolution starts from. If `ink`
 * resolved to a different copy than the one the CLI renders with, or `cli-highlight` were not a
 * direct dependency of this package, `useTuiColors(0)` would silently pin the WRONG instance:
 * `NO_COLOR` and the exit-time restore would stop working for highlighted code, and nothing
 * would throw.
 *
 * The test therefore resolves the same three instances INDEPENDENTLY of `color-runtime.ts` and
 * checks that the module controls each of them, not merely that its own bookkeeping is self-
 * consistent.
 */
const require = createRequire(import.meta.url);

async function chalkUsedBy(packageName: string): Promise<typeof chalk> {
  const dependency = createRequire(require.resolve(packageName));
  return (await import(pathToFileURL(dependency.resolve('chalk')).href)).default;
}

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

describe('color-runtime resolves the chalk instances that actually paint', () => {
  it('pins and then restores all three instances', async () => {
    const [inkChalk, highlightChalk] = await Promise.all([chalkUsedBy('ink'), chalkUsedBy('cli-highlight')]);
    const before = { own: chalk.level, ink: inkChalk.level, highlight: highlightChalk.level };

    const restore = useTuiColors(0);
    restores.push(restore);
    expect(chalk.level).toBe(0);
    expect(inkChalk.level, 'the chalk that ink renders with').toBe(0);
    expect(highlightChalk.level, 'the chalk that cli-highlight renders with').toBe(0);
    expect(syntaxColorLevel(), 'what the highlight cache keys on').toBe(0);

    restore();
    expect({ own: chalk.level, ink: inkChalk.level, highlight: highlightChalk.level }).toEqual(before);
    expect(syntaxColorLevel()).toBe(before.highlight);
  });

  it('can be applied twice and restored in either order without corrupting the level', async () => {
    const highlightChalk = await chalkUsedBy('cli-highlight');
    const original = highlightChalk.level;
    const first = useTuiColors(1);
    const second = useTuiColors(0);
    restores.push(first, second);
    expect(highlightChalk.level).toBe(0);
    second();
    expect(highlightChalk.level).toBe(1);
    first();
    expect(highlightChalk.level).toBe(original);
  });

  it('finds ink and cli-highlight from the point this module resolves them from', () => {
    // That they are DECLARED here (not merely hoisted by the monorepo) is `package-metadata.test.ts`'s job.
    expect(() => require.resolve('ink')).not.toThrow();
    expect(() => require.resolve('cli-highlight')).not.toThrow();
  });
});
