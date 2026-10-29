import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Test support: locate a package that npm INSTALLED, the way Node resolves a bare specifier.
 *
 * This repository ships the TUI and the desktop shell only. `@aragon-agent/core` is a
 * published dependency and `@aragon-agent/cli` is not here at all, so a test that wants to
 * look inside another package cannot reach for `../../core/src/...` any more: that path
 * exists only in the private monorepo. Walking the `node_modules` chain upward finds the
 * copy npm actually installed, which works both for a hoisted workspace install at the
 * repository root and for a plain `npm install` run inside this package - and it fails
 * loudly (returns `undefined`, asserted by the caller) instead of silently reading a tree
 * that happens to sit next to it.
 */
export function findInstalledPackage(
  name: string,
  startDirectory: string,
  subpath = '',
): string | undefined {
  // A scoped name is two path segments; `join` normalises the rest.
  const segments = name.startsWith('@') ? name.split('/') : [name];
  let directory = startDirectory;
  for (;;) {
    const candidate = join(directory, 'node_modules', ...segments, subpath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
