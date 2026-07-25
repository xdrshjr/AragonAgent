import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface CliPackageJson {
  bin?: Record<string, string>;
}

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as CliPackageJson;

const cliSource = readFileSync(new URL('../cli.tsx', import.meta.url), 'utf8');

describe('installed CLI command', () => {
  it('exposes only the aragon executable', () => {
    expect(packageJson.bin).toEqual({ aragon: './dist/cli.js' });
  });

  it('uses aragon in generated command help', () => {
    expect(cliSource).toContain(".name('aragon')");
  });
});
