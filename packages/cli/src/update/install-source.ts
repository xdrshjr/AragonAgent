/**
 * The eligibility ladder (cli-auto-update section 3.2).
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope (C-2 / C-3).
 *
 * THE DANGEROUS VERSION OF THIS FEATURE RUNS `npm i -g` ON A MACHINE WHERE
 * `aragon` CAME FROM SOMEWHERE ELSE. From `npx`, from a pnpm store, from a
 * project's `node_modules`, from volta, or from a clone of this monorepo - in
 * every one of those the global install either does not exist, is not what is
 * running, or is actively wrong to touch. This module classifies the running
 * installation from its own real path and reports which of those it is; the
 * service auto-installs for exactly one classification and degrades everything
 * else to a one-line notice carrying the correct command for THAT manager.
 */

import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { InstallSource } from './types.js';

/** The package this CLI publishes as. Read from the manifest, never hardcoded
 *  into the registry URL, so a fork keeps working (U-1). */
export interface SelfManifest {
  name: string;
  version: string;
}

/**
 * The package root, resolved from THIS MODULE's own URL.
 *
 * INVARIANT U-1 - THE LEVEL COUNT IS LOAD-BEARING AND THE FAILURE IS SILENT.
 *
 * The count is only correct because this package is compiled by plain `tsc` with
 * `rootDir: ./src` and NO BUNDLER (C-16), so `src/update/install-source.ts`
 * really does land at `dist/update/install-source.js`. If a bundler is ever
 * introduced, `import.meta.url` collapses to `dist/cli.js` and this ascent
 * becomes off-by-one - so that build property is a dependency of this module,
 * not a background detail. `cli.tsx::readVersion()` goes up ONE level because it
 * lives at `dist/cli.js`; this module lives two deep and goes up TWO.
 *
 * An off-by-one yields a directory whose `package.json` may still parse (the
 * monorepo root's does), so the updater would silently check a package that is
 * not us. `readSelfManifest()` therefore refuses a manifest without both a
 * `name` and a `version`, and AC-3 asserts the name it reads.
 *
 * `realpathSync` is MANDATORY: nvm, volta and `npm link` all put symlinks on
 * this path, and every rung of the ladder below is path-shaped.
 */
export function selfPackageRoot(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return realpathSync(resolve(here, '..', '..'));
  } catch {
    return null;
  }
}

/**
 * `<root>/package.json`, or `null` when it is absent, unparseable, or missing
 * either of the two fields that make it OURS rather than some ancestor's.
 */
export function readSelfManifest(root: string | null = selfPackageRoot()): SelfManifest | null {
  if (!root) return null;
  try {
    const parsed = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof parsed?.name !== 'string' || parsed.name.length === 0) return null;
    if (typeof parsed?.version !== 'string' || parsed.version.length === 0) return null;
    return { name: parsed.name, version: parsed.version };
  } catch {
    return null;
  }
}

function segments(path: string): string[] {
  return path.split(/[\\/]/).filter((s) => s.length > 0);
}

/** The nearest ancestor directory named `node_modules`, or `null`. */
function nearestNodeModules(root: string): string | null {
  let current = root;
  for (;;) {
    if (basename(current) === 'node_modules') return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isMonorepoCheckout(root: string): boolean {
  if (basename(root) !== 'cli') return false;
  if (basename(dirname(root)) !== 'packages') return false;
  try {
    const parsed = JSON.parse(
      readFileSync(resolve(root, '..', '..', 'package.json'), 'utf-8'),
    ) as { workspaces?: unknown };
    return Array.isArray(parsed?.workspaces);
  } catch {
    return false;
  }
}

/**
 * Classify the running installation. FIRST MATCH WINS, and the order is the
 * table in section 3.2 read top to bottom.
 *
 * D-4 - THE GLOBAL/LOCAL CRITERION IS "DOES A MANIFEST PIN US", NOT "IS THIS THE
 * NPM PREFIX". The obvious implementation derives the global prefix from
 * `process.execPath`. That is wrong on Windows, where the bundled npm's default
 * prefix is `%APPDATA%\npm` and has nothing to do with `C:\Program Files\nodejs`.
 * It is also semantically weaker than what we actually need to know: auto-update
 * is legitimate exactly when NO PROJECT MANIFEST PINS OUR VERSION. A
 * `node_modules` with a sibling `package.json` is a project; one without is a
 * global root (`%APPDATA%\npm\node_modules`, `/usr/local/lib/node_modules`,
 * `~/.nvm/versions/node/vX/lib/node_modules` - none of them has a sibling
 * manifest). The rule needs no subprocess, no prefix arithmetic and no platform
 * branch.
 */
export function classifyInstallSource(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): InstallSource {
  const parts = segments(root);

  if (isMonorepoCheckout(root)) return 'dev-monorepo';
  // `npx` already resolves `latest` on every run, so there is nothing here that
  // could be out of date tomorrow.
  if (parts.includes('_npx')) return 'npx';
  if (parts.includes('.pnpm') || existsSync(resolve(root, '..', '..', '.pnpm'))) return 'pnpm';
  // `.yarn` (berry) or the classic `yarn/global` PAIR - adjacency matters, or a
  // `/opt/yarn/lib/node_modules` install plus an unrelated `global` segment
  // somewhere else on the path would misclassify.
  if (parts.includes('.yarn')) return 'yarn';
  if (parts.some((part, i) => part === 'yarn' && parts[i + 1] === 'global')) return 'yarn';
  if (parts.includes('.bun')) return 'bun';
  if (parts.includes('.volta')) return 'volta';
  const voltaHome = env.VOLTA_HOME?.trim();
  if (voltaHome && voltaHome.length > 0) {
    const prefix = realpathQuiet(voltaHome);
    if (prefix && (root === prefix || root.startsWith(prefix + sep))) return 'volta';
  }

  const nm = nearestNodeModules(root);
  if (!nm) return 'unknown';
  // THE WHOLE OF D-4, in one line: a sibling manifest means a project pins our
  // version and an auto-upgrade would fight it.
  return existsSync(resolve(dirname(nm), 'package.json')) ? 'npm-local' : 'npm-global';
}

function realpathQuiet(path: string): string | null {
  try {
    return realpathSync(resolve(path));
  } catch {
    return null;
  }
}

/**
 * Can we actually write the directory the install would replace?
 *
 * A path can look global and still be unwritable - the ordinary Linux case,
 * where the global root belongs to root and the user has no sudo (R-2). Probing
 * BEFORE spawning npm turns a confusing EACCES deep in npm's output into an
 * actionable one-line notice.
 */
export function probeWritable(root: string): boolean {
  try {
    accessSync(dirname(root), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether this classification may be auto-installed at all (D-5). */
export function isAutoInstallable(source: InstallSource): boolean {
  return source === 'npm-global';
}

/**
 * Whether a classification is worth telling the user about when it is NOT
 * auto-installable.
 *
 * THREE ARE SILENT, and the third is the one a reader is most likely to drop.
 * `dev-monorepo` and `npx` are the obvious pair (AC-6 / AC-7): a developer's
 * clone is not out of date, it is checked out; and an `npx` invocation already
 * resolved `latest` seconds ago. `npm-local` belongs with them for the reason
 * D-4 exists at all - a project manifest PINS our version, so upgrading is not
 * the user's decision to make from inside this session, and `adviceFor` returns
 * `undefined` for it because there is no command we could honestly suggest.
 *
 * WITHOUT `npm-local` HERE THE ROW RENDERS `0.6.0 available` WITH NO COMMAND
 * AFTER IT, once per session, forever, on every project that depends on this
 * package - a persistent notice carrying no action, which is precisely the
 * notification fatigue D-7 and R-8 spend the rest of this feature avoiding.
 * The section 3.2 table and `manual-test.md` row 10 both say "silent".
 */
export function isReportableSource(source: InstallSource): boolean {
  return source !== 'dev-monorepo' && source !== 'npx' && source !== 'npm-local';
}

/** The copy-pasteable command for a source we will not install ourselves. */
export function adviceFor(source: InstallSource, packageName: string): string | undefined {
  switch (source) {
    case 'pnpm':
      return `pnpm add -g ${packageName}`;
    case 'yarn':
      return `yarn global add ${packageName}`;
    case 'bun':
      return `bun add -g ${packageName}`;
    case 'volta':
      return `volta install ${packageName}`;
    case 'npm-global':
    case 'unknown':
      return `npm i -g ${packageName}`;
    // A project manifest pins us; upgrading behind its back is the one thing a
    // package manager exists to prevent (D-4).
    case 'npm-local':
    case 'dev-monorepo':
    case 'npx':
    default:
      return undefined;
  }
}
