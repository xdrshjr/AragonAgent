/**
 * `npm test` must never launch Electron. The default vitest configuration may not include any
 * end-to-end file or project (spec R1): `vitest run` runs every project in a config, so an `e2e`
 * project added there would silently turn the unit-test gate into a display-requiring one.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import defaultConfig from '../vitest.config.js';
import e2eConfig from '../vitest.e2e.config.js';

const here = dirname(fileURLToPath(import.meta.url));
const REGEX_SPECIALS = /[.+^$()|[\]\\]/g;

/** Minimal glob -> RegExp for the two shapes the configs use (`**` and `{a,b}`). */
function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(REGEX_SPECIALS, '\\$&')
    .replace(/\{([^}]+)\}/g, (_match, alternatives: string) => `(?:${alternatives.split(',').join('|')})`)
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${source}$`);
}

describe('e2e isolation', () => {
  const projects = (defaultConfig.test?.projects ?? []) as Array<{ test?: { name?: string; include?: string[] } }>;
  const includes = projects.flatMap((project) => project.test?.include ?? []);

  it('the default configuration has projects to inspect (so this test cannot pass vacuously)', () => {
    expect(projects.length).toBeGreaterThanOrEqual(2);
    expect(includes.length).toBeGreaterThanOrEqual(2);
  });

  it('has no project named e2e', () => {
    expect(projects.map((project) => project.test?.name)).not.toContain('e2e');
  });

  it.each([
    'test/e2e/launch.e2e.ts',
    'test/e2e/chat.e2e.ts',
    'test/e2e/a/b/deep.e2e.ts',
    'src/renderer/anything.e2e.ts',
  ])('no default include pattern matches %s', (file) => {
    for (const pattern of includes) expect(globToRegExp(pattern).test(file), `${pattern} matches ${file}`).toBe(false);
  });

  it('does match ordinary unit tests (the matcher itself works)', () => {
    expect(includes.some((pattern) => globToRegExp(pattern).test('test/tokens.test.ts'))).toBe(true);
    expect(includes.some((pattern) => globToRegExp(pattern).test('src/main/__tests__/x.test.ts'))).toBe(true);
  });

  it('the e2e configuration runs only *.e2e.ts files, one at a time', () => {
    expect(e2eConfig.test?.include).toEqual(['test/e2e/**/*.e2e.ts']);
    expect(e2eConfig.test?.fileParallelism).toBe(false);
  });

  it('the test:e2e script uses that file and the default script does not mention it', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:e2e']).toBe('vitest run -c vitest.e2e.config.ts');
    expect(pkg.scripts.test).toBe('vitest run');
  });
});
