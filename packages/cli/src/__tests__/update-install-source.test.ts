/**
 * The eligibility ladder (cli-auto-update §3.2 / §8.1).
 *
 * REAL DIRECTORY TREES UNDER `os.tmpdir()`, NOT MOCKS. The whole ladder is
 * path-shaped and half of it stats the filesystem (`existsSync` on a sibling
 * `package.json`, on `../../.pnpm`, on the workspace root's manifest), so a
 * mocked `fs` would assert the shape of the mock rather than the shape of the
 * rule. Every tree here is built by the test and deleted by the test — never a
 * directory a function returned (the `app-paths.ts` test-isolation contract).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adviceFor,
  classifyInstallSource,
  isAutoInstallable,
  isReportableSource,
  probeWritable,
  readSelfManifest,
  selfPackageRoot,
} from '../update/install-source.js';

const ROOT = mkdtempSync(join(tmpdir(), 'aragon-install-source-'));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let counter = 0;

/** Build a tree and return the directory the CLI would be installed into. */
function tree(segments: string[], opts: { siblingManifest?: boolean } = {}): string {
  const base = join(ROOT, `case-${(counter += 1)}`);
  const dir = join(base, ...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@aragon-agent/cli', version: '0.5.9' }),
  );
  if (opts.siblingManifest) {
    // The sibling of `node_modules` — i.e. a project root that PINS our version.
    const nmIndex = segments.lastIndexOf('node_modules');
    const projectRoot = join(base, ...segments.slice(0, nmIndex));
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ name: 'someone-app' }));
  }
  return dir;
}

describe('classifyInstallSource — first match wins (§3.2)', () => {
  it('npm-global: an ancestor node_modules with NO sibling manifest', () => {
    // `%APPDATA%\\npm\\node_modules`, `/usr/local/lib/node_modules` and
    // `~/.nvm/versions/node/vX/lib/node_modules` all have this shape.
    const root = tree(['usr', 'local', 'lib', 'node_modules', '@aragon-agent', 'cli']);
    expect(classifyInstallSource(root, {})).toBe('npm-global');
  });

  it('npm-local: the SAME shape plus a sibling manifest (D-4)', () => {
    // The entire global/local criterion, and the reason it is not npm-prefix
    // arithmetic: a project manifest pins our version, so upgrading behind its
    // back is the one thing a package manager exists to prevent.
    const root = tree(['project', 'node_modules', '@aragon-agent', 'cli'], {
      siblingManifest: true,
    });
    expect(classifyInstallSource(root, {})).toBe('npm-local');
  });

  it('dev-monorepo: packages/cli under a root with a workspaces array', () => {
    const base = join(ROOT, `mono-${(counter += 1)}`);
    const dir = join(base, 'packages', 'cli');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    writeFileSync(join(base, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    expect(classifyInstallSource(dir, {})).toBe('dev-monorepo');
  });

  it('dev-monorepo does NOT match packages/cli without a workspaces array', () => {
    // Otherwise any project that happens to use that directory layout would be
    // silently exempted from updates.
    const base = join(ROOT, `nonmono-${(counter += 1)}`);
    const dir = join(base, 'packages', 'cli');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    writeFileSync(join(base, 'package.json'), JSON.stringify({ name: 'not-a-workspace' }));
    expect(classifyInstallSource(dir, {})).not.toBe('dev-monorepo');
  });

  it('npx, pnpm, yarn, bun and volta each match their own segment', () => {
    expect(classifyInstallSource(tree(['_npx', 'abc123', 'node_modules', 'cli']), {})).toBe('npx');
    expect(
      classifyInstallSource(tree(['.pnpm', 'store', 'node_modules', 'cli']), {}),
    ).toBe('pnpm');
    expect(classifyInstallSource(tree(['.yarn', 'global', 'node_modules', 'cli']), {})).toBe(
      'yarn',
    );
    expect(classifyInstallSource(tree(['opt', 'yarn', 'global', 'node_modules', 'cli']), {})).toBe(
      'yarn',
    );
    expect(classifyInstallSource(tree(['.bun', 'install', 'global', 'cli']), {})).toBe('bun');
    expect(classifyInstallSource(tree(['.volta', 'tools', 'image', 'packages', 'cli']), {})).toBe(
      'volta',
    );
  });

  it('volta also matches through VOLTA_HOME', () => {
    const base = join(ROOT, `volta-${(counter += 1)}`);
    const dir = join(base, 'tools', 'image', 'x');
    mkdirSync(dir, { recursive: true });
    expect(classifyInstallSource(dir, { VOLTA_HOME: base })).toBe('volta');
  });

  it('unknown: no ancestor node_modules at all', () => {
    const base = join(ROOT, `bare-${(counter += 1)}`);
    mkdirSync(base, { recursive: true });
    expect(classifyInstallSource(base, {})).toBe('unknown');
  });
});

describe('what each classification is allowed to do (D-5 / D-6)', () => {
  it('auto-installs for npm-global and NOTHING else', () => {
    // The only classification whose install target is unambiguous and verifiable
    // from this machine.
    expect(isAutoInstallable('npm-global')).toBe(true);
    for (const source of [
      'dev-monorepo',
      'npx',
      'pnpm',
      'yarn',
      'bun',
      'volta',
      'npm-local',
      'unknown',
    ] as const) {
      expect(isAutoInstallable(source), source).toBe(false);
    }
  });

  it('stays SILENT for dev-monorepo and npx (AC-6 / AC-7)', () => {
    // A developer's clone is not out of date, it is checked out; and `npx`
    // resolved `latest` seconds ago. A notice on either is noise attached to a
    // fact the user cannot act on.
    expect(isReportableSource('dev-monorepo')).toBe(false);
    expect(isReportableSource('npx')).toBe(false);
    expect(isReportableSource('pnpm')).toBe(true);
    expect(isReportableSource('npm-global')).toBe(true);
  });

  it('stays silent for npm-local too, and that is the third one (§3.2 / D-4)', () => {
    // The one a reader drops, because it is not in AC-6/AC-7's pair. `adviceFor`
    // already refuses to invent a command for it (the case below), so reporting
    // it would put `0.6.0 available` on the row with NOTHING after it, once per
    // session, in every project that depends on this package. A project manifest
    // pins our version; that is not a decision to nag about from inside a
    // session. The §3.2 table and `manual-test.md` row 10 both read "silent".
    expect(isReportableSource('npm-local')).toBe(false);
  });

  it('gives every other manager ITS OWN command, never npm (AC-8)', () => {
    const name = '@aragon-agent/cli';
    expect(adviceFor('pnpm', name)).toBe('pnpm add -g @aragon-agent/cli');
    expect(adviceFor('yarn', name)).toBe('yarn global add @aragon-agent/cli');
    expect(adviceFor('bun', name)).toBe('bun add -g @aragon-agent/cli');
    expect(adviceFor('volta', name)).toBe('volta install @aragon-agent/cli');
    expect(adviceFor('npm-global', name)).toBe('npm i -g @aragon-agent/cli');
    expect(adviceFor('unknown', name)).toBe('npm i -g @aragon-agent/cli');
    // A project manifest pins us: there is no command we could honestly suggest.
    expect(adviceFor('npm-local', name)).toBeUndefined();
    expect(adviceFor('dev-monorepo', name)).toBeUndefined();
  });
});

describe('readSelfManifest — U-1 guards the level count', () => {
  it('requires BOTH a name and a version', () => {
    // An off-by-one ascent yields a directory whose `package.json` may still
    // parse (the monorepo root's does), so the updater would silently check a
    // package that is not us. Requiring both fields is what makes that fail
    // loudly instead.
    const dir = join(ROOT, `manifest-${(counter += 1)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    expect(readSelfManifest(dir)).toBeNull();

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(readSelfManifest(dir)).toBeNull();

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    expect(readSelfManifest(dir)).toEqual({ name: 'x', version: '1.0.0' });
  });

  it('never throws on a missing or corrupt manifest', () => {
    expect(readSelfManifest(join(ROOT, 'does-not-exist'))).toBeNull();
    expect(readSelfManifest(null)).toBeNull();
  });

  it('AC-3: the running tree really is @aragon-agent/cli', () => {
    // The one assertion that catches an off-by-one in `selfPackageRoot`'s two
    // level ascent, and the reason the package name is read from the manifest
    // rather than hardcoded into the registry URL.
    const root = selfPackageRoot();
    expect(root).not.toBeNull();
    expect(readSelfManifest(root)?.name).toBe('@aragon-agent/cli');
  });
});

describe('probeWritable', () => {
  it('is true for a directory we just created', () => {
    const dir = join(ROOT, `writable-${(counter += 1)}`, 'pkg');
    mkdirSync(dir, { recursive: true });
    expect(probeWritable(dir)).toBe(true);
  });

  it('is false when the parent does not exist', () => {
    // The EACCES-on-Linux case reaches the same branch: probing BEFORE spawning
    // npm turns a confusing failure deep in npm's output into a one-line notice.
    expect(probeWritable(join(ROOT, 'no-such-parent', 'pkg'))).toBe(false);
  });
});
