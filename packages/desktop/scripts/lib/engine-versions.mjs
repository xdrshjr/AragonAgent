// The engine packages the desktop installs, and the version arithmetic shared by `stage.mjs` (which
// writes the staged engine) and `verify-bundle.mjs` (which reads it back).
//
// The desktop does not contain the engine: `@aragon-agent/{core,tui,cli}` are published npm
// packages, so their versions live in this package's `dependencies` as registry ranges. These
// helpers keep "declared range" and "what npm actually installed" comparable without pulling in a
// semver library.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ENGINE = Object.freeze(['core', 'tui', 'cli']);

/** `^1.2.3` / `~1.2.3` / `1.2.3` / `>=1.2.3` -> `[major, minor, patch]`, or null when unparsable. */
export function parseVersion(value) {
  const match = /^(?:[\^~]|>=)?\s*(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

/**
 * True when `version` is at least the floor of `range` and inside its upper bound; false when it is
 * outside; null when either side cannot be parsed (the caller decides what that means).
 */
export function satisfies(version, range) {
  const wanted = parseVersion(range);
  const actual = parseVersion(version);
  if (!wanted || !actual) return null;
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (compare(actual, wanted) < 0) return false;
  const operator = String(range).trim()[0];
  if (operator === '^' && wanted[0] > 0) return actual[0] === wanted[0];
  if (operator === '^') return actual[0] === 0 && actual[1] === wanted[1];
  if (operator === '~') return actual[0] === wanted[0] && actual[1] === wanted[1];
  return true;
}

/** A range the staging step may hand to `npm install`: a registry range, never a local protocol. */
export function isRegistryRange(range) {
  const trimmed = String(range ?? '').trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'latest') return false;
  if (/^(workspace|file|link|portal):/.test(trimmed)) return false;
  return parseVersion(trimmed) !== null;
}

/**
 * The declared engine ranges from the desktop's package.json.
 * Throws with the offending entry named when one of them is not a registry range.
 */
export function readDeclaredEngineRanges(desktopRoot) {
  const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'));
  const dependencies = manifest.dependencies ?? {};
  const declared = {};
  for (const name of ENGINE) {
    const range = dependencies[`@aragon-agent/${name}`];
    if (!isRegistryRange(range)) {
      throw new Error(`package.json must declare @aragon-agent/${name} as a registry range (got ${JSON.stringify(range)})`);
    }
    declared[name] = range;
  }
  return declared;
}
