import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The shape of `@aragon-agent/tui` as a PUBLISHED package (tui-package-split §6.1 / §9.3).
 *
 * Every assertion here guards a failure that is invisible in a workspace and fatal after
 * `npm install`: a workspace hoists dependencies and symlinks sibling packages, so a missing
 * `exports` entry, an undeclared dependency or a peer range that drifted works on the
 * developer's machine and breaks the first user after publishing.
 *
 * THIS COPY IS THE STANDALONE ONE. This repository holds the TUI and the desktop shell only;
 * `@aragon-agent/core` is consumed from the registry and `@aragon-agent/cli` is not part of
 * this repository at all, so no assertion may reach for a sibling `packages/*` checkout. The
 * engine is checked through the copy npm actually installed, which is the only copy a reader
 * of this repository will ever have.
 */
interface Manifest {
  name?: string;
  version?: string;
  license?: string;
  type?: string;
  bin?: unknown;
  files?: string[];
  main?: string;
  types?: string;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const read = (relative: string): Manifest =>
  JSON.parse(readFileSync(join(PKG_ROOT, relative), 'utf8')) as Manifest;

const tui = read('package.json');

/**
 * The installed engine, found by walking the `node_modules` chain from this package upward,
 * exactly as Node resolves a bare specifier - a hoisted workspace install and a plain
 * `npm install` inside this directory both land here.
 */
function installedCore(): Manifest | undefined {
  let directory = PKG_ROOT;
  for (;;) {
    const manifest = join(directory, 'node_modules', '@aragon-agent', 'core', 'package.json');
    if (existsSync(manifest)) {
      return JSON.parse(readFileSync(manifest, 'utf8')) as Manifest;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** `1.2.3` -> `[1, 2, 3]`, or `undefined` for anything that is not a plain release version. */
function versionParts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

describe('@aragon-agent/tui manifest', () => {
  it('is the tui package, ESM, MIT, and has no executable', () => {
    expect(tui.name).toBe('@aragon-agent/tui');
    expect(tui.type).toBe('module');
    expect(tui.license).toBe('MIT');
    expect(tui.bin).toBeUndefined();
  });

  it('maps every subpath to dist with types, and keeps the entry free of a barrel', () => {
    expect(tui.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './*': { types: './dist/*.d.ts', import: './dist/*.js' },
      './package.json': './package.json',
    });
    expect(tui.main).toBe('./dist/index.js');
    expect(tui.types).toBe('./dist/index.d.ts');
  });

  it('ships dist and the legal / doc files, and nothing that is a build stamp', () => {
    expect(tui.files).toEqual(['dist', 'README.md', 'CHANGELOG.md', 'LICENSE']);
  });

  it('declares react and ink as PEER dependencies, never as direct dependencies', () => {
    expect(tui.peerDependencies?.react).toBeDefined();
    expect(tui.peerDependencies?.ink).toBeDefined();
    // Two copies of React in one process is `Invalid hook call`; a direct dependency
    // here would nest a second copy under this package whenever the host pins another.
    expect(tui.dependencies?.react).toBeUndefined();
    expect(tui.dependencies?.ink).toBeUndefined();
  });

  it('declares every runtime dependency its sources import', () => {
    for (const name of ['chalk', 'cli-highlight', 'ink-spinner', 'string-width', 'strip-ansi', 'tinyglobby', '@aragon-agent/core']) {
      expect(tui.dependencies?.[name], name).toBeDefined();
    }
  });

  it('depends on the engine by a caret range, from a registry this install can reach', () => {
    const range = tui.dependencies?.['@aragon-agent/core'];
    expect(range).toBeDefined();
    const parts = versionParts((range ?? '').replace(/^\^/, ''));
    expect(parts, `${range} is not a caret release range`).toBeDefined();
    expect(range?.startsWith('^')).toBe(true);

    // The floor of the range must be what is installed. A range whose floor the installed
    // tree already satisfies is the whole point: `npm install` in a fresh clone resolves it.
    const core = installedCore();
    expect(core, 'the installed @aragon-agent/core was not found in any node_modules').toBeDefined();
    const installed = versionParts(core?.version ?? '');
    expect(installed, `${core?.version} is not a plain release version`).toBeDefined();
    const [wantMajor, wantMinor, wantPatch] = parts ?? [0, 0, 0];
    const [gotMajor, gotMinor, gotPatch] = installed ?? [0, 0, 0];
    // Caret on a 0.x range excludes the next minor, so all three components are compared.
    const satisfies = gotMajor === wantMajor && gotMinor === wantMinor && gotPatch >= wantPatch;
    expect(satisfies, `installed ${core?.version} is outside ${range}`).toBe(true);
  });

  it('never depends on the CLI, in any dependency field', () => {
    for (const field of ['dependencies', 'peerDependencies', 'devDependencies'] as const) {
      expect(Object.keys(tui[field] ?? {}), field).not.toContain('@aragon-agent/cli');
    }
  });

  it('resolves every dependency from the registry, never from a workspace or a file path',
    () => {
      const fields = ['dependencies', 'peerDependencies', 'devDependencies'] as const;
      for (const field of fields) {
        for (const [name, range] of Object.entries(tui[field] ?? {})) {
          const where = `${field}.${name} = ${range}`;
          expect(range.startsWith('workspace:'), where).toBe(false);
          expect(range.startsWith('file:'), where).toBe(false);
          expect(range.startsWith('link:'), where).toBe(false);
          expect(range.startsWith('portal:'), where).toBe(false);
          // `*` and `latest` make a published install depend on whatever the registry serves
          // tomorrow, which is exactly what the pinned-range release flow exists to prevent.
          expect(range, where).not.toBe('*');
          expect(range, where).not.toBe('latest');
          expect(range.trim(), where).not.toBe('');
        }
      }
    });

  it('pins the test runtime exactly', () => {
    expect(tui.devDependencies?.vitest).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('has no script that reaches outside the package directory', () => {
    // The monorepo guarded its builds with `node ../../scripts/ensure-built.mjs`; those
    // helpers belong to a repository this package no longer lives in, so every script has to
    // stand on its own. `npm run build` and `npm test` must work from a bare checkout.
    for (const [name, command] of Object.entries(tui.scripts ?? {})) {
      expect(command, `scripts.${name}`).not.toContain('../');
      expect(command, `scripts.${name}`).not.toContain('ensure-built');
    }
    for (const entry of tui.files ?? []) {
      expect(entry.startsWith('..'), `files entry ${entry}`).toBe(false);
    }
  });
});
