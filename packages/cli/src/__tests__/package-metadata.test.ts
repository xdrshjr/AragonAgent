import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface CliPackageJson {
  bin?: Record<string, string>;
  files?: string[];
}

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as CliPackageJson;
const packageLock = JSON.parse(
  readFileSync(new URL('../../../../package-lock.json', import.meta.url), 'utf8'),
) as { packages?: Record<string, CliPackageJson> };

const cliSource = readFileSync(new URL('../cli.tsx', import.meta.url), 'utf8');

function readImportStatements(source: string): string[] {
  const firstCodeSection = source.indexOf('// Version (read from the shipped package.json');
  const importRegion = source.slice(0, firstCodeSection);
  return [...importRegion.matchAll(/^import[\s\S]*?;$/gm)].map(([statement]) => statement);
}

describe('installed CLI command', () => {
  it('exposes only the aragon executable, and it points at the launcher', () => {
    // `./dist/launcher.js` from the hardening round on (D-26 / C-18): the boot
    // guard has to run BEFORE `dist/cli.js`'s ~60 static imports are evaluated,
    // because a release that fails to IMPORT never reaches any line inside
    // `main()`. `dist/cli.js` is unchanged and keeps its own shebang (R-17), so
    // `npm start` and any script invoking it directly still work — only this
    // mapping moved.
    expect(packageJson.bin).toEqual({ aragon: './dist/launcher.js' });
    expect(packageLock.packages?.['packages/cli']?.bin).toEqual({
      aragon: 'dist/launcher.js',
    });
  });

  it('uses aragon in generated command help', () => {
    expect(cliSource).toContain(".name('aragon')");
  });

  it('ships the package-level runtime directory', () => {
    expect(packageJson.files).toContain('runtime');
  });

  it('loads the warning preload after Node built-ins and before application imports', () => {
    const imports = readImportStatements(cliSource);
    const preload = "import '../runtime/insecure-tls-warning.cjs';";
    const preloadIndex = imports.indexOf(preload);
    const nodeImportIndexes = imports
      .map((statement, index) => ({ statement, index }))
      .filter(({ statement }) => statement.includes("from 'node:"))
      .map(({ index }) => index);
    const applicationImportIndexes = imports
      .map((statement, index) => ({ statement, index }))
      .filter(
        ({ statement }) =>
          statement !== preload &&
          !statement.includes("from 'node:") &&
          !statement.startsWith('import type '),
      )
      .map(({ index }) => index);

    expect(preloadIndex).toBeGreaterThan(-1);
    expect(nodeImportIndexes).toHaveLength(4);
    expect(nodeImportIndexes.every((index) => index < preloadIndex)).toBe(true);
    expect(applicationImportIndexes.every((index) => index > preloadIndex)).toBe(true);
  });
});
